import { describe, it, expect, vi, afterEach } from 'vitest';
import { OrchestratorState } from '../src/orchestrator-state.js';
import type { RunningEntry, RetryState, TokenUsage, Issue } from '../src/types.js';
import { emptyTokenUsage } from '../src/types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? 'issue-1',
    identifier: overrides.identifier ?? 'MT-1',
    title: overrides.title ?? 'Test issue',
    description: overrides.description ?? null,
    state: overrides.state ?? 'Todo',
    priority: overrides.priority ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    assignedToWorker: overrides.assignedToWorker ?? false,
    url: overrides.url ?? null,
    branchName: overrides.branchName ?? null,
    assigneeId: overrides.assigneeId ?? null,
  };
}

function makeRunningEntry(overrides: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issueId: overrides.issueId ?? 'issue-1',
    identifier: overrides.identifier ?? 'MT-1',
    issue: overrides.issue ?? makeIssue(),
    state: overrides.state ?? 'Todo',
    startedAt: overrides.startedAt ?? new Date(),
    attempt: overrides.attempt ?? 1,
    sessionId: overrides.sessionId ?? 'session-abc',
    lastEvent: overrides.lastEvent ?? null,
    lastEventAt: overrides.lastEventAt ?? null,
    lastActivityAt: overrides.lastActivityAt ?? new Date(),
    tokenUsage: overrides.tokenUsage ?? emptyTokenUsage(),
    abortController: overrides.abortController ?? new AbortController(),
    promise: overrides.promise ?? Promise.resolve({ kind: 'normal' as const, issueId: 'issue-1', turnsCompleted: 0, usage: emptyTokenUsage(), durationMs: 0 }),
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('OrchestratorState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ---- claim / unclaim ------------------------------------------ */

  it('claim adds issue ID to claimed set', () => {
    const state = new OrchestratorState(3);
    state.claim('issue-1');
    expect(state.claimed.has('issue-1')).toBe(true);
  });

  it('unclaim removes issue ID from claimed set', () => {
    const state = new OrchestratorState(3);
    state.claim('issue-1');
    state.unclaim('issue-1');
    expect(state.claimed.has('issue-1')).toBe(false);
  });

  /* ---- isClaimed ------------------------------------------------ */

  it('isClaimed returns true for claimed IDs', () => {
    const state = new OrchestratorState(3);
    state.claim('issue-1');
    expect(state.isClaimed('issue-1')).toBe(true);
    expect(state.isClaimed('issue-2')).toBe(false);
  });

  /* ---- addRunning ----------------------------------------------- */

  it('addRunning stores running entry in map', () => {
    const state = new OrchestratorState(3);
    const entry = makeRunningEntry({ issueId: 'issue-1' });
    state.addRunning(entry);
    expect(state.running.get('issue-1')).toBe(entry);
    expect(state.running.size).toBe(1);
  });

  /* ---- removeRunning -------------------------------------------- */

  it('removeRunning removes and returns entry', () => {
    const state = new OrchestratorState(3);
    const entry = makeRunningEntry({ issueId: 'issue-1' });
    state.addRunning(entry);

    const removed = state.removeRunning('issue-1');
    expect(removed).toBe(entry);
    expect(state.running.has('issue-1')).toBe(false);
  });

  it('removeRunning returns undefined for unknown ID', () => {
    const state = new OrchestratorState(3);
    expect(state.removeRunning('nonexistent')).toBeUndefined();
  });

  /* ---- isRunning ------------------------------------------------ */

  it('isRunning checks if issue is currently running', () => {
    const state = new OrchestratorState(3);
    const entry = makeRunningEntry({ issueId: 'issue-1' });
    state.addRunning(entry);

    expect(state.isRunning('issue-1')).toBe(true);
    expect(state.isRunning('issue-2')).toBe(false);
  });

  /* ---- markCompleted -------------------------------------------- */

  it('markCompleted moves issue to completed set', () => {
    const state = new OrchestratorState(3);
    const entry = makeRunningEntry({ issueId: 'issue-1' });
    state.addRunning(entry);
    state.removeRunning('issue-1');
    state.markCompleted('issue-1');

    expect(state.isCompleted('issue-1')).toBe(true);
    expect(state.isRunning('issue-1')).toBe(false);
  });

  /* ---- availableSlots ------------------------------------------- */

  it('availableSlots returns max minus running count', () => {
    const state = new OrchestratorState(3);
    expect(state.availableSlots()).toBe(3);

    state.addRunning(makeRunningEntry({ issueId: 'a' }));
    state.addRunning(makeRunningEntry({ issueId: 'b' }));
    expect(state.availableSlots()).toBe(1);
  });

  it('availableSlots respects per-state config', () => {
    const state = new OrchestratorState(5, { todo: 2 });
    state.addRunning(makeRunningEntry({ issueId: 'a', state: 'Todo' }));
    state.addRunning(makeRunningEntry({ issueId: 'b', state: 'Todo' }));
    state.addRunning(makeRunningEntry({ issueId: 'c', state: 'In Progress' }));

    // Per-state limit for "todo" is 2, already 2 running
    expect(state.availableSlots('Todo')).toBe(0);
    // Global: 5 max, 3 running => 2 available (no per-state limit for "In Progress")
    expect(state.availableSlots('In Progress')).toBe(2);
  });

  /* ---- countByState --------------------------------------------- */

  it('countByState counts running entries grouped by issue state', () => {
    const state = new OrchestratorState(5);
    state.addRunning(makeRunningEntry({ issueId: 'a', state: 'Todo' }));
    state.addRunning(makeRunningEntry({ issueId: 'b', state: 'Todo' }));
    state.addRunning(makeRunningEntry({ issueId: 'c', state: 'In Progress' }));

    const counts = state.countByState();
    expect(counts['todo']).toBe(2);
    expect(counts['in progress']).toBe(1);
  });

  /* ---- scheduleRetry / cancelRetry ------------------------------ */

  it('scheduleRetry and cancelRetry manage retry timers', () => {
    const state = new OrchestratorState(3);
    const timerHandle = setTimeout(() => {}, 10_000);

    const retry: RetryState = {
      issueId: 'issue-1',
      identifier: 'MT-1',
      attempt: 2,
      scheduledAt: new Date(),
      delayMs: 5000,
      timerHandle,
      lastError: 'something broke',
    };

    state.scheduleRetry(retry);
    expect(state.getRetry('issue-1')).toBe(retry);

    state.cancelRetry('issue-1');
    expect(state.getRetry('issue-1')).toBeUndefined();

    clearTimeout(timerHandle);
  });

  /* ---- snapshot ------------------------------------------------- */

  it('snapshot returns complete serializable snapshot', () => {
    const state = new OrchestratorState(3);

    const entry = makeRunningEntry({
      issueId: 'issue-1',
      identifier: 'MT-1',
      state: 'Todo',
      sessionId: 'sess-1',
      attempt: 1,
      startedAt: new Date(Date.now() - 5000),
    });
    state.addRunning(entry);
    state.markCompleted('issue-old');

    const timerHandle = setTimeout(() => {}, 10_000);
    state.scheduleRetry({
      issueId: 'issue-2',
      identifier: 'MT-2',
      attempt: 3,
      scheduledAt: new Date(),
      delayMs: 10_000,
      timerHandle,
      lastError: 'timeout',
    });

    const snap = state.snapshot();

    expect(snap.running).toHaveLength(1);
    expect(snap.running[0].issueId).toBe('issue-1');
    expect(snap.running[0].runtimeSeconds).toBeGreaterThanOrEqual(4);

    expect(snap.retrying).toHaveLength(1);
    expect(snap.retrying[0].issueId).toBe('issue-2');
    expect(snap.retrying[0].nextRetryInMs).toBeGreaterThan(0);

    expect(snap.completed).toBe(1);
    expect(snap.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 });
    expect(snap.polling).toEqual({ intervalMs: 0, nextPollInMs: 0 });

    clearTimeout(timerHandle);
  });

  /* ---- updateTokenUsage ----------------------------------------- */

  it('updateTokenUsage updates running entry token usage and aggregates totals', () => {
    const state = new OrchestratorState(3);
    const entry = makeRunningEntry({ issueId: 'issue-1' });
    state.addRunning(entry);

    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      costUsd: 0.01,
    };

    state.updateTokenUsage('issue-1', usage);

    // Entry updated
    expect(state.running.get('issue-1')!.tokenUsage).toBe(usage);

    // Aggregates updated
    expect(state.totals.inputTokens).toBe(100);
    expect(state.totals.outputTokens).toBe(50);
    expect(state.totals.totalTokens).toBe(150);

    // Second update accumulates
    state.updateTokenUsage('issue-1', usage);
    expect(state.totals.inputTokens).toBe(200);
    expect(state.totals.outputTokens).toBe(100);
    expect(state.totals.totalTokens).toBe(300);
  });
});
