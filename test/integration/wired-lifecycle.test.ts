import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MemoryTracker } from '../../src/tracker.js';
import { EventBus } from '../../src/event-bus.js';
import { SessionLogger } from '../../src/session-logger.js';
import { StartupCleanup } from '../../src/cleanup.js';
import { AgentRunner } from '../../src/agent-runner.js';
import { Workspace } from '../../src/workspace.js';
import type { haticeConfig, Issue, WorkerResult, Workflow, haticeEvents } from '../../src/types.js';
import type { WorkflowStore } from '../../src/workflow-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/agent-runner.js', () => ({
  AgentRunner: vi.fn(),
}));

vi.mock('../../src/workspace.js', () => ({
  Workspace: vi.fn(),
}));

const MockedAgentRunner = vi.mocked(AgentRunner);
const MockedWorkspace = vi.mocked(Workspace);

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
    workspace: { rootDir: '/tmp/hatice-wired-test' },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
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
      canUseTool: null,
      claudeCodePath: null,
      autoRespondToInput: false,
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

function setupDefaultMocks(): { removeWorkspaceFn: ReturnType<typeof vi.fn> } {
  const removeWorkspaceFn = vi.fn().mockResolvedValue(undefined);

  MockedAgentRunner.mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
  }) as any);

  MockedWorkspace.mockImplementation(() => ({
    ensureWorkspace: vi.fn().mockResolvedValue('/tmp/test-workspace'),
    removeWorkspace: removeWorkspaceFn,
  }) as any);

  return { removeWorkspaceFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wired-lifecycle integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Test 1: EventBus emits events during dispatch cycle
  // -----------------------------------------------------------------------
  it('EventBus emits issue:dispatched and issue:completed events during dispatch cycle', async () => {
    let resolveRun!: (result: WorkerResult) => void;
    const runPromise = new Promise<WorkerResult>((r) => { resolveRun = r; });

    MockedAgentRunner.mockImplementation(() => ({
      run: vi.fn().mockReturnValue(runPromise),
    }) as any);

    MockedWorkspace.mockImplementation(() => ({
      ensureWorkspace: vi.fn().mockResolvedValue('/tmp/test-workspace'),
      removeWorkspace: vi.fn().mockResolvedValue(undefined),
    }) as any);

    const config = createTestConfig();
    const tracker = new MemoryTracker([makeIssue('evt-1')]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    // Subscribe to the orchestrator's EventBus
    const eventBus = orchestrator.getEventBus();

    const busDispatched: string[] = [];
    const busCompleted: string[] = [];
    eventBus.on('issue:dispatched', (issueId) => { busDispatched.push(issueId); });
    eventBus.on('issue:completed', (issueId) => { busCompleted.push(issueId); });

    // Also subscribe to orchestrator's own EventEmitter for cross-check
    const emitterDispatched: string[] = [];
    const emitterCompleted: string[] = [];
    orchestrator.on('issue:dispatched', (id) => { emitterDispatched.push(id); });
    orchestrator.on('issue:completed', (id) => { emitterCompleted.push(id); });

    // Trigger tick - should dispatch
    await orchestrator.onTick();

    // Verify 'issue:dispatched' event fired on both EventBus and EventEmitter
    expect(busDispatched).toContain('evt-1');
    expect(emitterDispatched).toContain('evt-1');

    // Agent completes
    resolveRun({
      kind: 'normal',
      issueId: 'evt-1',
      turnsCompleted: 3,
      usage: {
        inputTokens: 50, outputTokens: 25, totalTokens: 75,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.005,
      },
      durationMs: 2000,
    });

    // Flush microtasks so handleWorkerExit runs
    await new Promise((r) => process.nextTick(r));

    // Verify 'issue:completed' event fired on both EventBus and EventEmitter
    expect(busCompleted).toContain('evt-1');
    expect(emitterCompleted).toContain('evt-1');
  });

  // -----------------------------------------------------------------------
  // Test 2: SessionLogger creates log for dispatched agent
  // -----------------------------------------------------------------------
  it('SessionLogger creates a log file for a dispatched agent session', () => {
    // Use a real temp directory for file system verification
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatice-session-'));

    try {
      const sessionLogger = new SessionLogger(tmpDir);

      // Create a session log (simulating what would happen during dispatch)
      const logger = sessionLogger.createSessionLog('issue-42', 'TEST-42');

      // Write a log entry to ensure the file is populated
      logger.info({ event: 'dispatched' }, 'Agent dispatched for issue');

      // Verify the log path was created
      const logPath = sessionLogger.getLogPath('issue-42');
      expect(logPath).not.toBeNull();
      expect(logPath!.startsWith(tmpDir)).toBe(true);
      expect(logPath!.endsWith('.log')).toBe(true);

      // Verify the log file exists on disk
      expect(fs.existsSync(logPath!)).toBe(true);

      // Verify the filename contains the sanitized identifier
      const filename = path.basename(logPath!);
      expect(filename).toMatch(/^TEST-42-\d+\.log$/);

      // Cleanup
      sessionLogger.cleanup();
    } finally {
      // Remove temp directory
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Startup cleanup removes stale workspaces
  // -----------------------------------------------------------------------
  it('StartupCleanup removes stale workspace directories', async () => {
    vi.useRealTimers(); // Need real timers for fs operations

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatice-cleanup-'));

    try {
      // Create stale subdirectories (we'll backdate their mtime)
      const staleDir1 = path.join(tmpDir, 'stale-workspace-1');
      const staleDir2 = path.join(tmpDir, 'stale-workspace-2');
      const freshDir = path.join(tmpDir, 'fresh-workspace');

      fs.mkdirSync(staleDir1);
      fs.mkdirSync(staleDir2);
      fs.mkdirSync(freshDir);

      // Backdate stale directories to 48 hours ago
      const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      fs.utimesSync(staleDir1, staleTime, staleTime);
      fs.utimesSync(staleDir2, staleTime, staleTime);

      // Fresh directory keeps current timestamp (just created)

      const cleanup = new StartupCleanup({
        workspaceRoot: tmpDir,
        maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
      });

      const result = await cleanup.run();

      // Verify stale dirs were removed
      expect(result.removed).toBe(2);
      expect(result.scanned).toBe(3);
      expect(result.errors).toBe(0);
      expect(result.removedPaths).toContain(staleDir1);
      expect(result.removedPaths).toContain(staleDir2);

      // Verify stale dirs no longer exist
      expect(fs.existsSync(staleDir1)).toBe(false);
      expect(fs.existsSync(staleDir2)).toBe(false);

      // Verify fresh dir still exists
      expect(fs.existsSync(freshDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Test 4: Full lifecycle: dispatch -> complete -> cleanup
  // -----------------------------------------------------------------------
  it('full lifecycle: dispatch, complete, events emitted, reconciliation triggers workspace cleanup', async () => {
    let resolveRun!: (result: WorkerResult) => void;
    const runPromise = new Promise<WorkerResult>((r) => { resolveRun = r; });

    MockedAgentRunner.mockImplementation(() => ({
      run: vi.fn().mockReturnValue(runPromise),
    }) as any);

    const removeWorkspaceFn = vi.fn().mockResolvedValue(undefined);
    MockedWorkspace.mockImplementation(() => ({
      ensureWorkspace: vi.fn().mockResolvedValue('/tmp/test-workspace'),
      removeWorkspace: removeWorkspaceFn,
    }) as any);

    const config = createTestConfig();
    const issue = makeIssue('lifecycle-1', { state: 'In Progress' });
    const tracker = new MemoryTracker([issue]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    // Collect all events from EventBus
    const eventBus = orchestrator.getEventBus();
    const allEvents: Array<{ event: string; args: unknown[] }> = [];
    eventBus.onAny((event, ...args) => {
      allEvents.push({ event, args });
    });

    // Collect events from orchestrator's EventEmitter too
    const dispatched: string[] = [];
    const completed: string[] = [];
    orchestrator.on('issue:dispatched', (id) => dispatched.push(id));
    orchestrator.on('issue:completed', (id) => completed.push(id));

    // --- Phase 1: Dispatch ---
    await orchestrator.onTick();

    const state = orchestrator.getState();
    expect(state.isRunning('lifecycle-1')).toBe(true);
    expect(dispatched).toContain('lifecycle-1');

    // Verify EventBus got the dispatched event
    const dispatchedEvents = allEvents.filter(e => e.event === 'issue:dispatched');
    expect(dispatchedEvents.length).toBe(1);
    expect(dispatchedEvents[0]!.args[0]).toBe('lifecycle-1');

    // --- Phase 2: Agent completes ---
    resolveRun({
      kind: 'normal',
      issueId: 'lifecycle-1',
      turnsCompleted: 10,
      usage: {
        inputTokens: 200, outputTokens: 100, totalTokens: 300,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.02,
      },
      durationMs: 8000,
    });

    // Flush microtasks
    await new Promise((r) => process.nextTick(r));

    // Verify completion
    expect(completed).toContain('lifecycle-1');
    expect(state.isRunning('lifecycle-1')).toBe(false);
    expect(state.isCompleted('lifecycle-1')).toBe(true);
    expect(state.isClaimed('lifecycle-1')).toBe(false);

    // Verify EventBus got the completed event
    const completedEvents = allEvents.filter(e => e.event === 'issue:completed');
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.args[0]).toBe('lifecycle-1');

    // Verify workspace cleanup was triggered on normal completion
    expect(removeWorkspaceFn).toHaveBeenCalledWith('TEST-lifecycle-1', 'lifecycle-1');
  });

  // -----------------------------------------------------------------------
  // Test 4b: Reconciliation cleanup for terminal state
  // -----------------------------------------------------------------------
  it('reconciliation triggers workspace cleanup when issue moves to terminal state', async () => {
    const removeWorkspaceFn = vi.fn().mockResolvedValue(undefined);

    MockedAgentRunner.mockImplementation(() => ({
      run: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    }) as any);

    MockedWorkspace.mockImplementation(() => ({
      ensureWorkspace: vi.fn().mockResolvedValue('/tmp/test-workspace'),
      removeWorkspace: removeWorkspaceFn,
    }) as any);

    const config = createTestConfig();
    const issue = makeIssue('recon-1', { state: 'In Progress' });
    const tracker = new MemoryTracker([issue]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    // Collect events
    const eventBus = orchestrator.getEventBus();
    const allBusEvents: string[] = [];
    eventBus.onAny((event) => { allBusEvents.push(event); });

    // Tick 1: Dispatch the issue
    await orchestrator.onTick();

    const state = orchestrator.getState();
    expect(state.isRunning('recon-1')).toBe(true);

    // Change issue to terminal state (simulating external state change)
    await tracker.updateIssueState('recon-1', 'Done');

    // Tick 2: Reconciliation detects terminal state, stops agent, cleans workspace
    await orchestrator.onTick();

    expect(state.isRunning('recon-1')).toBe(false);
    expect(state.isClaimed('recon-1')).toBe(false);
    expect(state.isCompleted('recon-1')).toBe(true);

    // Workspace cleanup should have been called during reconciliation
    expect(removeWorkspaceFn).toHaveBeenCalledWith('TEST-recon-1', 'recon-1');

    // Verify tick events were emitted on the EventBus
    expect(allBusEvents).toContain('tick:start');
    expect(allBusEvents).toContain('tick:end');
    expect(allBusEvents).toContain('issue:dispatched');
  });
});
