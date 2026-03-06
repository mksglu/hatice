import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Issue, ClaudeConfig, TrackerConfig, TokenUsage } from '../src/types.js';
import type { AgentRunnerOptions } from '../src/agent-runner.js';
import type { SessionLogger } from '../src/session-logger.js';
import type { RateLimitTracker } from '../src/rate-limiter.js';
import type { InputHandler } from '../src/input-handler.js';

// ── Mock the Claude Agent SDK ────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockCreateSdkMcpServer = vi.fn((_opts: any) => ({ name: _opts.name }));
const mockTool = vi.fn((name: string, desc: string, schema: any, handler: any) => ({
  name, description: desc, schema, handler,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockQuery(...args),
  createSdkMcpServer: (...args: any[]) => mockCreateSdkMcpServer(...args),
  tool: (...args: any[]) => mockTool(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'MT-42',
    title: 'Fix the login bug',
    description: 'Users cannot log in when password contains special characters.',
    state: 'Todo',
    priority: 2,
    labels: ['bug', 'auth'],
    blockedBy: [],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-02T00:00:00Z',
    assignedToWorker: false,
    url: 'https://linear.app/team/MT-42',
    branchName: 'fix/mt-42-login-bug',
    assigneeId: 'user-1',
    ...overrides,
  };
}

function makeClaudeConfig(overrides: Partial<ClaudeConfig> = {}): ClaudeConfig {
  return {
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    turnTimeoutMs: 60_000,
    stallTimeoutMs: 30_000,
    allowedTools: null,
    disallowedTools: null,
    systemPrompt: null,
    canUseTool: null,
    claudeCodePath: null,
    autoRespondToInput: false,
    ...overrides,
  };
}

function makeTrackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'lin_api_test',
    projectSlug: 'TEST',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
    assignee: null,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<AgentRunnerOptions> = {}): AgentRunnerOptions {
  return {
    issue: makeIssue(),
    workspacePath: '/tmp/workspace',
    promptTemplate: 'Fix issue {{ issue.identifier }}: {{ issue.title }}',
    attempt: 1,
    maxTurns: 3,
    claudeConfig: makeClaudeConfig(),
    trackerConfig: makeTrackerConfig(),
    abortController: new AbortController(),
    ...overrides,
  };
}

/** Create an async generator from an array of messages. */
async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function makeSuccessMessages() {
  return [
    { type: 'system', subtype: 'init', session_id: 'test-session-123' },
    {
      type: 'result',
      subtype: 'success',
      result: 'Done',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      total_cost_usd: 0.01,
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('run: returns normal result on successful completion', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.issueId).toBe('issue-1');
      expect(result.turnsCompleted).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
    }
  });

  it('run: uses rendered prompt template for turn 1', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    await runner.run();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toBe('Fix issue MT-42: Fix the login bug');
  });

  it('run: uses continuation prompt for turn 2+', async () => {
    // First turn: not complete (no result message, just init)
    const turn1Messages = [
      { type: 'system', subtype: 'init', session_id: 'test-session-123' },
    ];
    // Second turn: complete
    const turn2Messages = makeSuccessMessages();

    mockQuery
      .mockReturnValueOnce(asyncGen(turn1Messages))
      .mockReturnValueOnce(asyncGen(turn2Messages));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ maxTurns: 3 }));
    await runner.run();

    expect(mockQuery).toHaveBeenCalledTimes(2);

    // First call should use the rendered template
    const firstCallPrompt = mockQuery.mock.calls[0][0].prompt;
    expect(firstCallPrompt).toBe('Fix issue MT-42: Fix the login bug');

    // Second call should use continuation prompt
    const secondCallPrompt = mockQuery.mock.calls[1][0].prompt;
    expect(secondCallPrompt).toContain('continuation turn 2 of 3');
  });

  it('run: collects token usage from result message', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const onTokenUsage = vi.fn();
    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ onTokenUsage }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        costUsd: 0.01,
      });
    }

    expect(onTokenUsage).toHaveBeenCalledWith('issue-1', expect.objectContaining({
      inputTokens: 100,
      outputTokens: 50,
    }));
  });

  it('run: returns error result on agent failure', async () => {
    mockQuery.mockImplementation(() => {
      throw new Error('SDK connection failed');
    });

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    const result = await runner.run();

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.issueId).toBe('issue-1');
      expect(result.error.message).toBe('SDK connection failed');
      expect(result.attempt).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('run: returns cancelled result when aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ abortController }));
    const result = await runner.run();

    expect(result.kind).toBe('cancelled');
    if (result.kind === 'cancelled') {
      expect(result.issueId).toBe('issue-1');
      expect(result.reason).toBe('Aborted by controller');
    }
  });

  it('run: respects maxTurns limit', async () => {
    // Every turn returns non-complete (no result message)
    const nonCompleteMessages = [
      { type: 'system', subtype: 'init', session_id: 'test-session-123' },
    ];

    mockQuery.mockReturnValue(asyncGen(nonCompleteMessages));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ maxTurns: 1 }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.turnsCompleted).toBe(1);
    }
    // Only 1 call since maxTurns=1
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('run: calls onEvent callback for streaming events', async () => {
    const onEvent = vi.fn();
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ onEvent }));
    await runner.run();

    // Should have been called for each message with a 'type' field
    expect(onEvent).toHaveBeenCalled();

    // First call should be for the 'system' event
    const firstCall = onEvent.mock.calls[0];
    expect(firstCall[0]).toBe('issue-1');
    expect(firstCall[1]).toBe('system');

    // Second call should be for the 'result' event
    const secondCall = onEvent.mock.calls[1];
    expect(secondCall[0]).toBe('issue-1');
    expect(secondCall[1]).toBe('result');
  });

  it('run: creates MCP server with linear_graphql tool when tracker is linear', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      trackerConfig: makeTrackerConfig({ kind: 'linear' }),
    }));
    await runner.run();

    // createSdkMcpServer should have been called for the linear server
    expect(mockCreateSdkMcpServer).toHaveBeenCalledTimes(1);
    const serverOpts = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(serverOpts.name).toBe('linear');
    expect(serverOpts.version).toBe('1.0.0');

    // tool() should have been called with 'linear_graphql'
    expect(mockTool).toHaveBeenCalledTimes(1);
    expect(mockTool.mock.calls[0][0]).toBe('linear_graphql');
  });

  it('run: creates MCP server with github_graphql tool when tracker is github', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      trackerConfig: makeTrackerConfig({
        kind: 'github',
        endpoint: 'https://api.github.com/graphql',
        apiKey: 'ghp_test',
      }),
    }));
    await runner.run();

    // createSdkMcpServer should have been called for the github server
    expect(mockCreateSdkMcpServer).toHaveBeenCalledTimes(1);
    const serverOpts = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(serverOpts.name).toBe('github');
    expect(serverOpts.version).toBe('1.0.0');

    // tool() should have been called with 'github_graphql'
    expect(mockTool).toHaveBeenCalledTimes(1);
    expect(mockTool.mock.calls[0][0]).toBe('github_graphql');
  });

  it('run: passes canUseTool callback when configured', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      claudeConfig: makeClaudeConfig({
        canUseTool: { 'Bash': true, 'Edit': false },
      }),
    }));
    await runner.run();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0][0];
    const canUseToolFn = callArgs.options.canUseTool;

    // Callback should be a function
    expect(typeof canUseToolFn).toBe('function');

    // Allowed tool
    expect(canUseToolFn('Bash')).toBe(true);
    // Denied tool
    expect(canUseToolFn('Edit')).toBe(false);
    // Unknown tool -> undefined (default behavior)
    expect(canUseToolFn('UnknownTool')).toBeUndefined();
  });

  it('run: does not pass canUseTool callback when not configured', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      claudeConfig: makeClaudeConfig({ canUseTool: null }),
    }));
    await runner.run();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options).not.toHaveProperty('canUseTool');
  });

  it('run: does not create MCP servers when tracker is memory (demo mode)', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      trackerConfig: makeTrackerConfig({
        kind: 'memory',
        endpoint: '',
        apiKey: '',
      }),
    }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');

    // No MCP servers should be created for memory tracker
    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
    expect(mockTool).not.toHaveBeenCalled();

    // Verify mcpServers is NOT passed in query options
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options).not.toHaveProperty('mcpServers');
  });

  // ── Integration: Session Logger ──────────────────────────────────────────

  it('run: creates and closes session log when sessionLogger is provided', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const mockSessionLogger = {
      createSessionLog: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      closeSessionLog: vi.fn(),
    } as unknown as SessionLogger;

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ sessionLogger: mockSessionLogger }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    expect(mockSessionLogger.createSessionLog).toHaveBeenCalledWith('issue-1', 'MT-42');
    expect(mockSessionLogger.closeSessionLog).toHaveBeenCalledWith('issue-1');
  });

  it('run: closes session log even on error when sessionLogger is provided', async () => {
    mockQuery.mockImplementation(() => {
      throw new Error('SDK connection failed');
    });

    const mockSessionLogger = {
      createSessionLog: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      closeSessionLog: vi.fn(),
    } as unknown as SessionLogger;

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ sessionLogger: mockSessionLogger }));
    const result = await runner.run();

    expect(result.kind).toBe('error');
    expect(mockSessionLogger.closeSessionLog).toHaveBeenCalledWith('issue-1');
  });

  // ── Integration: Rate Limiter ────────────────────────────────────────────

  it('run: checks rate limiter before each turn and records requests', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const mockRateLimiter = {
      isLimited: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordLimit: vi.fn(),
      getInfo: vi.fn().mockReturnValue({ isLimited: false, retryAfterMs: null, lastLimitedAt: null, limitCount: 0, source: 'claude-api' }),
    } as unknown as RateLimitTracker;

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ rateLimiter: mockRateLimiter }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    expect(mockRateLimiter.isLimited).toHaveBeenCalledWith('claude-api');
    expect(mockRateLimiter.recordSuccess).toHaveBeenCalledWith('claude-api');
  });

  // ── Integration: Input Handler ───────────────────────────────────────────

  it('run: auto-responds to input_request events when autoRespondToInput is enabled', async () => {
    // Simulate an input_request event followed by a result
    const messagesWithInput = [
      { type: 'system', subtype: 'init', session_id: 'test-session-123' },
      { type: 'input_request', request_id: 'req-1' },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        total_cost_usd: 0.01,
      },
    ];

    // Track if respondToInputRequest was called on the query object
    const mockQueryInstance = asyncGen(messagesWithInput) as any;
    mockQueryInstance.respondToInputRequest = vi.fn();
    mockQuery.mockReturnValue(mockQueryInstance);

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      claudeConfig: makeClaudeConfig({ autoRespondToInput: true }),
    }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    expect(mockQueryInstance.respondToInputRequest).toHaveBeenCalledWith(
      'req-1',
      'This is a non-interactive session. Please proceed with your best judgment.',
    );
  });

  // ── Integration: Turn Timeout ────────────────────────────────────────────

  it('run: wraps turn execution with TurnTimeout.withTimeout', async () => {
    mockQuery.mockReturnValue(asyncGen(makeSuccessMessages()));

    const { AgentRunner } = await import('../src/agent-runner.js');
    // Use a generous timeout so the test passes normally
    const runner = new AgentRunner(makeOptions({
      claudeConfig: makeClaudeConfig({ turnTimeoutMs: 120_000 }),
    }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.turnsCompleted).toBe(1);
    }
  });

  it('run: turn timeout produces TimeoutError when exceeded', async () => {
    // Create a query that never resolves
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'test-session-123' };
      // Hang forever
      await new Promise(() => {});
    })());

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      claudeConfig: makeClaudeConfig({ turnTimeoutMs: 50 }),
      maxTurns: 1,
    }));
    const result = await runner.run();

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toContain('timed out');
    }
  });
});
