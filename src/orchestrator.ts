import { EventEmitter } from 'node:events';
import { OrchestratorState } from './orchestrator-state.js';
import { Workspace } from './workspace.js';
import { AgentRunner } from './agent-runner.js';
import { WorkflowStore } from './workflow-store.js';
import { EventBus } from './event-bus.js';
import type {
  Issue, Tracker, haticeConfig, WorkerResult, RunningEntry,
  haticeEvents,
} from './types.js';
import { emptyTokenUsage } from './types.js';
import { createLogger } from './logger.js';

export interface OrchestratorOptions {
  tracker: Tracker;
  workflowStore: WorkflowStore;
  config: haticeConfig;
}

export class Orchestrator extends EventEmitter<haticeEvents> {
  private tracker: Tracker;
  private workflowStore: WorkflowStore;
  private config: haticeConfig;
  private state: OrchestratorState;
  private workspace: Workspace;
  private eventBus: EventBus<haticeEvents>;
  private log;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private tickInProgress = false;
  private started = false;
  constructor(options: OrchestratorOptions) {
    super();
    this.tracker = options.tracker;
    this.workflowStore = options.workflowStore;
    this.config = options.config;
    this.state = new OrchestratorState(
      options.config.agent.maxConcurrentAgents,
      options.config.agent.maxConcurrentAgentsByState,
    );
    this.workspace = new Workspace(options.config.workspace.rootDir, options.config.hooks);
    this.eventBus = new EventBus<haticeEvents>();
    this.log = createLogger({ component: 'orchestrator' });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.log.info('Orchestrator started');
    this.scheduleTick(0); // First tick immediately
  }

  stop(): void {
    this.started = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    // Abort all running agents
    for (const entry of this.state.running.values()) {
      entry.abortController.abort();
    }
    // Cancel all retries
    for (const issueId of this.state.retryAttempts.keys()) {
      this.state.cancelRetry(issueId);
    }
    this.log.info('Orchestrator stopped');
  }

  getState(): OrchestratorState {
    return this.state;
  }

  getEventBus(): EventBus<haticeEvents> {
    return this.eventBus;
  }

  // Force an immediate tick (for HTTP API /refresh endpoint)
  async refresh(): Promise<void> {
    await this.onTick();
  }

  private scheduleTick(delayMs: number): void {
    if (!this.started) return;
    this.tickTimer = setTimeout(() => this.onTick(), delayMs);
  }

  async onTick(): Promise<void> {
    if (this.tickInProgress) {
      this.log.debug('Tick skipped: previous tick still in progress');
      return;
    }

    this.tickInProgress = true;
    this.emit('tick:start');
    this.eventBus.emit('tick:start');

    try {
      // Check for config hot-reload
      const workflow = this.workflowStore.load();
      if (workflow) {
        this.config = workflow.config;
      }

      // Phase 1: Reconcile running agents
      await this.reconcileRunning();

      // Phase 2: Fetch candidates and dispatch
      let dispatched = 0;
      try {
        const candidates = await this.tracker.fetchCandidateIssues();
        const toDispatch = this.chooseIssues(candidates);
        for (const issue of toDispatch) {
          try {
            await this.dispatchIssue(issue, 1);
            dispatched++;
          } catch (e) {
            this.log.error({ err: e, issueId: issue.id }, 'Failed to dispatch issue');
          }
        }
      } catch (e) {
        this.log.error({ err: e }, 'Failed to fetch candidates, skipping dispatch');
      }

      this.emit('tick:end', dispatched);
      this.eventBus.emit('tick:end', dispatched);
    } finally {
      this.tickInProgress = false;
      this.scheduleTick(this.config.polling.intervalMs);
    }
  }

  chooseIssues(candidates: Issue[]): Issue[] {
    const terminalStates = new Set(
      this.config.tracker.terminalStates.map(s => s.trim().toLowerCase())
    );
    const activeStates = new Set(
      this.config.tracker.activeStates.map(s => s.trim().toLowerCase())
    );

    const eligible = candidates.filter(issue => {
      // Must have required fields
      if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

      // Must be assigned to this worker
      if (!issue.assignedToWorker) return false;

      // Must be in active state, not terminal
      const normalizedState = issue.state.trim().toLowerCase();
      if (!activeStates.has(normalizedState)) return false;
      if (terminalStates.has(normalizedState)) return false;

      // Must not have active blockers
      if (this.hasActiveBlockers(issue, terminalStates)) return false;

      // Must not already be claimed, running, or completed
      if (this.state.isClaimed(issue.id)) return false;
      if (this.state.isRunning(issue.id)) return false;
      if (this.state.isCompleted(issue.id)) return false;

      // Must have available slots
      if (this.state.availableSlots(issue.state) <= 0) return false;

      return true;
    });

    // Sort: priority DESC (1 is highest), createdAt ASC, identifier ASC
    eligible.sort((a, b) => {
      const pa = a.priority ?? 99; // null priority = lowest
      const pb = b.priority ?? 99;
      if (pa !== pb) return pa - pb; // Lower number = higher priority

      const ca = a.createdAt;
      const cb = b.createdAt;
      if (ca !== cb) return ca < cb ? -1 : 1;

      return a.identifier.localeCompare(b.identifier);
    });

    // Select issues respecting both global and per-state slot limits
    const selected: Issue[] = [];
    let globalRemaining = this.state.availableSlots();
    // Track how many we've selected per normalized state (on top of already-running)
    const selectedByState = new Map<string, number>();

    for (const issue of eligible) {
      if (globalRemaining <= 0) break;

      const normalizedState = issue.state.trim().toLowerCase();
      const alreadySelected = selectedByState.get(normalizedState) ?? 0;

      // Check per-state limit accounting for already-selected in this batch
      const stateSlots = this.state.availableSlots(issue.state);
      if (stateSlots - alreadySelected <= 0) continue;

      selected.push(issue);
      globalRemaining--;
      selectedByState.set(normalizedState, alreadySelected + 1);
    }

    return selected;
  }

  private hasActiveBlockers(issue: Issue, terminalStates: Set<string>): boolean {
    return issue.blockedBy.some(blocker => {
      const blockerState = blocker.state.trim().toLowerCase();
      return !terminalStates.has(blockerState);
    });
  }

  async dispatchIssue(issue: Issue, attempt: number): Promise<void> {
    this.state.claim(issue.id);

    try {
      const workspacePath = await this.workspace.ensureWorkspace(issue.identifier, issue.id);
      const workflow = this.workflowStore.getCurrentWorkflow();
      if (!workflow) {
        throw new Error('No workflow loaded');
      }

      const abortController = new AbortController();

      // Set up stall timeout
      const stallTimer = this.setupStallTimer(issue.id, abortController);

      const runner = new AgentRunner({
        issue,
        workspacePath,
        promptTemplate: workflow.promptTemplate,
        attempt,
        maxTurns: this.config.agent.maxTurns,
        claudeConfig: this.config.claude,
        trackerConfig: this.config.tracker,
        abortController,
        onEvent: (id, name, detail) => {
          this.updateActivity(id);
          this.emit('agent:event', id, name, detail);
        },
        onTokenUsage: (id, usage) => {
          this.state.updateTokenUsage(id, usage);
          this.emit('tokens:updated', id, usage);
          this.eventBus.emit('tokens:updated', id, usage);
        },
        onSessionId: (id, sessionId) => {
          const entry = this.state.running.get(id);
          if (entry) entry.sessionId = sessionId;
        },
      });

      const promise = runner.run().then(async result => {
        clearInterval(stallTimer);
        await this.handleWorkerExit(issue.id, result);
        return result;
      }).catch(e => {
        clearInterval(stallTimer);
        this.log.error({ err: e, issueId: issue.id }, 'Unhandled error in worker exit handler');
        throw e;
      });

      const entry: RunningEntry = {
        issueId: issue.id,
        identifier: issue.identifier,
        issue,
        state: issue.state,
        startedAt: new Date(),
        attempt,
        sessionId: null,
        lastEvent: null,
        lastEventAt: null,
        lastActivityAt: new Date(),
        tokenUsage: emptyTokenUsage(),
        abortController,
        promise,
      };

      this.state.addRunning(entry);
      this.emit('issue:dispatched', issue.id, issue.identifier);
      this.eventBus.emit('issue:dispatched', issue.id, issue.identifier);
      this.emitStateUpdated();
      this.log.info({ issueId: issue.id, identifier: issue.identifier, attempt }, 'Issue dispatched');
    } catch (e) {
      this.state.unclaim(issue.id);
      throw e;
    }
  }

  private setupStallTimer(issueId: string, abortController: AbortController): ReturnType<typeof setInterval> {
    return setInterval(() => {
      const entry = this.state.running.get(issueId);
      if (!entry) return;
      const elapsed = Date.now() - entry.lastActivityAt.getTime();
      if (elapsed > this.config.claude.stallTimeoutMs) {
        this.log.warn({ issueId, elapsed }, 'Agent stalled, aborting');
        abortController.abort();
      }
    }, 30_000); // Check every 30s
  }

  private emitStateUpdated(): void {
    this.emit('state:updated');
    this.eventBus.emit('state:updated');
  }

  private updateActivity(issueId: string): void {
    const entry = this.state.running.get(issueId);
    if (entry) {
      entry.lastActivityAt = new Date();
    }
  }

  async handleWorkerExit(issueId: string, result: WorkerResult): Promise<void> {
    const entry = this.state.removeRunning(issueId);
    if (!entry) return;

    switch (result.kind) {
      case 'normal':
        this.log.info({ issueId, turns: result.turnsCompleted }, 'Agent completed normally');
        this.emit('issue:completed', issueId, entry.identifier, result.usage);
        this.eventBus.emit('issue:completed', issueId, entry.identifier, result.usage);
        if (this.config.agent.retryOnNormalExit) {
          // Config requests continuation retry after normal completion
          this.scheduleRetry(entry, entry.attempt + 1, 1000, null);
        } else {
          // Agent finished successfully — mark completed
          this.state.markCompleted(issueId);
          this.state.unclaim(issueId);
          this.emitStateUpdated();

          // Update tracker: post comment + move to Done
          try {
            const usage = result.usage;
            const comment = [
              `**hatice** completed this issue.`,
              `- Turns: ${result.turnsCompleted}`,
              `- Duration: ${((result.durationMs ?? 0) / 1000).toFixed(1)}s`,
              ...(usage ? [
                `- Tokens: ${usage.totalTokens} (in: ${usage.inputTokens}, out: ${usage.outputTokens})`,
                `- Cost: $${usage.costUsd.toFixed(4)}`,
              ] : []),
            ].join('\n');
            await this.tracker.createComment(issueId, comment);
            this.log.info({ issueId }, 'Posted completion comment to tracker');
          } catch (e) {
            this.log.warn({ err: e, issueId }, 'Failed to post completion comment');
          }

          try {
            await this.tracker.updateIssueState(issueId, 'Done');
            this.log.info({ issueId }, 'Updated issue state to Done');
          } catch (e) {
            this.log.warn({ err: e, issueId }, 'Failed to update issue state to Done');
          }

          // Keep workspace after completion so code changes are preserved
          // Workspace can be manually cleaned up or by startup cleanup on next run
          this.log.info({ issueId, identifier: entry.identifier }, 'Workspace preserved after completion');
        }
        break;

      case 'error':
        this.log.error({ issueId, err: result.error, attempt: result.attempt }, 'Agent failed');
        this.emit('issue:failed', issueId, entry.identifier, result.error);
        this.eventBus.emit('issue:failed', issueId, entry.identifier, result.error);
        this.emitStateUpdated();
        // Exponential backoff
        const delay = Math.min(
          10_000 * Math.pow(2, result.attempt - 1),
          this.config.agent.maxRetryBackoffMs,
        );
        this.scheduleRetry(entry, result.attempt + 1, delay, result.error.message);
        break;

      case 'cancelled':
        this.log.info({ issueId, reason: result.reason }, 'Agent cancelled');
        this.state.unclaim(issueId);
        this.emit('issue:released', issueId, entry.identifier, result.reason);
        this.eventBus.emit('issue:released', issueId, entry.identifier, result.reason);
        this.emitStateUpdated();
        break;
    }
  }

  private scheduleRetry(entry: RunningEntry, attempt: number, delayMs: number, lastError: string | null): void {
    const timerHandle = setTimeout(() => {
      this.handleRetryFired(entry.issueId);
    }, delayMs);

    this.state.scheduleRetry({
      issueId: entry.issueId,
      identifier: entry.identifier,
      attempt,
      scheduledAt: new Date(),
      delayMs,
      timerHandle,
      lastError,
    });

    this.emit('issue:retrying', entry.issueId, entry.identifier, attempt, delayMs);
    this.eventBus.emit('issue:retrying', entry.issueId, entry.identifier, attempt, delayMs);
    this.log.info({ issueId: entry.issueId, attempt, delayMs }, 'Retry scheduled');
  }

  async handleRetryFired(issueId: string): Promise<void> {
    this.state.cancelRetry(issueId);

    try {
      const [issue] = await this.tracker.fetchIssueStatesByIds([issueId]);
      if (!issue) {
        this.log.warn({ issueId }, 'Issue not found on retry, releasing');
        this.state.unclaim(issueId);
        return;
      }

      const terminalStates = new Set(
        this.config.tracker.terminalStates.map(s => s.trim().toLowerCase())
      );
      const normalizedState = issue.state.trim().toLowerCase();

      if (terminalStates.has(normalizedState)) {
        this.log.info({ issueId, state: issue.state }, 'Issue terminal on retry, cleaning up');
        this.state.unclaim(issueId);
        this.state.markCompleted(issueId);
        try {
          await this.workspace.removeWorkspace(issue.identifier, issueId);
        } catch (e) {
          this.log.warn({ err: e, issueId }, 'Failed to cleanup workspace');
        }
        return;
      }

      if (this.state.availableSlots(issue.state) > 0) {
        const retry = this.state.getRetry(issueId);
        const attempt = retry?.attempt ?? 1;
        await this.dispatchIssue(issue, attempt);
      } else {
        this.log.info({ issueId }, 'No slots available for retry, rescheduling');
        const entry: RunningEntry = {
          issueId, identifier: issue.identifier, issue, state: issue.state,
          startedAt: new Date(), attempt: 1, sessionId: null,
          lastEvent: null, lastEventAt: null, lastActivityAt: new Date(),
          tokenUsage: emptyTokenUsage(), abortController: new AbortController(),
          promise: Promise.resolve({ kind: 'normal', issueId, turnsCompleted: 0, usage: emptyTokenUsage(), durationMs: 0 }),
        };
        this.scheduleRetry(entry, 1, this.config.polling.intervalMs, 'No slots available');
      }
    } catch (e) {
      this.log.error({ err: e, issueId }, 'Retry revalidation failed');
    }
  }

  private async reconcileRunning(): Promise<void> {
    if (this.state.running.size === 0) return;

    const runningIds = Array.from(this.state.running.keys());
    try {
      const freshIssues = await this.tracker.fetchIssueStatesByIds(runningIds);
      const freshMap = new Map(freshIssues.map(i => [i.id, i]));

      const terminalStates = new Set(
        this.config.tracker.terminalStates.map(s => s.trim().toLowerCase())
      );
      const activeStates = new Set(
        this.config.tracker.activeStates.map(s => s.trim().toLowerCase())
      );

      for (const [issueId, entry] of this.state.running) {
        const fresh = freshMap.get(issueId);
        if (!fresh) continue;

        const normalizedState = fresh.state.trim().toLowerCase();

        if (terminalStates.has(normalizedState)) {
          this.log.info({ issueId, state: fresh.state }, 'Issue reached terminal state, stopping agent');
          entry.abortController.abort();
          this.state.removeRunning(issueId);
          this.state.unclaim(issueId);
          this.state.markCompleted(issueId);
          this.emitStateUpdated();
          try {
            await this.workspace.removeWorkspace(entry.identifier, issueId);
          } catch (e) {
            this.log.warn({ err: e, issueId }, 'Failed to cleanup workspace on reconciliation');
          }
        } else if (!activeStates.has(normalizedState)) {
          this.log.info({ issueId, state: fresh.state }, 'Issue no longer active, stopping agent');
          entry.abortController.abort();
          this.state.removeRunning(issueId);
          this.state.unclaim(issueId);
          this.emitStateUpdated();
        }
      }
    } catch (e) {
      // Fail open: keep all running agents on reconciliation error
      this.log.error({ err: e }, 'Reconciliation failed, keeping all agents running');
    }
  }
}
