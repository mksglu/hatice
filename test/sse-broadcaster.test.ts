import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SSEBroadcaster } from '../src/sse-broadcaster.js';

/**
 * Helper: creates a mock WritableStreamDefaultWriter that captures written chunks.
 */
function createMockWriter() {
  const chunks: string[] = [];
  let closed = false;
  const writer: WritableStreamDefaultWriter = {
    write: vi.fn(async (chunk: string) => {
      chunks.push(chunk);
    }),
    close: vi.fn(async () => {
      closed = true;
    }),
    abort: vi.fn(),
    releaseLock: vi.fn(),
    get ready() {
      return Promise.resolve(undefined);
    },
    get desiredSize() {
      return 1;
    },
    get closed() {
      return closed ? Promise.resolve(undefined) : new Promise<undefined>(() => {});
    },
  } as unknown as WritableStreamDefaultWriter;

  return { writer, chunks };
}

describe('SSEBroadcaster', () => {
  let broadcaster: SSEBroadcaster;

  beforeEach(() => {
    broadcaster = new SSEBroadcaster();
  });

  it('broadcast sends JSON data to all connected clients', async () => {
    const client1 = createMockWriter();
    const client2 = createMockWriter();

    broadcaster.addClient('c1', client1.writer);
    broadcaster.addClient('c2', client2.writer);

    broadcaster.broadcast('state-update', { running: 3, completed: 7 });

    // Allow microtasks to flush
    await vi.waitFor(() => {
      expect(client1.chunks.length).toBeGreaterThan(0);
      expect(client2.chunks.length).toBeGreaterThan(0);
    });

    const expected = 'event: state-update\ndata: {"running":3,"completed":7}\n\n';
    expect(client1.chunks).toContain(expected);
    expect(client2.chunks).toContain(expected);
  });

  it('removeClient stops sending to disconnected client', async () => {
    const client1 = createMockWriter();
    const client2 = createMockWriter();

    broadcaster.addClient('c1', client1.writer);
    broadcaster.addClient('c2', client2.writer);

    broadcaster.removeClient('c1');

    broadcaster.broadcast('update', { value: 42 });

    await vi.waitFor(() => {
      expect(client2.chunks.length).toBeGreaterThan(0);
    });

    expect(client1.chunks).toHaveLength(0);
    expect(client2.chunks).toContain('event: update\ndata: {"value":42}\n\n');
  });

  it('getClientCount reflects connected clients', () => {
    expect(broadcaster.getClientCount()).toBe(0);

    broadcaster.addClient('c1', createMockWriter().writer);
    expect(broadcaster.getClientCount()).toBe(1);

    broadcaster.addClient('c2', createMockWriter().writer);
    expect(broadcaster.getClientCount()).toBe(2);

    broadcaster.removeClient('c1');
    expect(broadcaster.getClientCount()).toBe(1);

    broadcaster.removeClient('c2');
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it('handles client write errors gracefully (auto-removes dead clients)', async () => {
    const healthy = createMockWriter();
    const dead = createMockWriter();

    // Make the dead client's write throw
    (dead.writer.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection reset'));

    broadcaster.addClient('healthy', healthy.writer);
    broadcaster.addClient('dead', dead.writer);

    expect(broadcaster.getClientCount()).toBe(2);

    broadcaster.broadcast('ping', { ts: 1 });

    // Wait for async error handling to auto-remove dead client
    await vi.waitFor(() => {
      expect(broadcaster.getClientCount()).toBe(1);
    });

    // Healthy client still received the message
    expect(healthy.chunks).toContain('event: ping\ndata: {"ts":1}\n\n');
  });

  it('removing a non-existent client is a no-op', () => {
    expect(() => broadcaster.removeClient('nonexistent')).not.toThrow();
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it('replacing a client with the same id updates the writer', async () => {
    const first = createMockWriter();
    const second = createMockWriter();

    broadcaster.addClient('c1', first.writer);
    broadcaster.addClient('c1', second.writer);

    expect(broadcaster.getClientCount()).toBe(1);

    broadcaster.broadcast('test', { v: 1 });

    await vi.waitFor(() => {
      expect(second.chunks.length).toBeGreaterThan(0);
    });

    // Only the second writer should have received the message
    expect(first.chunks).toHaveLength(0);
    expect(second.chunks).toContain('event: test\ndata: {"v":1}\n\n');
  });
});
