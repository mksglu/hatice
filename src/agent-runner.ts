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
      if (abortController.signal.aborted) {
        return { kind: 'cancelled', issueId: issue.id, reason: 'Aborted by controller' };
      }

      // Integration: Rate Limiter — check before execution
      if (this.options.rateLimiter) {
        if (this.options.rateLimiter.isLimited('claude-api')) {
          const info = this.options.rateLimiter.getInfo('claude-api');
          const waitMs = info.retryAfterMs ?? 5000;
          this.sessionLog?.info({ waitMs }, 'Rate limited, waiting before execution');
          await delay(waitMs, abortController.signal);
        }
      }

      const prompt = await this.buildPrompt(1, maxTurns);

      // SDK handles all turns internally via maxTurns
      const { claudeConfig } = this.options;
      const turnResult = await TurnTimeout.withTimeout(
        async (_signal) => this.executeTurn(prompt, 1),
        claudeConfig.turnTimeoutMs,
        abortController.signal,
      );

      turnsCompleted = 1;

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
    // Dry-run mode: simulate agent execution without spawning Claude
    if (this.options.claudeConfig.dryRun) {
      return this.simulateTurn(prompt, turn);
    }

    let sdkModule: any;
    let zod: any;

    try {
      // Dynamic import to avoid issues with mocking in tests
      sdkModule = await import('@anthropic-ai/claude-agent-sdk');
      zod = await import('zod');
    } catch (importErr: any) {
      throw new AgentError(`Failed to import Claude Agent SDK: ${importErr.message}`);
    }

    const { query, createSdkMcpServer, tool } = sdkModule;
    const { z } = zod;

    const mcpServers = this.buildMcpServers(createSdkMcpServer, tool, z);
    const { claudeConfig, workspacePath, abortController } = this.options;

    // Strip CLAUDECODE env var to allow spawning Claude from within a Claude session
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    const queryOptions: Record<string, unknown> = {
      cwd: workspacePath,
      ...(this.options.maxTurns > 0 && { maxTurns: this.options.maxTurns }),
      abortController,
      permissionMode: claudeConfig.permissionMode,
      ...(claudeConfig.permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
      env: cleanEnv,
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

    let q: any;
    try {
      q = query({ prompt, options: queryOptions as any });
    } catch (spawnErr: any) {
      throw new AgentError(`Failed to start Claude agent query: ${spawnErr.message}`);
    }

    try {
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
          this.sessionLog?.info({
            stopReason: (msg as any).stop_reason,
            numTurns: (msg as any).num_turns,
          }, 'Agent result');
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
    } catch (streamErr: any) {
      throw new AgentError(`Agent stream error: ${streamErr.message}`);
    }

    return result;
  }

  /** Simulate a turn for demo/dry-run mode without spawning real agents */
  private async simulateTurn(_prompt: string, turn: number): Promise<TurnResult> {
    // Simulate processing time (1-3 seconds)
    const simulatedDelayMs = 1000 + Math.random() * 2000;
    await delay(simulatedDelayMs, this.options.abortController.signal);

    this.options.onEvent?.(this.options.issue.id, 'system', JSON.stringify({ type: 'system', subtype: 'init', dry_run: true }));
    this.sessionLog?.info({ turn, dryRun: true }, 'Simulated agent turn');

    const simulatedTokens = Math.floor(500 + Math.random() * 2000);
    return {
      isComplete: turn >= this.options.maxTurns || Math.random() > 0.5,
      usage: {
        inputTokens: simulatedTokens,
        outputTokens: Math.floor(simulatedTokens * 0.3),
        totalTokens: Math.floor(simulatedTokens * 1.3),
        cacheReadInputTokens: Math.floor(simulatedTokens * 0.1),
        cacheCreationInputTokens: Math.floor(simulatedTokens * 0.05),
        costUsd: simulatedTokens * 0.000003,
      },
      sessionId: this.sessionId ?? `dry-run-${Date.now()}`,
    };
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
