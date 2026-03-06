import { describe, it, expect } from 'vitest';
import { renderLiveDashboard } from '../src/dashboard-template.js';
import type { OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry, TokenUsage } from '../src/types.js';

function makeTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

function makeRunningEntry(overrides: Partial<SnapshotRunningEntry> = {}): SnapshotRunningEntry {
  return {
    issueId: 'issue-1',
    identifier: 'MT-101',
    state: 'running',
    sessionId: 'sess-abc',
    attempt: 1,
    runtimeSeconds: 120,
    tokenUsage: makeTokenUsage({ inputTokens: 500, outputTokens: 200, totalTokens: 700, costUsd: 0.0042 }),
    lastEvent: 'tool:execute',
    lastEventAt: new Date('2026-03-07T10:00:00Z'),
    ...overrides,
  };
}

function makeRetryEntry(overrides: Partial<SnapshotRetryEntry> = {}): SnapshotRetryEntry {
  return {
    issueId: 'issue-2',
    identifier: 'MT-202',
    attempt: 3,
    nextRetryInMs: 15000,
    lastError: 'Rate limit exceeded',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    running: [],
    retrying: [],
    completed: 0,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    polling: {
      intervalMs: 30000,
      nextPollInMs: 12000,
    },
    ...overrides,
  };
}

describe('renderLiveDashboard', () => {
  it('renders valid HTML with DOCTYPE', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
  });

  it('contains hatice branding', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('hatice');
    expect(html).toContain('class="hero-title"');
    expect(html).toContain('autonomous agent orchestrator');
  });

  it('contains EventSource script', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('EventSource');
    expect(html).toContain("new EventSource('/api/v1/events')");
    expect(html).toContain("'state:updated'");
    expect(html).toContain('/api/v1/state');
  });

  it('renders running entries in table', () => {
    const entry = makeRunningEntry({ identifier: 'MT-101', state: 'running', runtimeSeconds: 65.3 });
    const html = renderLiveDashboard(makeSnapshot({ running: [entry] }));

    expect(html).toContain('MT-101');
    expect(html).toContain('running');
    expect(html).toContain('65s'); // runtimeSeconds.toFixed(0)
    expect(html).toContain('700'); // totalTokens
    expect(html).toContain('tool:execute'); // lastEvent
    // The server-rendered tbody should contain the entry, not the empty placeholder
    const tbodyMatch = html.match(/id="running-tbody">([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    expect(tbodyMatch![1]).toContain('MT-101');
    expect(tbodyMatch![1]).not.toContain('No agents running');
  });

  it('renders multiple running entries', () => {
    const entries = [
      makeRunningEntry({ identifier: 'MT-101' }),
      makeRunningEntry({ identifier: 'MT-102', issueId: 'issue-x' }),
    ];
    const html = renderLiveDashboard(makeSnapshot({ running: entries }));
    expect(html).toContain('MT-101');
    expect(html).toContain('MT-102');
  });

  it('renders empty state for running agents', () => {
    const html = renderLiveDashboard(makeSnapshot({ running: [] }));
    expect(html).toContain('No agents running');
  });

  it('renders retry entries', () => {
    const entry = makeRetryEntry({ identifier: 'MT-202', attempt: 3, nextRetryInMs: 15000, lastError: 'Rate limit exceeded' });
    const html = renderLiveDashboard(makeSnapshot({ retrying: [entry] }));

    expect(html).toContain('MT-202');
    expect(html).toContain('3'); // attempt
    expect(html).toContain('15.0s'); // nextRetryInMs / 1000
    expect(html).toContain('Rate limit exceeded');
    // Check the server-rendered retry tbody specifically (JS fallback code also contains the empty string)
    const rtbodyMatch = html.match(/id="retry-tbody">([\s\S]*?)<\/tbody>/);
    expect(rtbodyMatch).not.toBeNull();
    expect(rtbodyMatch![1]).toContain('MT-202');
    expect(rtbodyMatch![1]).not.toContain('No retries pending');
  });

  it('renders empty state for retry queue', () => {
    const html = renderLiveDashboard(makeSnapshot({ retrying: [] }));
    expect(html).toContain('No retries pending');
  });

  it('renders token totals', () => {
    const html = renderLiveDashboard(makeSnapshot({
      totals: {
        inputTokens: 15000,
        outputTokens: 8000,
        totalTokens: 23000,
        secondsRunning: 3661,
      },
    }));

    // Token values present (formatted with locale)
    expect(html).toContain('id="tok-input"');
    expect(html).toContain('id="tok-output"');
    expect(html).toContain('id="tok-total"');
    expect(html).toContain('15,000'); // inputTokens formatted
    expect(html).toContain('8,000');  // outputTokens formatted
    expect(html).toContain('23,000'); // totalTokens formatted
  });

  it('renders cost from running entries', () => {
    const entry = makeRunningEntry({ tokenUsage: makeTokenUsage({ costUsd: 1.2345, totalTokens: 5000 }) });
    const html = renderLiveDashboard(makeSnapshot({ running: [entry] }));
    expect(html).toContain('$1.2345');
  });

  it('renders polling information', () => {
    const html = renderLiveDashboard(makeSnapshot({
      polling: { intervalMs: 60000, nextPollInMs: 45000 },
    }));
    expect(html).toContain('60s');   // intervalMs
    expect(html).toContain('45.0s'); // nextPollInMs
  });

  it('renders status badge', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('status-badge');
    expect(html).toContain('status-live');
  });

  it('renders rate limit indicator', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('rate-limit-dot');
    expect(html).toContain('Rate limit');
  });

  it('includes noscript meta-refresh fallback', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('<noscript>');
    expect(html).toContain('meta http-equiv="refresh" content="5"');
  });

  it('escapes HTML in identifiers to prevent XSS', () => {
    const entry = makeRunningEntry({ identifier: '<script>alert("xss")</script>' });
    const html = renderLiveDashboard(makeSnapshot({ running: [entry] }));
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes all required CSS color values inline', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('#0d1117'); // background
    expect(html).toContain('#c9d1d9'); // text
    expect(html).toContain('#58a6ff'); // accent
    expect(html).toContain('#3fb950'); // success
    expect(html).toContain('#d29922'); // warning
    expect(html).toContain('#f85149'); // error
  });

  it('uses no external dependencies', () => {
    const html = renderLiveDashboard(makeSnapshot());
    // No link tags for external CSS
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+href="http/);
    // No external script tags
    expect(html).not.toMatch(/<script[^>]+src="http/);
  });
});
