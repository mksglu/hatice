import { EventEmitter } from 'node:events';
import type {
  RunningEntry, RetryState, TokenUsage, AggregateTotals,
  OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry,
} from './types.js';
import { emptyAggregateTotals } from './types.js';

export class OrchestratorState extends EventEmitter {
  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly completed = new Set<string>();
  readonly retryAttempts = new Map<string, RetryState>();
  totals: AggregateTotals = emptyAggregateTotals();

  private maxConcurrentAgents: number;
  private maxConcurrentAgentsByState: Record<string, number>;

  constructor(maxConcurrentAgents: number, maxConcurrentAgentsByState: Record<string, number> = {}) {
    super();
    this.maxConcurrentAgents = maxConcurrentAgents;
    this.maxConcurrentAgentsByState = maxConcurrentAgentsByState;
  }

  claim(issueId: string): void {
    this.claimed.add(issueId);
  }

  unclaim(issueId: string): void {
    this.claimed.delete(issueId);
  }

  isClaimed(issueId: string): boolean {
    return this.claimed.has(issueId);
  }

  addRunning(entry: RunningEntry): void {
    this.running.set(entry.issueId, entry);
  }

  removeRunning(issueId: string): RunningEntry | undefined {
    const entry = this.running.get(issueId);
    if (entry) {
      this.running.delete(issueId);
    }
    return entry;
  }

  isRunning(issueId: string): boolean {
    return this.running.has(issueId);
  }

  markCompleted(issueId: string): void {
    this.completed.add(issueId);
  }

  isCompleted(issueId: string): boolean {
    return this.completed.has(issueId);
  }

  updateTokenUsage(issueId: string, usage: TokenUsage): void {
    const entry = this.running.get(issueId);
    if (entry) {
      entry.tokenUsage = usage;
    }
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.totalTokens += usage.totalTokens;
  }

  availableSlots(state?: string): number {
    if (state) {
      const normalizedState = state.trim().toLowerCase();
      const stateLimit = this.maxConcurrentAgentsByState[normalizedState];
      if (stateLimit !== undefined) {
        const stateCount = this.countByState()[normalizedState] ?? 0;
        return Math.max(0, stateLimit - stateCount);
      }
    }
    return Math.max(0, this.maxConcurrentAgents - this.running.size);
  }

  countByState(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.running.values()) {
      const state = entry.state.trim().toLowerCase();
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return counts;
  }

  scheduleRetry(state: RetryState): void {
    this.retryAttempts.set(state.issueId, state);
  }

  cancelRetry(issueId: string): void {
    const retry = this.retryAttempts.get(issueId);
    if (retry) {
      clearTimeout(retry.timerHandle);
      this.retryAttempts.delete(issueId);
    }
  }

  getRetry(issueId: string): RetryState | undefined {
    return this.retryAttempts.get(issueId);
  }

  snapshot(): OrchestratorSnapshot {
    const now = Date.now();

    const running: SnapshotRunningEntry[] = [];
    for (const entry of this.running.values()) {
      running.push({
        issueId: entry.issueId,
        identifier: entry.identifier,
        state: entry.state,
        sessionId: entry.sessionId,
        attempt: entry.attempt,
        runtimeSeconds: (now - entry.startedAt.getTime()) / 1000,
        tokenUsage: { ...entry.tokenUsage },
        lastEvent: entry.lastEvent,
        lastEventAt: entry.lastEventAt,
      });
    }

    const retrying: SnapshotRetryEntry[] = [];
    for (const retry of this.retryAttempts.values()) {
      retrying.push({
        issueId: retry.issueId,
        identifier: retry.identifier,
        attempt: retry.attempt,
        nextRetryInMs: Math.max(0, retry.scheduledAt.getTime() + retry.delayMs - now),
        lastError: retry.lastError,
      });
    }

    return {
      running,
      retrying,
      completed: this.completed.size,
      totals: { ...this.totals },
      polling: { intervalMs: 0, nextPollInMs: 0 },
    };
  }
}
