import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MemoryTracker } from '../../src/tracker.js';
import type { haticeConfig, Issue, Workflow } from '../../src/types.js';
import type { WorkflowStore } from '../../src/workflow-store.js';
import { AgentRunner } from '../../src/agent-runner.js';
import { Workspace } from '../../src/workspace.js';

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
    workspace: { rootDir: '/tmp/hatice-test' },
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

function createMockWorkflowStore(config: haticeConfig): WorkflowStore & { _setWorkflow: (w: Workflow) => void } {
  let workflow: Workflow = { config, promptTemplate: 'Fix: {{ issue.title }}' };
  const store = {
    load: vi.fn().mockImplementation(() => workflow),
    getCurrentWorkflow: vi.fn().mockImplementation(() => workflow),
    hasChanged: vi.fn().mockReturnValue(false),
    _setWorkflow(w: Workflow) {
      workflow = w;
    },
  };
  return store as unknown as WorkflowStore & { _setWorkflow: (w: Workflow) => void };
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

/** Set up default mocks for AgentRunner and Workspace before each test */
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

describe('lifecycle integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Terminal state cleanup
  // -----------------------------------------------------------------------
  it('stops agent and cleans workspace when issue reaches terminal state', async () => {
    const { removeWorkspaceFn } = setupDefaultMocks();

    const config = createTestConfig();
    const issue = makeIssue('issue-1', { state: 'In Progress' });
    const tracker = new MemoryTracker([issue]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    // Tick 1: dispatch the issue (agent runs indefinitely via mock)
    await orchestrator.onTick();

    const state = orchestrator.getState();
    expect(state.isRunning('issue-1')).toBe(true);

    // Now change the issue state to terminal
    await tracker.updateIssueState('issue-1', 'Done');

    // Tick 2: reconciliation detects terminal state, stops agent, cleans workspace
    await orchestrator.onTick();

    expect(state.isRunning('issue-1')).toBe(false);
    expect(state.isClaimed('issue-1')).toBe(false);
    expect(state.isCompleted('issue-1')).toBe(true);
    expect(removeWorkspaceFn).toHaveBeenCalledWith('TEST-issue-1', 'issue-1');
  });

  // -----------------------------------------------------------------------
  // 2. Blocker resolution
  // -----------------------------------------------------------------------
  it('dispatches blocked issue after blocker reaches terminal state', async () => {
    setupDefaultMocks();

    const config = createTestConfig();

    const issueA = makeIssue('issue-A', {
      state: 'In Progress',
      createdAt: '2024-01-01T00:00:00Z',
    });

    // Issue B is blocked by Issue A (which is in non-terminal state)
    const issueB = makeIssue('issue-B', {
      state: 'Todo',
      createdAt: '2024-01-02T00:00:00Z',
      blockedBy: [{ id: 'issue-A', identifier: 'TEST-issue-A', state: 'In Progress' }],
    });

    const tracker = new MemoryTracker([issueA, issueB]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    const dispatched: string[] = [];
    orchestrator.on('issue:dispatched', (id) => dispatched.push(id));

    // Tick 1: Only issue-A is eligible (issue-B has active blocker)
    await orchestrator.onTick();

    expect(dispatched).toContain('issue-A');
    expect(dispatched).not.toContain('issue-B');

    // Move blocker to terminal state
    await tracker.updateIssueState('issue-A', 'Done');

    // Update the blocker ref in issue B to reflect terminal state
    // (the tracker returns fresh data on fetchCandidateIssues)
    const freshIssueB = makeIssue('issue-B', {
      state: 'Todo',
      createdAt: '2024-01-02T00:00:00Z',
      blockedBy: [{ id: 'issue-A', identifier: 'TEST-issue-A', state: 'Done' }],
    });
    tracker.addIssue(freshIssueB);

    // Tick 2: reconciliation handles issue-A terminal state,
    // and issue-B should now be eligible (blocker is terminal)
    await orchestrator.onTick();

    expect(dispatched).toContain('issue-B');
  });

  // -----------------------------------------------------------------------
  // 3. Config hot-reload
  // -----------------------------------------------------------------------
  it('picks up new config from WorkflowStore on tick', async () => {
    setupDefaultMocks();

    const config = createTestConfig({
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'test-key',
        projectSlug: 'TEST',
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Cancelled'],
        assignee: null,
      },
    });

    // Issue in "In Progress" state - active and dispatchable
    const issue = makeIssue('issue-1', { state: 'In Progress' });
    const tracker = new MemoryTracker([issue]);
    const workflowStore = createMockWorkflowStore(config);
    const orchestrator = new Orchestrator({ tracker, workflowStore, config });

    // Tick 1: dispatch the issue
    await orchestrator.onTick();

    const state = orchestrator.getState();
    expect(state.isRunning('issue-1')).toBe(true);

    // Hot-reload: new config adds "In Progress" to terminal states
    // This means reconciliation should stop the running agent
    const newConfig = createTestConfig({
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'test-key',
        projectSlug: 'TEST',
        activeStates: ['Todo'],
        terminalStates: ['Done', 'Cancelled', 'In Progress'],
        assignee: null,
      },
    });
    const newWorkflow: Workflow = { config: newConfig, promptTemplate: 'Fix: {{ issue.title }}' };
    workflowStore._setWorkflow(newWorkflow);

    // Tick 2: orchestrator picks up new config, "In Progress" is now terminal
    // Reconciliation should stop the agent and clean up
    await orchestrator.onTick();

    expect(state.isRunning('issue-1')).toBe(false);
    expect(state.isCompleted('issue-1')).toBe(true);
  });
});
