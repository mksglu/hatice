import { PromptBuilder, issueToTemplateData } from './prompt-builder.js';
import { AgentError } from './errors.js';
import { TurnTimeout } from './turn-timeout.js';
import { InputHandler } from './input-handler.js';
import type { SessionLogger } from './session-logger.js';
import type { RateLimitTracker } from './rate-limiter.js';
import type {
  Issue, WorkerResult, TokenUsage, ClaudeConfig, TrackerConfig,
} from './types.js';
import { emptyTokenUsage } from './types.js';

export interface AgentRunnerOptions {
  issue: Issue;
  workspacePath: string;
  promptTemplate: string;
  attempt: number;
  maxTurns: number;
  claudeConfig: ClaudeConfig;
  trackerConfig: TrackerConfig;
  abortController: AbortController;
  onEvent?: (issueId: string, eventName: string, detail: string) => void;
  onTokenUsage?: (issueId: string, usage: TokenUsage) => void;
  onSessionId?: (issueId: string, sessionId: string) => void;
  sessionLogger?: SessionLogger;
  rateLimiter?: RateLimitTracker;
}

export class AgentRunner {
  private options: AgentRunnerOptions;
  private promptBuilder: PromptBuilder;
  private sessionId: string | null = null;
  private sessionLog: { info: Function; error: Function } | null = null;
  private inputHandler: InputHandler | null = null;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.promptBuilder = new PromptBuilder();

    if (options.claudeConfig.autoRespondToInput) {
      this.inputHandler = new InputHandler(true);
    }
  }

  async run(): Promise<WorkerResult> {
    const startTime = Date.now();
    const { issue, maxTurns, abortController } = this.options;
    let turnsCompleted = 0;
    let totalUsage = emptyTokenUsage();

    // Integration: Session Logger — create session log at start
    if (this.options.sessionLogger) {
      this.sessionLog = this.options.sessionLogger.createSessionLog(issue.id, issue.identifier);
    }

    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        if (abortController.signal.aborted) {
          return { kind: 'cancelled', issueId: issue.id, reason: 'Aborted by controller' };
        }

        // Integration: Rate Limiter — check before each turn
        if (this.options.rateLimiter) {
          if (this.options.rateLimiter.isLimited('claude-api')) {
            const info = this.options.rateLimiter.getInfo('claude-api');
            const waitMs = info.retryAfterMs ?? 5000;
            this.sessionLog?.info({ waitMs }, 'Rate limited, waiting before next turn');
            await delay(waitMs, abortController.signal);
          }
        }

        const prompt = await this.buildPrompt(turn, maxTurns);

        // Integration: Turn Timeout — wrap executeTurn with timeout
        const { claudeConfig } = this.options;
        const turnResult = await TurnTimeout.withTimeout(
          async (_signal) => this.executeTurn(prompt, turn),
          claudeConfig.turnTimeoutMs,
          abortController.signal,
        );

        turnsCompleted++;

        // Integration: Rate Limiter — record successful request
        if (this.options.rateLimiter) {
          this.options.rateLimiter.recordSuccess('claude-api');
        }

        // Aggregate usage
        if (turnResult.usage) {
          totalUsage = mergeUsage(totalUsage, turnResult.usage);
          this.options.onTokenUsage?.(issue.id, totalUsage);
        }

        if (turnResult.sessionId) {
          this.sessionId = turnResult.sessionId;
          this.options.onSessionId?.(issue.id, turnResult.sessionId);
        }

        // Check if we should continue
        if (turnResult.isComplete || turn === maxTurns) {
          break;
        }

        // Continuation delay
        if (turn < maxTurns) {
          await delay(1000, abortController.signal);
        }
      }

      return {
        kind: 'normal',
        issueId: issue.id,
        turnsCompleted,
        usage: totalUsage,
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.sessionLog?.error({ error: error?.message }, 'Agent run failed');
      if (abortController.signal.aborted) {
        return { kind: 'cancelled', issueId: issue.id, reason: error.message ?? 'Aborted' };
      }
      return {
        kind: 'error',
        issueId: issue.id,
        error: error instanceof Error ? error : new AgentError(String(error)),
        attempt: this.options.attempt,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Integration: Session Logger — always close session log
      if (this.options.sessionLogger) {
        this.options.sessionLogger.closeSessionLog(issue.id);
      }
    }
  }

  private async buildPrompt(turn: number, maxTurns: number): Promise<string> {
    if (turn === 1) {
      const templateData = issueToTemplateData(this.options.issue);
      return this.promptBuilder.render(this.options.promptTemplate, {
        issue: templateData,
        attempt: { number: this.options.attempt, error: null },
      });
    }
    return this.promptBuilder.buildContinuationPrompt(turn, maxTurns);
  }

  private async executeTurn(prompt: string, turn: number): Promise<TurnResult> {
    // Dynamic import to avoid issues with mocking in tests
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');

    const mcpServers = this.buildMcpServers(createSdkMcpServer, tool, z);
    const { claudeConfig, workspacePath, abortController } = this.options;

    const queryOptions: Record<string, unknown> = {
      cwd: workspacePath,
      maxTurns: 1,
      abortController,
      permissionMode: claudeConfig.permissionMode,
      ...(claudeConfig.model && { model: claudeConfig.model }),
      ...(claudeConfig.allowedTools && { allowedTools: claudeConfig.allowedTools }),
      ...(claudeConfig.disallowedTools && { disallowedTools: claudeConfig.disallowedTools }),
      ...(claudeConfig.systemPrompt && { systemPrompt: claudeConfig.systemPrompt }),
      ...(claudeConfig.canUseTool && {
        canUseTool: (toolName: string): boolean | undefined => {
          const map = claudeConfig.canUseTool!;
          return toolName in map ? map[toolName] : undefined;
        },
      }),
      ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
      ...(this.sessionId && turn > 1 && { resume: this.sessionId }),
    };

    const result: TurnResult = {
      isComplete: false,
      usage: null,
      sessionId: null,
    };

    const q = query({ prompt, options: queryOptions as any });

    for await (const msg of q) {
      // Track events
      if ('type' in msg) {
        this.options.onEvent?.(this.options.issue.id, msg.type, JSON.stringify(msg).slice(0, 200));

        // Integration: Session Logger — log agent events
        this.sessionLog?.info({ type: msg.type, turn }, 'Agent event');
      }

      // Capture session ID from init
      if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init' && 'session_id' in msg) {
        result.sessionId = msg.session_id as string;
      }

      // Integration: Input Handler — auto-respond to input requests
      if ((msg as any).type === 'input_request' && this.inputHandler?.shouldAutoRespond()) {
        const requestId = (msg as any).request_id;
        const response = this.inputHandler.getAutoResponse();
        if (requestId && typeof (q as any).respondToInputRequest === 'function') {
          (q as any).respondToInputRequest(requestId, response);
        }
      }

      // Integration: Rate Limiter — detect rate limit events
      if (this.options.rateLimiter) {
        if ((msg as any).type === 'error' && 'status' in msg && (msg as any).status === 429) {
          const retryAfterMs = (msg as any).retry_after_ms ?? 60_000;
          this.options.rateLimiter.recordLimit('claude-api', retryAfterMs);
          this.sessionLog?.info({ retryAfterMs }, 'Rate limit detected');
        }
      }

      // Capture result
      if (msg.type === 'result') {
        result.isComplete = true;
        if ('usage' in msg && msg.usage) {
          const u = msg.usage as any;
          result.usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
            costUsd: (msg as any).total_cost_usd ?? 0,
          };
        }
      }
    }

    return result;
  }

  private buildMcpServers(
    createSdkMcpServer: any,
    toolFn: any,
    z: any,
  ): Record<string, unknown> {
    const servers: Record<string, unknown> = {};
    const { trackerConfig } = this.options;

    if (trackerConfig.kind === 'linear') {
      servers.linear = createSdkMcpServer({
        name: 'linear',
        version: '1.0.0',
        tools: [
          toolFn(
            'linear_graphql',
            'Execute raw GraphQL queries against the Linear API. The API token is pre-configured.',
            {
              query: z.string().describe('The GraphQL query string'),
              variables: z.record(z.unknown()).optional().describe('Optional query variables'),
            },
            async ({ query: gqlQuery, variables }: { query: string; variables?: Record<string, unknown> }) => {
              const response = await fetch(trackerConfig.endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: trackerConfig.apiKey,
                },
                body: JSON.stringify({ query: gqlQuery, variables }),
              });
              const data = await response.json();
              return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
            },
          ),
        ],
      });
    } else if (trackerConfig.kind === 'github') {
      servers.github = createSdkMcpServer({
        name: 'github',
        version: '1.0.0',
        tools: [
          toolFn(
            'github_graphql',
            'Execute raw GraphQL queries against the GitHub API. The API token is pre-configured.',
            {
              query: z.string().describe('The GraphQL query string'),
              variables: z.record(z.unknown()).optional().describe('Optional query variables'),
            },
            async ({ query: gqlQuery, variables }: { query: string; variables?: Record<string, unknown> }) => {
              const response = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${trackerConfig.apiKey}`,
                },
                body: JSON.stringify({ query: gqlQuery, variables }),
              });
              const data = await response.json();
              return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
            },
          ),
        ],
      });
    }

    return servers;
  }
}

interface TurnResult {
  isComplete: boolean;
  usage: TokenUsage | null;
  sessionId: string | null;
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

export { mergeUsage, delay };
