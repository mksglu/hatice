import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { OrchestratorState } from '../src/orchestrator-state.js';
import { MemoryTracker } from '../src/tracker.js';
import type { Issue, haticeConfig, WorkerResult, Workflow, TokenUsage } from '../src/types.js';
import { emptyTokenUsage } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mock AgentRunner
// ---------------------------------------------------------------------------

let mockRunFn = vi.fn<() => Promise<WorkerResult>>();

vi.mock('../src/agent-runner.js', () => {
  return {
    AgentRunner: vi.fn().mockImplementation(() => ({
      run: (...args: unknown[]) => mockRunFn(...args),
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock Workspace (avoid real filesystem)
// ---------------------------------------------------------------------------

vi.mock('../src/workspace.js', () => {
  return {
    Workspace: vi.fn().mockImplementation(() => ({
      ensureWorkspace: vi.fn().mockResolvedValue('/tmp/test-workspace'),
      removeWorkspace: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock logger (suppress output)
// ---------------------------------------------------------------------------

vi.mock('../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'PROJ-1',
    title: 'Test issue',
    description: null,
    state: 'Todo',
    priority: null,
    labels: [],
    blockedBy: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    assignedToWorker: true,
    url: null,
    branchName: null,
    assigneeId: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<haticeConfig> = {}): haticeConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'test-key',
      projectSlug: 'test-project',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Cancelled'],
      assignee: null,
    },
    polling: { intervalMs: 30_000 },
    workspace: { rootDir: '/tmp/workspaces' },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 3,
      maxTurns: 10,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
      retryOnNormalExit: false,
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

function makeWorkflow(config: haticeConfig): Workflow {
  return {
    config,
    promptTemplate: 'Do the work for {{issue.identifier}}: {{issue.title}}',
  };
}

function makeWorkflowStoreMock(config: haticeConfig) {
  const workflow = makeWorkflow(config);
  return {
    load: vi.fn().mockReturnValue(workflow),
    getCurrentWorkflow: vi.fn().mockReturnValue(workflow),
    hasChanged: vi.fn().mockReturnValue(false),
  } as any;
}

function normalResult(issueId: string): WorkerResult {
  return {
    kind: 'normal',
    issueId,
    turnsCompleted: 3,
    usage: emptyTokenUsage(),
    durationMs: 5000,
  };
}

function errorResult(issueId: string, attempt: number): WorkerResult {
  return {
    kind: 'error',
    issueId,
    error: new Error('Agent crashed'),
    attempt,
    durationMs: 1000,
  };
}

function cancelledResult(issueId: string): WorkerResult {
  return {
    kind: 'cancelled',
    issueId,
    reason: 'Reconciliation abort',
  };
}

function createOrchestrator(
  tracker: MemoryTracker,
  configOverrides: Partial<haticeConfig> = {},
) {
  const config = makeConfig(configOverrides);
  const workflowStore = makeWorkflowStoreMock(config);
  return new Orchestrator({ tracker, workflowStore, config });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunFn = vi.fn<() => Promise<WorkerResult>>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Dispatch Logic
  // -------------------------------------------------------------------------

  describe('Dispatch Logic', () => {
    it('dispatches issue when in active state and slots available', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {})); // never resolves

      await orch.onTick();

      const state = orch.getState();
      expect(state.isRunning('issue-1')).toBe(true);
      expect(state.isClaimed('issue-1')).toBe(true);
    });

    it('does NOT dispatch issue already claimed', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      // Pre-claim the issue
      orch.getState().claim('issue-1');

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      // Should still be claimed but running map should be empty (not dispatched a second time)
      expect(orch.getState().running.size).toBe(0);
    });

    it('does NOT dispatch issue already running', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {}));

      // First tick dispatches
      await orch.onTick();
      expect(orch.getState().running.size).toBe(1);

      // Second tick should NOT add another running entry
      await orch.onTick();
      expect(orch.getState().running.size).toBe(1);
    });

    it('does NOT dispatch issue already completed', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      // Pre-mark as completed
      orch.getState().markCompleted('issue-1');

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      expect(orch.getState().running.size).toBe(0);
    });

    it('does NOT dispatch issue in terminal state', async () => {
      const issue = makeIssue({ state: 'Done' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      expect(orch.getState().running.size).toBe(0);
    });

    it('does NOT dispatch when no available slots (max concurrent reached)', async () => {
      const issues = [
        makeIssue({ id: 'i1', identifier: 'P-1', state: 'Todo' }),
        makeIssue({ id: 'i2', identifier: 'P-2', state: 'Todo' }),
        makeIssue({ id: 'i3', identifier: 'P-3', state: 'Todo' }),
        makeIssue({ id: 'i4', identifier: 'P-4', state: 'Todo' }),
      ];
      const tracker = new MemoryTracker(issues);
      const orch = createOrchestrator(tracker, {
        agent: { maxConcurrentAgents: 3, maxTurns: 10, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {}, retryOnNormalExit: false },
      });

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      // Only 3 should be running (max concurrent = 3)
      expect(orch.getState().running.size).toBe(3);
    });

    it('does NOT dispatch issue with active blocker', async () => {
      const issue = makeIssue({
        state: 'Todo',
        blockedBy: [{ id: 'blocker-1', identifier: 'P-99', state: 'In Progress' }],
      });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      expect(orch.getState().running.size).toBe(0);
    });

    it('dispatches issue when blocker is in terminal state', async () => {
      const issue = makeIssue({
        state: 'Todo',
        blockedBy: [{ id: 'blocker-1', identifier: 'P-99', state: 'Done' }],
      });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      expect(orch.getState().running.size).toBe(1);
    });

    it('respects per-state concurrency limits', async () => {
      const issues = [
        makeIssue({ id: 'i1', identifier: 'P-1', state: 'In Progress' }),
        makeIssue({ id: 'i2', identifier: 'P-2', state: 'In Progress' }),
        makeIssue({ id: 'i3', identifier: 'P-3', state: 'In Progress' }),
      ];
      const tracker = new MemoryTracker(issues);
      const orch = createOrchestrator(tracker, {
        agent: {
          maxConcurrentAgents: 10,
          maxTurns: 10,
          maxRetryBackoffMs: 300_000,
          maxConcurrentAgentsByState: { 'in progress': 1 },
          retryOnNormalExit: false,
        },
      });

      mockRunFn.mockReturnValue(new Promise(() => {}));
      await orch.onTick();

      // Per-state limit of 1 for "In Progress" should cap to 1
      expect(orch.getState().running.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  describe('Sorting', () => {
    it('sorts by priority DESC (1 before 2 before null)', async () => {
      const issues = [
        makeIssue({ id: 'i-null', identifier: 'P-3', priority: null, state: 'Todo' }),
        makeIssue({ id: 'i-2', identifier: 'P-2', priority: 2, state: 'Todo' }),
        makeIssue({ id: 'i-1', identifier: 'P-1', priority: 1, state: 'Todo' }),
      ];
      const tracker = new MemoryTracker(issues);
      const config = makeConfig();
      const workflowStore = makeWorkflowStoreMock(config);
      const orch = new Orchestrator({ tracker, workflowStore, config });

      const chosen = orch.chooseIssues(issues);
      expect(chosen.map(i => i.id)).toEqual(['i-1', 'i-2', 'i-null']);
    });

    it('sorts by createdAt ASC when same priority', async () => {
      const issues = [
        makeIssue({ id: 'i-new', identifier: 'P-2', priority: 1, createdAt: '2026-02-01T00:00:00Z', state: 'Todo' }),
        makeIssue({ id: 'i-old', identifier: 'P-1', priority: 1, createdAt: '2026-01-01T00:00:00Z', state: 'Todo' }),
      ];
      const tracker = new MemoryTracker(issues);
      const config = makeConfig();
      const workflowStore = makeWorkflowStoreMock(config);
      const orch = new Orchestrator({ tracker, workflowStore, config });

      const chosen = orch.chooseIssues(issues);
      expect(chosen.map(i => i.id)).toEqual(['i-old', 'i-new']);
    });

    it('sorts by identifier ASC as tiebreaker', async () => {
      const issues = [
        makeIssue({ id: 'i-b', identifier: 'PROJ-2', priority: 1, createdAt: '2026-01-01T00:00:00Z', state: 'Todo' }),
        makeIssue({ id: 'i-a', identifier: 'PROJ-1', priority: 1, createdAt: '2026-01-01T00:00:00Z', state: 'Todo' }),
      ];
      const tracker = new MemoryTracker(issues);
      const config = makeConfig();
      const workflowStore = makeWorkflowStoreMock(config);
      const orch = new Orchestrator({ tracker, workflowStore, config });

      const chosen = orch.chooseIssues(issues);
      expect(chosen.map(i => i.id)).toEqual(['i-a', 'i-b']);
    });
  });

  // -------------------------------------------------------------------------
  // Worker Exit Handling
  // -------------------------------------------------------------------------

  describe('Worker Exit Handling', () => {
    it('normal exit: marks completed and cleans up without retry', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      // Make run resolve immediately with normal result
      mockRunFn.mockResolvedValue(normalResult('issue-1'));

      await orch.onTick();

      // Wait for the microtask (promise .then handler) to fire
      await vi.advanceTimersByTimeAsync(0);

      const state = orch.getState();
      // After normal exit, issue is completed — no retry scheduled
      expect(state.isRunning('issue-1')).toBe(false);
      expect(state.isCompleted('issue-1')).toBe(true);
      expect(state.isClaimed('issue-1')).toBe(false);
      expect(state.retryAttempts.has('issue-1')).toBe(false);
    });

    it('error exit: schedules retry with exponential backoff', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockResolvedValue(errorResult('issue-1', 1));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      const state = orch.getState();
      expect(state.retryAttempts.has('issue-1')).toBe(true);

      const retry = state.retryAttempts.get('issue-1')!;
      // attempt 1 -> delay = 10000 * 2^(1-1) = 10000
      expect(retry.delayMs).toBe(10_000);
      expect(retry.attempt).toBe(2);
      expect(retry.lastError).toBe('Agent crashed');
    });

    it('cancelled exit: releases claim without retry', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockResolvedValue(cancelledResult('issue-1'));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      const state = orch.getState();
      expect(state.isClaimed('issue-1')).toBe(false);
      expect(state.isRunning('issue-1')).toBe(false);
      expect(state.retryAttempts.has('issue-1')).toBe(false);
    });

    it('marks issue completed immediately on normal exit (no retry needed)', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockResolvedValue(normalResult('issue-1'));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      // Normal exit should mark completed immediately without needing a retry cycle
      const state = orch.getState();
      expect(state.isCompleted('issue-1')).toBe(true);
      expect(state.isClaimed('issue-1')).toBe(false);
      expect(state.retryAttempts.has('issue-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  describe('Reconciliation', () => {
    it('stops running agent when issue becomes terminal', async () => {
      const issue = makeIssue({ state: 'In Progress' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {})); // hangs

      await orch.onTick();
      expect(orch.getState().isRunning('issue-1')).toBe(true);

      // Move issue to terminal state
      tracker.updateIssueState('issue-1', 'Done');

      // Run another tick to trigger reconciliation
      await orch.onTick();

      const state = orch.getState();
      expect(state.isRunning('issue-1')).toBe(false);
      expect(state.isClaimed('issue-1')).toBe(false);
      expect(state.isCompleted('issue-1')).toBe(true);
    });

    it('stops running agent when issue becomes inactive (state not in activeStates)', async () => {
      const issue = makeIssue({ state: 'In Progress' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockReturnValue(new Promise(() => {}));

      await orch.onTick();
      expect(orch.getState().isRunning('issue-1')).toBe(true);

      // Move to a state not in activeStates and not in terminalStates
      tracker.updateIssueState('issue-1', 'Backlog');

      await orch.onTick();

      const state = orch.getState();
      expect(state.isRunning('issue-1')).toBe(false);
      expect(state.isClaimed('issue-1')).toBe(false);
      // Should NOT be marked completed since it's not terminal
      expect(state.isCompleted('issue-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------

  describe('Retry', () => {
    it('re-dispatches issue on retry after error if still active and slots available', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      // First run: resolve with error (errors still schedule retries)
      mockRunFn.mockResolvedValueOnce(errorResult('issue-1', 1));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      // Retry is scheduled after error
      expect(orch.getState().retryAttempts.has('issue-1')).toBe(true);

      // Second run on re-dispatch: hang
      mockRunFn.mockReturnValue(new Promise(() => {}));

      // Fire the retry timer (error backoff: 10_000ms)
      await vi.advanceTimersByTimeAsync(11_000);

      // Issue should be running again
      expect(orch.getState().isRunning('issue-1')).toBe(true);
    });

    it('releases claim on retry if issue is now terminal (after error)', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      // Error result triggers retry
      mockRunFn.mockResolvedValueOnce(errorResult('issue-1', 1));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      // Update issue to terminal before retry fires
      tracker.updateIssueState('issue-1', 'Cancelled');

      // Fire the retry timer (error backoff: 10_000ms)
      await vi.advanceTimersByTimeAsync(11_000);

      const state = orch.getState();
      expect(state.isClaimed('issue-1')).toBe(false);
      expect(state.isCompleted('issue-1')).toBe(true);
      expect(state.isRunning('issue-1')).toBe(false);
    });

    it('normal exit with retryOnNormalExit=true schedules continuation retry', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker, {
        agent: {
          maxConcurrentAgents: 3,
          maxTurns: 10,
          maxRetryBackoffMs: 300_000,
          maxConcurrentAgentsByState: {},
          retryOnNormalExit: true,
        },
      });

      mockRunFn.mockResolvedValue(normalResult('issue-1'));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      const state = orch.getState();
      // Should NOT be marked completed — retry is scheduled instead
      expect(state.isCompleted('issue-1')).toBe(false);
      // Retry should be scheduled with 1000ms delay
      expect(state.retryAttempts.has('issue-1')).toBe(true);
      const retry = state.retryAttempts.get('issue-1')!;
      expect(retry.delayMs).toBe(1000);
    });

    it('normal exit does NOT schedule retry', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      mockRunFn.mockResolvedValue(normalResult('issue-1'));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      const state = orch.getState();
      // Normal completion should NOT schedule a retry
      expect(state.retryAttempts.has('issue-1')).toBe(false);
      expect(state.isCompleted('issue-1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // EventBus Integration
  // -------------------------------------------------------------------------

  describe('EventBus Integration', () => {
    it('exposes an EventBus via getEventBus()', () => {
      const tracker = new MemoryTracker([]);
      const orch = createOrchestrator(tracker);
      const bus = orch.getEventBus();
      expect(bus).toBeDefined();
      expect(typeof bus.on).toBe('function');
      expect(typeof bus.emit).toBe('function');
    });

    it('emits tick:start and tick:end on the EventBus during onTick()', async () => {
      const tracker = new MemoryTracker([]);
      const orch = createOrchestrator(tracker);
      const bus = orch.getEventBus();

      const tickStartSpy = vi.fn();
      const tickEndSpy = vi.fn();
      bus.on('tick:start', tickStartSpy);
      bus.on('tick:end', tickEndSpy);

      await orch.onTick();

      expect(tickStartSpy).toHaveBeenCalledTimes(1);
      expect(tickEndSpy).toHaveBeenCalledTimes(1);
      expect(tickEndSpy).toHaveBeenCalledWith(0); // no issues dispatched
    });

    it('emits issue:dispatched on the EventBus when an issue is dispatched', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);
      const bus = orch.getEventBus();

      const dispatchedSpy = vi.fn();
      bus.on('issue:dispatched', dispatchedSpy);

      mockRunFn.mockReturnValue(new Promise(() => {})); // never resolves

      await orch.onTick();

      expect(dispatchedSpy).toHaveBeenCalledTimes(1);
      expect(dispatchedSpy).toHaveBeenCalledWith('issue-1', 'PROJ-1');
    });

    it('emits issue:completed and issue:failed on the EventBus for worker exits', async () => {
      const issue1 = makeIssue({ id: 'i-ok', identifier: 'P-1', state: 'Todo' });
      const issue2 = makeIssue({ id: 'i-err', identifier: 'P-2', state: 'Todo' });
      const tracker = new MemoryTracker([issue1, issue2]);
      const orch = createOrchestrator(tracker);
      const bus = orch.getEventBus();

      const completedSpy = vi.fn();
      const failedSpy = vi.fn();
      bus.on('issue:completed', completedSpy);
      bus.on('issue:failed', failedSpy);

      // First call (i-ok) resolves normally, second call (i-err) resolves with error
      mockRunFn
        .mockResolvedValueOnce(normalResult('i-ok'))
        .mockResolvedValueOnce(errorResult('i-err', 1));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      expect(completedSpy).toHaveBeenCalledTimes(1);
      expect(completedSpy).toHaveBeenCalledWith('i-ok', 'P-1', expect.any(Object));

      expect(failedSpy).toHaveBeenCalledTimes(1);
      expect(failedSpy).toHaveBeenCalledWith('i-err', 'P-2', expect.any(Error));
    });

    it('emits issue:released on the EventBus when a cancelled agent exits', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);
      const bus = orch.getEventBus();

      const releasedSpy = vi.fn();
      bus.on('issue:released', releasedSpy);

      mockRunFn.mockResolvedValue(cancelledResult('issue-1'));

      await orch.onTick();
      await vi.advanceTimersByTimeAsync(0);

      expect(releasedSpy).toHaveBeenCalledTimes(1);
      expect(releasedSpy).toHaveBeenCalledWith('issue-1', 'PROJ-1', 'Reconciliation abort');
    });
  });

  // -------------------------------------------------------------------------
  // Tick Guard
  // -------------------------------------------------------------------------

  describe('Tick Guard', () => {
    it('prevents concurrent ticks (tickInProgress guard)', async () => {
      const issue = makeIssue({ state: 'Todo' });
      const tracker = new MemoryTracker([issue]);
      const orch = createOrchestrator(tracker);

      // Make fetchCandidateIssues slow
      let resolveSlowFetch: (issues: Issue[]) => void;
      const slowPromise = new Promise<Issue[]>((res) => { resolveSlowFetch = res; });
      vi.spyOn(tracker, 'fetchCandidateIssues').mockReturnValueOnce(slowPromise);

      mockRunFn.mockReturnValue(new Promise(() => {}));

      // Start first tick (will block on slow fetch)
      const tick1 = orch.onTick();

      // Attempt second tick while first is in progress
      const tick2Promise = orch.onTick();

      // Second tick should return immediately (no dispatch)
      await tick2Promise;

      // Now resolve the slow fetch
      resolveSlowFetch!([issue]);
      await tick1;

      // Only one dispatch should have happened
      expect(orch.getState().running.size).toBe(1);
    });
  });
});
