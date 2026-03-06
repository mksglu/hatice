import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withTimeout, withTimeoutSync, TimeoutError } from '../src/snapshot-timeout.js';

describe('SnapshotTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain any dangling timers (e.g. the inner fn setTimeout that lost the race)
    // before restoring real timers, to avoid PromiseRejectionHandledWarning.
    vi.runAllTimers();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // withTimeout
  // ---------------------------------------------------------------------------
  describe('withTimeout', () => {
    it('resolves when fn completes before timeout', async () => {
      const result = withTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'snapshot-data';
        },
        5_000,
      );

      // Flush microtasks so fn() begins executing, then advance timers
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBe('snapshot-data');
    });

    it('throws TimeoutError when fn exceeds timeout', async () => {
      const result = withTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return 'never';
        },
        3_000,
      );

      // Attach rejection handler BEFORE advancing timers so Node doesn't
      // flag "PromiseRejectionHandledWarning" for async-handled rejection.
      const assertion = expect(result).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    });

    it('TimeoutError contains the timeout duration', async () => {
      const result = withTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return 'never';
        },
        3_000,
      );

      const assertion = expect(result).rejects.toSatisfy((err: TimeoutError) => {
        return err instanceof TimeoutError && err.timeoutMs === 3_000;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    });

    it('returns fallback when provided and fn times out', async () => {
      const fallback = { status: 'stale' };

      const result = withTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return { status: 'fresh' };
        },
        3_000,
        fallback,
      );

      const assertion = expect(result).resolves.toBe(fallback);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    });

    it('cleans up timer on successful completion', async () => {
      const result = withTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return 'done';
        },
        5_000,
      );

      await vi.advanceTimersByTimeAsync(50);
      await result;

      // The timeout timer should have been cleared — only fake-timer internals remain
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves with synchronous fn return value', async () => {
      const result = await withTimeout(() => 42, 5_000);
      expect(result).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // withTimeoutSync
  // ---------------------------------------------------------------------------
  describe('withTimeoutSync', () => {
    it('returns result on success', () => {
      const result = withTimeoutSync(() => 'ok', 1_000, 'fallback');
      expect(result).toBe('ok');
    });

    it('returns fallback on error', () => {
      const result = withTimeoutSync(
        () => {
          throw new Error('boom');
        },
        1_000,
        'fallback',
      );
      expect(result).toBe('fallback');
    });

    it('returns fallback of correct type', () => {
      const fallback = { count: 0 };
      const result = withTimeoutSync<{ count: number }>(
        () => {
          throw new Error('fail');
        },
        1_000,
        fallback,
      );
      expect(result).toBe(fallback);
    });
  });
});
