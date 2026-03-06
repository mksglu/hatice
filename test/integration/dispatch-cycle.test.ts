import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MemoryTracker } from '../../src/tracker.js';
import type { haticeConfig, Issue, WorkerResult, Workflow } from '../../src/types.js';
import type { WorkflowStore } from '../../src/workflow-store.js';
import { AgentRunner } from '../../src/agent-runner.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/agent-runner.js', () => ({
  AgentRunner: vi.fn(),
}));

vi.mock('../../src/workspace.js', () => ({
  Workspace: vi.fn().mockImplementation(() => ({
    ensureWorkspace: vi.fn().mockResolvedValue('/tmp/test-workspace'),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
  })),
}));

const MockedAgentRunner = vi.mocked(AgentRunner);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(overrides: Partial<haticeConfig> = {}): haticeConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'test-key',
      projectSlug: 'TEST',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Cancelled'],
      assignee: null,
    },
    polling: { intervalMs: 30_000 },
    workspace: { rootDir: '/tmp/hatice-test' },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    claude: {
      model: null,
      permissionMode: 'bypassPermissions',
      turnTimeoutMs: 3_600_000,
      stallTimeoutMs: 300_000,
      allowedTools: null,
      disallowedTools: null,
      systemPrompt: null,
    },
    server: { port: null, host: '127.0.0.1' },
    ...overrides,
  };
}

function createMockWorkflowStore(config: haticeConfig): WorkflowStore {
  const workflow: Workflow = { config, promptTemplate: 'Fix: {{ issue.title }}' };
  const store = {
    load: vi.fn().mockReturnValue(workflow),
    getCurrentWorkflow: vi.fn().mockReturnValue(workflow),
    hasChanged: vi.fn().mockReturnValue(false),
  };
  return store as unknown as WorkflowStore;
}

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    identifier: `TEST-${id}`,
    title: `Test issue ${id}`,
    description: null,
    state: 'Todo',
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedToWorker: true,
    url: null,
    branchName: null,
    assigneeId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch-cycle integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Full dispatch cycle
  // -----------------------------------------------------------------------
  it('polls, dispatches, and handles worker exit in a single tick', async () => {
    // Use a deferred promise so we control when the agent finishes
    let resolveRun!: (result: WorkerResult) => void;
    const runPromise = new Promise<WorkerResult>((r) => { resolveRun = r; });

    MockedAgentRunner.mockImplementation(() => ({
      run: vi.fn().mockReturnValue(runPromise),
    }) as any);

    const config = createTestConfig();
    const tracker = new MemoryTracker([makeIssue('issue-1')]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    const dispatched: string[] = [];
    const completed: string[] = [];
    orchestrator.on('issue:dispatched', (id) => dispatched.push(id));
    orchestrator.on('issue:completed', (id) => completed.push(id));

    // Execute a single tick
    await orchestrator.onTick();

    // Issue should have been dispatched
    expect(dispatched).toContain('issue-1');

    // State: issue should be running (claimed + running entry exists)
    const state = orchestrator.getState();
    expect(state.isClaimed('issue-1')).toBe(true);
    expect(state.isRunning('issue-1')).toBe(true);

    // Now resolve the agent run
    resolveRun({
      kind: 'normal',
      issueId: 'issue-1',
      turnsCompleted: 5,
      usage: {
        inputTokens: 100, outputTokens: 50, totalTokens: 150,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.01,
      },
      durationMs: 5000,
    });

    // Flush microtasks so .then(handleWorkerExit) runs
    await new Promise((r) => process.nextTick(r));

    // After worker exit handler fires, the issue is removed from running
    // and marked as completed (no retry for normal completion)
    expect(state.isRunning('issue-1')).toBe(false);
    expect(completed).toContain('issue-1');
    expect(state.isCompleted('issue-1')).toBe(true);
    expect(state.isClaimed('issue-1')).toBe(false);
    expect(state.retryAttempts.has('issue-1')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 2. Retry cycle: fail → retry scheduled → retry fires → re-dispatch
  // -----------------------------------------------------------------------
  it('retries a failed issue after backoff delay', async () => {
    let callCount = 0;
    let resolveSecondRun!: (result: WorkerResult) => void;

    MockedAgentRunner.mockImplementation(() => ({
      run: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            kind: 'error',
            issueId: 'issue-1',
            error: new Error('Agent crashed'),
            attempt: 1,
            durationMs: 1000,
          } satisfies WorkerResult);
        }
        // Second call: return a deferred promise
        return new Promise<WorkerResult>((r) => { resolveSecondRun = r; });
      }),
    }) as any);

    const config = createTestConfig();
    const tracker = new MemoryTracker([makeIssue('issue-1')]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    const retried: Array<{ id: string; attempt: number }> = [];
    orchestrator.on('issue:retrying', (id, _ident, attempt) => {
      retried.push({ id, attempt });
    });

    // Tick 1: dispatch → agent errors → handleWorkerExit fires immediately via microtask
    await orchestrator.onTick();

    // The mock resolves immediately, so .then(handleWorkerExit) runs as microtask
    // Flush microtasks
    await new Promise((r) => process.nextTick(r));

    expect(retried.length).toBeGreaterThanOrEqual(1);
    expect(retried[0]!.id).toBe('issue-1');

    const state = orchestrator.getState();
    expect(state.retryAttempts.has('issue-1')).toBe(true);

    // Advance past the retry delay (10_000ms for attempt 1 exponential backoff)
    await vi.advanceTimersByTimeAsync(15_000);

    // The retry handler should have re-dispatched (second AgentRunner created)
    expect(callCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 3. Concurrency limit respected
  // -----------------------------------------------------------------------
  it('dispatches at most maxConcurrentAgents issues per tick', async () => {
    // Make run() return a promise that never resolves (agents stay running)
    MockedAgentRunner.mockImplementation(() => ({
      run: vi.fn().mockReturnValue(new Promise(() => {})),
    }) as any);

    const config = createTestConfig({
      agent: {
        maxConcurrentAgents: 2,
        maxTurns: 20,
        maxRetryBackoffMs: 300_000,
        maxConcurrentAgentsByState: {},
      },
    });

    const issues = [
      makeIssue('issue-1', { createdAt: '2024-01-01T00:00:00Z' }),
      makeIssue('issue-2', { createdAt: '2024-01-02T00:00:00Z' }),
      makeIssue('issue-3', { createdAt: '2024-01-03T00:00:00Z' }),
      makeIssue('issue-4', { createdAt: '2024-01-04T00:00:00Z' }),
    ];
    const tracker = new MemoryTracker(issues);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    const dispatched: string[] = [];
    orchestrator.on('issue:dispatched', (id) => dispatched.push(id));

    await orchestrator.onTick();

    // Only 2 should be dispatched (maxConcurrentAgents = 2)
    expect(dispatched).toHaveLength(2);
    expect(dispatched).toContain('issue-1');
    expect(dispatched).toContain('issue-2');

    // State should show 2 running
    const state = orchestrator.getState();
    expect(state.running.size).toBe(2);
  });
});
