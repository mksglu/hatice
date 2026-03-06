import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEBroadcaster } from '../src/sse-broadcaster.js';
import { EventBus } from '../src/event-bus.js';
import { HttpServer } from '../src/http-server.js';
import type { haticeEvents, OrchestratorSnapshot } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a WritableStreamDefaultWriter that captures everything written. */
function createMockWriter(): {
  writer: WritableStreamDefaultWriter;
  chunks: string[];
  closed: boolean;
} {
  const chunks: string[] = [];
  let closed = false;
  const stream = new WritableStream<string>({
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      closed = true;
    },
  });
  const writer = stream.getWriter();
  return { writer, chunks, get closed() { return closed; } };
}

/** Writer whose write() always rejects — simulates a dead client. */
function createFailingWriter(): WritableStreamDefaultWriter {
  const stream = new WritableStream<string>({
    write() {
      throw new Error('connection reset');
    },
  });
  return stream.getWriter();
}

function createMockOrchestrator(snapshot?: Partial<OrchestratorSnapshot>) {
  const full: OrchestratorSnapshot = {
    running: [],
    retrying: [],
    completed: 0,
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    polling: { intervalMs: 30000, nextPollInMs: 15000 },
    ...snapshot,
  };
  return {
    getState: () => ({ snapshot: () => full }),
    refresh: async () => {},
  };
}

// ---------------------------------------------------------------------------
// SSEBroadcaster unit tests
// ---------------------------------------------------------------------------

describe('SSEBroadcaster', () => {
  let broadcaster: SSEBroadcaster;

  beforeEach(() => {
    broadcaster = new SSEBroadcaster();
  });

  it('creates a readable stream via addClient / getClientCount', () => {
    expect(broadcaster.getClientCount()).toBe(0);

    const { writer } = createMockWriter();
    broadcaster.addClient('client-1', writer);

    expect(broadcaster.getClientCount()).toBe(1);
  });

  it('forwards events in correct SSE format: event: <type>\\ndata: <json>\\n\\n', async () => {
    const { writer, chunks } = createMockWriter();
    broadcaster.addClient('client-1', writer);

    const payload = { issueId: 'ISS-1', status: 'running' };
    broadcaster.broadcast('issue:dispatched', payload);

    // Allow microtask queue to flush (writer.write returns a promise)
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));

    const message = chunks[0];
    expect(message).toBe(
      `event: issue:dispatched\ndata: ${JSON.stringify(payload)}\n\n`,
    );
  });

  it('multiple subscribers receive the same event', async () => {
    const sub1 = createMockWriter();
    const sub2 = createMockWriter();
    const sub3 = createMockWriter();

    broadcaster.addClient('a', sub1.writer);
    broadcaster.addClient('b', sub2.writer);
    broadcaster.addClient('c', sub3.writer);

    expect(broadcaster.getClientCount()).toBe(3);

    broadcaster.broadcast('state:updated', null);

    await vi.waitFor(() => expect(sub1.chunks.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(sub2.chunks.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(sub3.chunks.length).toBeGreaterThan(0));

    const expected = 'event: state:updated\ndata: null\n\n';
    expect(sub1.chunks[0]).toBe(expected);
    expect(sub2.chunks[0]).toBe(expected);
    expect(sub3.chunks[0]).toBe(expected);
  });

  it('handles subscriber disconnect gracefully by removing dead clients', async () => {
    const good = createMockWriter();
    const bad = createFailingWriter();

    broadcaster.addClient('good', good.writer);
    broadcaster.addClient('bad', bad);

    expect(broadcaster.getClientCount()).toBe(2);

    broadcaster.broadcast('tick:start', {});

    // The failing writer's promise rejection triggers removal asynchronously
    await vi.waitFor(() => expect(broadcaster.getClientCount()).toBe(1));

    // Good client still received the message
    expect(good.chunks.length).toBe(1);
  });

  it('removeClient removes a specific client', () => {
    const { writer } = createMockWriter();
    broadcaster.addClient('x', writer);
    expect(broadcaster.getClientCount()).toBe(1);

    broadcaster.removeClient('x');
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it('removeClient is a no-op for unknown ids', () => {
    broadcaster.removeClient('nonexistent');
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it('replacing a client id overwrites the previous writer', async () => {
    const first = createMockWriter();
    const second = createMockWriter();

    broadcaster.addClient('dup', first.writer);
    broadcaster.addClient('dup', second.writer);

    expect(broadcaster.getClientCount()).toBe(1);

    broadcaster.broadcast('test', 'hello');

    await vi.waitFor(() => expect(second.chunks.length).toBeGreaterThan(0));
    // Only the second writer should receive the message
    expect(second.chunks[0]).toContain('event: test');
    expect(first.chunks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EventBus → SSEBroadcaster integration
// ---------------------------------------------------------------------------

describe('EventBus → SSEBroadcaster integration', () => {
  it('EventBus events are forwarded to SSEBroadcaster clients', async () => {
    const eventBus = new EventBus<haticeEvents>();
    const broadcaster = new SSEBroadcaster();

    // Wire onAny → broadcast (same pattern as HttpServer constructor)
    eventBus.onAny((event: string, ...args: unknown[]) => {
      broadcaster.broadcast(event, args);
    });

    const { writer, chunks } = createMockWriter();
    broadcaster.addClient('subscriber', writer);

    eventBus.emit('issue:dispatched', 'ISS-42', 'MT-42');

    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));

    const msg = chunks[0];
    expect(msg).toMatch(/^event: issue:dispatched\n/);
    expect(msg).toContain('"ISS-42"');
    expect(msg).toContain('"MT-42"');
    expect(msg).toMatch(/\n\n$/);
  });

  it('multiple event types are forwarded correctly', async () => {
    const eventBus = new EventBus<haticeEvents>();
    const broadcaster = new SSEBroadcaster();

    eventBus.onAny((event: string, ...args: unknown[]) => {
      broadcaster.broadcast(event, args);
    });

    const { writer, chunks } = createMockWriter();
    broadcaster.addClient('sub', writer);

    eventBus.emit('tick:start');
    eventBus.emit('issue:dispatched', 'id-1', 'MT-1');
    eventBus.emit('tick:end', 2);

    await vi.waitFor(() => expect(chunks.length).toBe(3));

    expect(chunks[0]).toMatch(/^event: tick:start\n/);
    expect(chunks[1]).toMatch(/^event: issue:dispatched\n/);
    expect(chunks[2]).toMatch(/^event: tick:end\n/);
    expect(chunks[2]).toContain('2');
  });
});

// ---------------------------------------------------------------------------
// HTTP SSE endpoint integration
// ---------------------------------------------------------------------------

describe('GET /api/v1/events SSE endpoint', () => {
  let server: HttpServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('returns correct SSE headers', async () => {
    const eventBus = new EventBus<haticeEvents>();
    server = new HttpServer(createMockOrchestrator(), 0, '127.0.0.1', eventBus);

    const res = await server.getApp().request('/api/v1/events');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
  });

  it('streams EventBus events as SSE messages', async () => {
    const eventBus = new EventBus<haticeEvents>();
    server = new HttpServer(createMockOrchestrator(), 0, '127.0.0.1', eventBus);

    const res = await server.getApp().request('/api/v1/events');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    setTimeout(() => {
      eventBus.emit('issue:dispatched', 'issue-99', 'MT-99');
    }, 50);

    const { value } = await reader.read();
    const text = decoder.decode(value);

    expect(text).toContain('event: issue:dispatched');
    expect(text).toContain('"issue-99"');
    expect(text).toContain('"MT-99"');

    reader.releaseLock();
  });

  it('without eventBus, /api/v1/events returns 404', async () => {
    server = new HttpServer(createMockOrchestrator(), 0);

    const res = await server.getApp().request('/api/v1/events');

    // Without eventBus the SSE route is not registered, so Hono returns 404
    expect(res.status).toBe(404);
  });
});
