import { describe, it, expect } from 'vitest';
import { renderLiveDashboard, stateBadgeClass } from '../src/dashboard-template.js';
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
    expect(html).toContain('<body');
    expect(html).toContain('</body>');
  });

  it('contains hatice branding', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('hatice');
    expect(html).toContain('font-display');
    expect(html).toContain('autonomous agent orchestrator');
  });

  it('includes Tailwind CSS via CDN', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('cdn.tailwindcss.com');
    expect(html).toContain('tailwind.config');
  });

  it('includes Google Fonts', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('fonts.googleapis.com');
    expect(html).toContain('DM+Sans');
    expect(html).toContain('Instrument+Serif');
    expect(html).toContain('JetBrains+Mono');
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
    const tbodyMatch = html.match(/id="running-tbody"[^>]*>([\s\S]*?)<\/tbody>/);
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
    const rtbodyMatch = html.match(/id="retry-tbody"[^>]*>([\s\S]*?)<\/tbody>/);
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
    // Token values present (check element IDs exist — locale formatting varies)
    expect(html).toMatch(/id="tok-input"[^>]*>[^<]*\d/);
    expect(html).toMatch(/id="tok-output"[^>]*>[^<]*\d/);
    expect(html).toMatch(/id="tok-total"[^>]*>[^<]*\d/);
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
    expect(html).toContain('live');
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

  it('escapes HTML in retry error messages', () => {
    const entry = makeRetryEntry({ lastError: '<img onerror="alert(1)" src=x>' });
    const html = renderLiveDashboard(makeSnapshot({ retrying: [entry] }));
    expect(html).not.toContain('<img onerror="alert(1)"');
    expect(html).toContain('&lt;img onerror=');
  });

  it('uses Tailwind design token colors in config', () => {
    const html = renderLiveDashboard(makeSnapshot());
    // Custom color palettes defined in tailwind.config
    expect(html).toContain("sand:");
    expect(html).toContain("clay:");
    expect(html).toContain("ember:");
    expect(html).toContain("sage:");
  });

  it('renders table headers for running agents', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('Identifier');
    expect(html).toContain('State');
    expect(html).toContain('Age');
    expect(html).toContain('Tokens');
    expect(html).toContain('Last Event');
  });

  it('renders table headers for retry queue', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('Attempt');
    expect(html).toContain('Next Retry');
    expect(html).toContain('Last Error');
  });

  it('renders Token Usage section', () => {
    const html = renderLiveDashboard(makeSnapshot());
    expect(html).toContain('Token Usage');
    expect(html).toContain('id="token-grid"');
    expect(html).toContain('id="tok-input"');
    expect(html).toContain('id="tok-output"');
    expect(html).toContain('id="tok-total"');
    expect(html).toContain('id="tok-cache-read"');
    expect(html).toContain('id="tok-cache-create"');
    expect(html).toContain('id="tok-cost"');
  });

  it('renders uptime from totals.secondsRunning', () => {
    const html = renderLiveDashboard(makeSnapshot({
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 3661 },
    }));
    expect(html).toContain('1h 1m 1s');
  });
});

describe('stateBadgeClass', () => {
  it('returns rose classes for error state', () => {
    expect(stateBadgeClass('error')).toContain('bg-rose-50');
    expect(stateBadgeClass('error')).toContain('text-rose-600');
  });

  it('returns rose classes for failed state', () => {
    expect(stateBadgeClass('failed')).toContain('bg-rose-50');
    expect(stateBadgeClass('failed')).toContain('text-rose-600');
  });

  it('returns amber classes for waiting state', () => {
    expect(stateBadgeClass('waiting')).toContain('bg-amber-50');
    expect(stateBadgeClass('waiting')).toContain('text-amber-600');
  });

  it('returns amber classes for stalled state', () => {
    expect(stateBadgeClass('stalled')).toContain('bg-amber-50');
    expect(stateBadgeClass('stalled')).toContain('text-amber-600');
  });

  it('returns emerald classes for done state', () => {
    expect(stateBadgeClass('done')).toContain('bg-emerald-50');
    expect(stateBadgeClass('done')).toContain('text-emerald-600');
  });

  it('returns emerald classes for completed state', () => {
    expect(stateBadgeClass('completed')).toContain('bg-emerald-50');
    expect(stateBadgeClass('completed')).toContain('text-emerald-600');
  });

  it('returns ember classes for default/running state', () => {
    expect(stateBadgeClass('running')).toContain('bg-ember-50');
    expect(stateBadgeClass('running')).toContain('text-ember-600');
  });

  it('returns ember classes for unknown states', () => {
    expect(stateBadgeClass('coding')).toContain('bg-ember-50');
    expect(stateBadgeClass('whatever')).toContain('bg-ember-50');
  });
});
