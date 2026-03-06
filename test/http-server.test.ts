import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpServer } from '../src/http-server.js';
import { EventBus } from '../src/event-bus.js';
import type { OrchestratorSnapshot, SnapshotRunningEntry, SnapshotRetryEntry, haticeEvents } from '../src/types.js';

function createMockOrchestrator(snapshot: OrchestratorSnapshot) {
  return {
    getState: () => ({
      snapshot: () => snapshot,
    }),
    refresh: async () => {},
  };
}

const emptySnapshot: OrchestratorSnapshot = {
  running: [],
  retrying: [],
  completed: 0,
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  polling: { intervalMs: 30000, nextPollInMs: 15000 },
};

describe('HttpServer', () => {
  let server: HttpServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('GET /api/v1/state returns snapshot JSON with 200', async () => {
    const snapshot: OrchestratorSnapshot = {
      ...emptySnapshot,
      completed: 5,
      totals: { inputTokens: 100, outputTokens: 200, totalTokens: 300, secondsRunning: 60 },
    };
    server = new HttpServer(createMockOrchestrator(snapshot), 0);
    const app = server.getApp();

    const res = await app.request('/api/v1/state');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(5);
    expect(body.totals.totalTokens).toBe(300);
    expect(body.running).toEqual([]);
    expect(body.retrying).toEqual([]);
  });

  it('GET /api/v1/:id returns running entry when found', async () => {
    const runningEntry: SnapshotRunningEntry = {
      issueId: 'issue-1',
      identifier: 'MT-101',
      state: 'In Progress',
      sessionId: 'sess-abc',
      attempt: 1,
      runtimeSeconds: 42,
      tokenUsage: {
        inputTokens: 50, outputTokens: 80, totalTokens: 130,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0,
      },
      lastEvent: 'tool_use',
      lastEventAt: null,
    };
    const snapshot: OrchestratorSnapshot = { ...emptySnapshot, running: [runningEntry] };
    server = new HttpServer(createMockOrchestrator(snapshot), 0);

    const res = await server.getApp().request('/api/v1/issue-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issueId).toBe('issue-1');
    expect(body.identifier).toBe('MT-101');
  });

  it('GET /api/v1/:id returns retrying entry when found', async () => {
    const retryEntry: SnapshotRetryEntry = {
      issueId: 'issue-2', identifier: 'MT-102', attempt: 3, nextRetryInMs: 5000, lastError: 'timeout',
    };
    const snapshot: OrchestratorSnapshot = { ...emptySnapshot, retrying: [retryEntry] };
    server = new HttpServer(createMockOrchestrator(snapshot), 0);

    const res = await server.getApp().request('/api/v1/issue-2');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issueId).toBe('issue-2');
    expect(body.attempt).toBe(3);
  });

  it('GET /api/v1/:id returns 404 when not found', async () => {
    server = new HttpServer(createMockOrchestrator(emptySnapshot), 0);

    const res = await server.getApp().request('/api/v1/nonexistent');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Issue not found');
  });

  it('POST /api/v1/refresh triggers refresh', async () => {
    let refreshCalled = false;
    const mock = createMockOrchestrator(emptySnapshot);
    mock.refresh = async () => { refreshCalled = true; };
    server = new HttpServer(mock, 0);

    const res = await server.getApp().request('/api/v1/refresh', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(refreshCalled).toBe(true);
  });

  it('GET / returns HTML dashboard', async () => {
    const snapshot: OrchestratorSnapshot = {
      ...emptySnapshot,
      completed: 3,
      running: [{
        issueId: 'issue-1', identifier: 'MT-101', state: 'In Progress', sessionId: null,
        attempt: 1, runtimeSeconds: 120,
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 },
        lastEvent: 'tool_use', lastEventAt: null,
      }],
    };
    server = new HttpServer(createMockOrchestrator(snapshot), 0);

    const res = await server.getApp().request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('hatice');
    expect(html).toContain('MT-101');
  });

  it('GET /api/v1/state includes secure headers', async () => {
    server = new HttpServer(createMockOrchestrator(emptySnapshot), 0);

    const res = await server.getApp().request('/api/v1/state');

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('POST /api/v1/refresh includes secure headers', async () => {
    server = new HttpServer(createMockOrchestrator(emptySnapshot), 0);

    const res = await server.getApp().request('/api/v1/refresh', { method: 'POST' });

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('server starts and stops cleanly', async () => {
    server = new HttpServer(createMockOrchestrator(emptySnapshot), 4199);
    await server.start();
    await server.stop();
  });

  it('GET /api/v1/events returns SSE content-type', async () => {
    const eventBus = new EventBus<haticeEvents>();
    server = new HttpServer(createMockOrchestrator(emptySnapshot), 0, '127.0.0.1', eventBus);
    const app = server.getApp();

    const res = await app.request('/api/v1/events');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
  });

  it('GET /api/v1/state returns 503 on snapshot timeout', async () => {
    const originalTimeout = HttpServer.SNAPSHOT_TIMEOUT_MS;
    HttpServer.SNAPSHOT_TIMEOUT_MS = 100; // Use 100ms for fast test

    try {
      const mock = {
        getState: () => ({
          snapshot: () => new Promise<never>(() => {}), // never resolves
        }),
        refresh: async () => {},
      };
      server = new HttpServer(mock as any, 0);
      const app = server.getApp();

      const res = await app.request('/api/v1/state');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('Snapshot timeout');
    } finally {
      HttpServer.SNAPSHOT_TIMEOUT_MS = originalTimeout;
    }
  });

  it('SSE endpoint sends event data', async () => {
    const eventBus = new EventBus<haticeEvents>();
    server = new HttpServer(createMockOrchestrator(emptySnapshot), 0, '127.0.0.1', eventBus);
    const app = server.getApp();

    const res = await app.request('/api/v1/events');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Emit an event after a small delay to allow the stream to be set up
    setTimeout(() => {
      eventBus.emit('issue:dispatched', 'issue-1', 'MT-101');
    }, 50);

    const { value } = await reader.read();
    const text = decoder.decode(value);

    expect(text).toContain('event: issue:dispatched');
    expect(text).toContain('"issue-1"');
    expect(text).toContain('"MT-101"');

    reader.releaseLock();
  });
});
