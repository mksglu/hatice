import { describe, it, expect } from 'vitest';
import { StatusDashboard } from '../src/status-dashboard.js';
import type { OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry, TokenUsage } from '../src/types.js';

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeTokenUsage(total = 0): TokenUsage {
  return {
    inputTokens: Math.floor(total * 0.6),
    outputTokens: Math.floor(total * 0.4),
    totalTokens: total,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

function makeEmptySnapshot(): OrchestratorSnapshot {
  return {
    running: [],
    retrying: [],
    completed: 0,
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    polling: { intervalMs: 30000, nextPollInMs: 15000 },
  };
}

function makeRunningEntry(overrides: Partial<SnapshotRunningEntry> = {}): SnapshotRunningEntry {
  return {
    issueId: 'issue-1',
    identifier: 'MT-101',
    state: 'working',
    sessionId: 'sess-abc',
    attempt: 1,
    runtimeSeconds: 45,
    tokenUsage: makeTokenUsage(1500),
    lastEvent: 'Editing file',
    lastEventAt: new Date(),
    ...overrides,
  };
}

function makeRetryEntry(overrides: Partial<SnapshotRetryEntry> = {}): SnapshotRetryEntry {
  return {
    issueId: 'issue-2',
    identifier: 'MT-202',
    attempt: 3,
    nextRetryInMs: 12000,
    lastError: 'Rate limit exceeded',
    ...overrides,
  };
}

describe('StatusDashboard render output', () => {
  it('renders empty state with zero counts', () => {
    const snapshot = makeEmptySnapshot();
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });
    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    expect(output).toContain('0 running');
    expect(output).toContain('0 retrying');
    expect(output).toContain('0 completed');
    expect(output).not.toContain('Running Agents');
    expect(output).not.toContain('Retry Queue');
  });

  it('renders running agents with identifiers, states, and runtime', () => {
    const running: SnapshotRunningEntry[] = [
      makeRunningEntry({ identifier: 'MT-101', state: 'coding', runtimeSeconds: 120, tokenUsage: makeTokenUsage(5000) }),
      makeRunningEntry({ identifier: 'MT-202', state: 'reviewing', runtimeSeconds: 30, tokenUsage: makeTokenUsage(800), lastEvent: 'Reading PR' }),
    ];
    const snapshot: OrchestratorSnapshot = {
      ...makeEmptySnapshot(),
      running,
    };
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });
    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    expect(output).toContain('Running Agents');
    expect(output).toContain('MT-101');
    expect(output).toContain('MT-202');
    expect(output).toContain('coding');
    expect(output).toContain('reviewing');
    expect(output).toContain('2m 0s');
    expect(output).toContain('30s');
    expect(output).toContain('5.0K');
    expect(output).toContain('Editing file');
  });

  it('renders retry queue with attempt count, next retry time, and error', () => {
    const retrying: SnapshotRetryEntry[] = [
      makeRetryEntry({ identifier: 'MT-303', attempt: 2, nextRetryInMs: 30000, lastError: 'Connection timeout' }),
      makeRetryEntry({ identifier: 'MT-404', attempt: 5, nextRetryInMs: 60000, lastError: null }),
    ];
    const snapshot: OrchestratorSnapshot = {
      ...makeEmptySnapshot(),
      retrying,
    };
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });
    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    expect(output).toContain('Retry Queue');
    expect(output).toContain('MT-303');
    expect(output).toContain('attempt #2');
    expect(output).toContain('retry in 30s');
    expect(output).toContain('Connection timeout');
    expect(output).toContain('MT-404');
    expect(output).toContain('attempt #5');
    expect(output).toContain('retry in 1m 0s');
  });

  it('renders token stats with non-zero totals', () => {
    const snapshot: OrchestratorSnapshot = {
      ...makeEmptySnapshot(),
      totals: { inputTokens: 50000, outputTokens: 25000, totalTokens: 75000, secondsRunning: 300 },
      completed: 5,
    };
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });
    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    expect(output).toContain('75.0K');
    expect(output).toContain('tokens');
    expect(output).toContain('5m 0s');
    expect(output).toContain('5 completed');
  });

  it('renders sparkline after feeding multiple token samples', () => {
    const snapshot = makeEmptySnapshot();
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });

    // Feed multiple samples with varying token counts
    for (let i = 0; i < 10; i++) {
      dashboard.addTokenSample((i + 1) * 100);
    }

    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    expect(output).toContain('Throughput');
    expect(output).toContain('tok/s');
    // The sparkline should contain block characters
    const sparkline = dashboard.renderSparkline();
    expect(sparkline.length).toBeGreaterThan(0);
    // Verify at least one block character is present
    const blockChars = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
    const hasBlock = blockChars.some(ch => sparkline.includes(ch));
    expect(hasBlock).toBe(true);
  });

  it('handles large numbers formatting without overflow', () => {
    const snapshot: OrchestratorSnapshot = {
      ...makeEmptySnapshot(),
      running: [
        makeRunningEntry({
          identifier: 'MT-999',
          tokenUsage: makeTokenUsage(2_500_000),
          runtimeSeconds: 7200,
        }),
      ],
      totals: { inputTokens: 5_000_000, outputTokens: 3_000_000, totalTokens: 8_000_000, secondsRunning: 36000 },
      completed: 150,
    };
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });
    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    // Verify millions formatting
    expect(output).toContain('8.00M');
    expect(output).toContain('2.50M');
    // Verify hours formatting
    expect(output).toContain('10h 0m');
    expect(output).toContain('2h 0m');
    expect(output).toContain('150 completed');
    // Verify no raw large numbers leak through unformatted
    expect(output).not.toContain('8000000');
    expect(output).not.toContain('2500000');
  });

  it('renders all section headers with full snapshot', () => {
    const snapshot: OrchestratorSnapshot = {
      running: [
        makeRunningEntry({ identifier: 'MT-10' }),
      ],
      retrying: [
        makeRetryEntry({ identifier: 'MT-20' }),
      ],
      completed: 3,
      totals: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, secondsRunning: 60 },
      polling: { intervalMs: 30000, nextPollInMs: 10000 },
    };
    const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });

    // Feed samples so throughput section appears
    for (let i = 0; i < 5; i++) {
      dashboard.addTokenSample(200);
    }

    const output = stripAnsi(dashboard.renderSnapshot(snapshot));

    // Header
    expect(output).toContain('hatice');
    expect(output).toContain('Issue Orchestration Dashboard');
    // Running section
    expect(output).toContain('Running Agents');
    expect(output).toContain('ID');
    expect(output).toContain('State');
    expect(output).toContain('Age');
    expect(output).toContain('Tokens');
    expect(output).toContain('Event');
    // Retry section
    expect(output).toContain('Retry Queue');
    // Throughput section
    expect(output).toContain('Throughput');
    // Polling info
    expect(output).toContain('Next poll in');
  });
});
