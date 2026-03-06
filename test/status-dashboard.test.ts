import { describe, it, expect } from 'vitest';
import { StatusDashboard } from '../src/status-dashboard.js';
import type { OrchestratorSnapshot } from '../src/types.js';
import { emptyTokenUsage, emptyAggregateTotals } from '../src/types.js';
import { RateLimitTracker } from '../src/rate-limiter.js';

function makeSnapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    running: [],
    retrying: [],
    completed: 0,
    totals: emptyAggregateTotals(),
    polling: { intervalMs: 30_000, nextPollInMs: 15_000 },
    ...overrides,
  };
}

describe('StatusDashboard', () => {
  describe('formatDuration', () => {
    it('formats seconds under a minute', () => {
      expect(StatusDashboard.formatDuration(0)).toBe('0s');
      expect(StatusDashboard.formatDuration(45)).toBe('45s');
      expect(StatusDashboard.formatDuration(59.9)).toBe('59s');
    });

    it('formats minutes and seconds', () => {
      expect(StatusDashboard.formatDuration(60)).toBe('1m 0s');
      expect(StatusDashboard.formatDuration(83)).toBe('1m 23s');
      expect(StatusDashboard.formatDuration(3599)).toBe('59m 59s');
    });

    it('formats hours and minutes', () => {
      expect(StatusDashboard.formatDuration(3600)).toBe('1h 0m');
      expect(StatusDashboard.formatDuration(4980)).toBe('1h 23m');
      expect(StatusDashboard.formatDuration(7200)).toBe('2h 0m');
    });
  });

  describe('formatTokens', () => {
    it('formats small numbers as-is', () => {
      expect(StatusDashboard.formatTokens(0)).toBe('0');
      expect(StatusDashboard.formatTokens(999)).toBe('999');
    });

    it('formats thousands with K suffix', () => {
      expect(StatusDashboard.formatTokens(1000)).toBe('1.0K');
      expect(StatusDashboard.formatTokens(1500)).toBe('1.5K');
      expect(StatusDashboard.formatTokens(999_999)).toBe('1000.0K');
    });

    it('formats millions with M suffix', () => {
      expect(StatusDashboard.formatTokens(1_000_000)).toBe('1.00M');
      expect(StatusDashboard.formatTokens(2_500_000)).toBe('2.50M');
    });
  });

  describe('renderSparkline', () => {
    it('returns empty string when no samples exist', () => {
      const dashboard = new StatusDashboard(() => makeSnapshot(), { renderFn: () => {} });
      expect(dashboard.renderSparkline()).toBe('');
    });

    it('renders non-empty sparkline after adding samples', () => {
      const dashboard = new StatusDashboard(() => makeSnapshot(), { renderFn: () => {} });
      // Add a sample at "now"
      dashboard.addTokenSample(1000);
      const sparkline = dashboard.renderSparkline();
      expect(sparkline.length).toBe(25); // graphWidth
      // The rightmost bucket should have a non-space block character
      expect(sparkline[sparkline.length - 1]).not.toBe(' ');
    });
  });

  describe('renderSnapshot', () => {
    it('produces an ANSI string with header, stats, and polling info', () => {
      const snapshot = makeSnapshot({
        running: [
          {
            issueId: 'issue-1',
            identifier: 'MT-42',
            state: 'In Progress',
            sessionId: null,
            attempt: 1,
            runtimeSeconds: 123,
            tokenUsage: { ...emptyTokenUsage(), totalTokens: 15_000 },
            lastEvent: 'tool_use',
            lastEventAt: new Date(),
          },
        ],
        retrying: [
          {
            issueId: 'issue-2',
            identifier: 'MT-99',
            attempt: 3,
            nextRetryInMs: 30_000,
            lastError: 'rate_limit_exceeded',
          },
        ],
        completed: 5,
        totals: { inputTokens: 10_000, outputTokens: 5_000, totalTokens: 150_000, secondsRunning: 4980 },
      });

      const dashboard = new StatusDashboard(() => snapshot, { renderFn: () => {} });
      // Add a sample so throughput sparkline renders
      dashboard.addTokenSample(500);
      const output = dashboard.renderSnapshot(snapshot);

      // Verify key sections exist
      expect(output).toContain('hatice');
      expect(output).toContain('running');
      expect(output).toContain('completed');
      expect(output).toContain('Running Agents');
      expect(output).toContain('MT-42');
      expect(output).toContain('15.0K');
      expect(output).toContain('Retry Queue');
      expect(output).toContain('MT-99');
      expect(output).toContain('attempt #3');
      expect(output).toContain('rate_limit_exceeded');
      expect(output).toContain('Throughput');
      expect(output).toContain('tok/s');
      expect(output).toContain('Next poll in');
    });
  });

  describe('calcThroughput', () => {
    it('returns 0 when no samples exist', () => {
      const dashboard = new StatusDashboard(() => makeSnapshot(), { renderFn: () => {} });
      expect(dashboard.calcThroughput()).toBe(0);
    });

    it('calculates tokens per second from recent samples', () => {
      const dashboard = new StatusDashboard(() => makeSnapshot(), { renderFn: () => {} });
      // Add samples within the 5s window
      dashboard.addTokenSample(2500);
      dashboard.addTokenSample(2500);
      // 5000 tokens in a 5s window = 1000 tok/s
      const tps = dashboard.calcThroughput();
      expect(tps).toBe(1000);
    });
  });

  describe('rate limit display', () => {
    it('renders rate limit section when RateLimitTracker is provided', () => {
      const tracker = new RateLimitTracker();
      const dashboard = new StatusDashboard(() => makeSnapshot(), {
        renderFn: () => {},
        rateLimitTracker: tracker,
      });
      const output = dashboard.renderSnapshot(makeSnapshot());
      expect(output).toContain('Rate Limit Status');
    });

    it('shows rate limited state correctly', () => {
      const tracker = new RateLimitTracker();
      tracker.recordLimit('anthropic', 30_000);
      const dashboard = new StatusDashboard(() => makeSnapshot(), {
        renderFn: () => {},
        rateLimitTracker: tracker,
      });
      const output = dashboard.renderSnapshot(makeSnapshot());
      expect(output).toContain('RATE LIMITED');
      expect(output).toContain('anthropic');
      expect(output).toContain('retry');
    });

    it('shows OK state when not rate limited', () => {
      const tracker = new RateLimitTracker();
      // No limits recorded — everything is OK
      const dashboard = new StatusDashboard(() => makeSnapshot(), {
        renderFn: () => {},
        rateLimitTracker: tracker,
      });
      const output = dashboard.renderSnapshot(makeSnapshot());
      expect(output).toContain('Rate Limit Status');
      expect(output).toContain('OK');
    });

    it('renders without rate limiter (backward compatible)', () => {
      const dashboard = new StatusDashboard(() => makeSnapshot(), {
        renderFn: () => {},
      });
      const output = dashboard.renderSnapshot(makeSnapshot());
      expect(output).not.toContain('Rate Limit Status');
      // Should still render the rest of the dashboard fine
      expect(output).toContain('hatice');
      expect(output).toContain('Next poll in');
    });
  });
});
