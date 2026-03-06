import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TurnTimeout, TimeoutError } from '../src/turn-timeout.js';

describe('TurnTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor / initial state
  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('signal is not aborted initially', () => {
      const tt = new TurnTimeout(5_000);
      expect(tt.signal.aborted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------
  describe('start', () => {
    it('aborts signal after timeoutMs', () => {
      const tt = new TurnTimeout(3_000);
      tt.start();

      expect(tt.signal.aborted).toBe(false);

      vi.advanceTimersByTime(2_999);
      expect(tt.signal.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(tt.signal.aborted).toBe(true);
      expect(tt.signal.reason).toBeInstanceOf(TimeoutError);
    });
  });

  // -------------------------------------------------------------------------
  // clear()
  // -------------------------------------------------------------------------
  describe('clear', () => {
    it('prevents abort when called before timeout fires', () => {
      const tt = new TurnTimeout(3_000);
      tt.start();

      vi.advanceTimersByTime(1_000);
      tt.clear();

      vi.advanceTimersByTime(10_000);
      expect(tt.signal.aborted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // withTimeout (static)
  // -------------------------------------------------------------------------
  describe('withTimeout', () => {
    it('resolves if fn completes before timeout', async () => {
      const result = TurnTimeout.withTimeout(
        async (_signal) => {
          await new Promise((r) => setTimeout(r, 100));
          return 'done';
        },
        5_000,
      );

      vi.advanceTimersByTime(100);
      await expect(result).resolves.toBe('done');
    });

    it('rejects with TimeoutError if fn exceeds timeout', async () => {
      const result = TurnTimeout.withTimeout(
        async (_signal) => {
          await new Promise((r) => setTimeout(r, 10_000));
          return 'never';
        },
        3_000,
      );

      vi.advanceTimersByTime(3_000);
      await expect(result).rejects.toThrow(TimeoutError);
    });

    it('respects parent signal abort', async () => {
      const parent = new AbortController();

      const result = TurnTimeout.withTimeout(
        async (_signal) => {
          await new Promise((r) => setTimeout(r, 10_000));
          return 'never';
        },
        30_000,
        parent.signal,
      );

      parent.abort(new Error('parent cancelled'));

      await expect(result).rejects.toThrow('parent cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  describe('cleanup', () => {
    it('no dangling timers after clear', () => {
      const tt = new TurnTimeout(5_000);
      tt.start();
      tt.clear();

      // If clear works properly, getTimerCount should be 0
      // (no pending timers left from TurnTimeout)
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
