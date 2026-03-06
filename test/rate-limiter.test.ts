import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitTracker } from '../src/rate-limiter.js';
import type { RateLimitInfo } from '../src/rate-limiter.js';

describe('RateLimitTracker', () => {
  let tracker: RateLimitTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new RateLimitTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isLimited', () => {
    it('returns false initially for unknown source', () => {
      expect(tracker.isLimited('linear')).toBe(false);
    });

    it('returns false initially for any source', () => {
      expect(tracker.isLimited('github')).toBe(false);
      expect(tracker.isLimited('claude')).toBe(false);
    });
  });

  describe('recordLimit', () => {
    it('marks source as limited', () => {
      tracker.recordLimit('linear', 5000);
      expect(tracker.isLimited('linear')).toBe(true);
    });

    it('does not affect other sources', () => {
      tracker.recordLimit('linear', 5000);
      expect(tracker.isLimited('github')).toBe(false);
    });

    it('tracks retryAfterMs from recordLimit', () => {
      tracker.recordLimit('linear', 3000);
      const info = tracker.getInfo('linear');
      expect(info.retryAfterMs).toBe(3000);
    });

    it('sets retryAfterMs to null when not provided', () => {
      tracker.recordLimit('linear');
      const info = tracker.getInfo('linear');
      expect(info.retryAfterMs).toBeNull();
      expect(info.isLimited).toBe(true);
    });

    it('increments limitCount on each recordLimit call', () => {
      tracker.recordLimit('linear', 1000);
      expect(tracker.getInfo('linear').limitCount).toBe(1);

      tracker.recordLimit('linear', 2000);
      expect(tracker.getInfo('linear').limitCount).toBe(2);

      tracker.recordLimit('linear', 3000);
      expect(tracker.getInfo('linear').limitCount).toBe(3);
    });

    it('updates lastLimitedAt on each recordLimit call', () => {
      const now = new Date();
      vi.setSystemTime(now);

      tracker.recordLimit('linear', 1000);
      expect(tracker.getInfo('linear').lastLimitedAt).toEqual(now);

      const later = new Date(now.getTime() + 500);
      vi.setSystemTime(later);

      tracker.recordLimit('linear', 1000);
      expect(tracker.getInfo('linear').lastLimitedAt).toEqual(later);
    });
  });

  describe('time-based expiry', () => {
    it('returns false after retryAfter period expires', () => {
      tracker.recordLimit('linear', 5000);
      expect(tracker.isLimited('linear')).toBe(true);

      vi.advanceTimersByTime(4999);
      expect(tracker.isLimited('linear')).toBe(true);

      vi.advanceTimersByTime(1);
      expect(tracker.isLimited('linear')).toBe(false);
    });

    it('remains limited when no retryAfterMs is provided', () => {
      tracker.recordLimit('linear');
      expect(tracker.isLimited('linear')).toBe(true);

      vi.advanceTimersByTime(60_000);
      expect(tracker.isLimited('linear')).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('resets the limit for a source', () => {
      tracker.recordLimit('linear', 5000);
      expect(tracker.isLimited('linear')).toBe(true);

      tracker.recordSuccess('linear');
      expect(tracker.isLimited('linear')).toBe(false);
    });

    it('preserves limitCount after success', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordLimit('linear', 3000);
      tracker.recordSuccess('linear');

      const info = tracker.getInfo('linear');
      expect(info.isLimited).toBe(false);
      expect(info.limitCount).toBe(2);
    });

    it('clears retryAfterMs on success', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordSuccess('linear');

      const info = tracker.getInfo('linear');
      expect(info.retryAfterMs).toBeNull();
    });

    it('is a no-op for unknown sources', () => {
      expect(() => tracker.recordSuccess('unknown')).not.toThrow();
    });
  });

  describe('getInfo', () => {
    it('returns default info for unknown source', () => {
      const info = tracker.getInfo('linear');
      expect(info).toEqual({
        isLimited: false,
        retryAfterMs: null,
        lastLimitedAt: null,
        limitCount: 0,
        source: 'linear',
      });
    });

    it('returns correct info for limited source', () => {
      const now = new Date();
      vi.setSystemTime(now);

      tracker.recordLimit('github', 10_000);

      const info = tracker.getInfo('github');
      expect(info.isLimited).toBe(true);
      expect(info.retryAfterMs).toBe(10_000);
      expect(info.lastLimitedAt).toEqual(now);
      expect(info.limitCount).toBe(1);
      expect(info.source).toBe('github');
    });
  });

  describe('getAllLimits', () => {
    it('returns empty array when no sources tracked', () => {
      expect(tracker.getAllLimits()).toEqual([]);
    });

    it('returns all tracked sources', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordLimit('github', 3000);
      tracker.recordLimit('claude', 10_000);

      const limits = tracker.getAllLimits();
      expect(limits).toHaveLength(3);

      const sources = limits.map((l) => l.source).sort();
      expect(sources).toEqual(['claude', 'github', 'linear']);
    });

    it('includes sources that were limited then succeeded', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordSuccess('linear');

      const limits = tracker.getAllLimits();
      expect(limits).toHaveLength(1);
      expect(limits[0].isLimited).toBe(false);
      expect(limits[0].source).toBe('linear');
    });
  });

  describe('reset', () => {
    it('clears a specific source completely', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordLimit('linear', 3000);
      tracker.reset('linear');

      const info = tracker.getInfo('linear');
      expect(info).toEqual({
        isLimited: false,
        retryAfterMs: null,
        lastLimitedAt: null,
        limitCount: 0,
        source: 'linear',
      });
    });

    it('does not affect other sources', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordLimit('github', 3000);

      tracker.reset('linear');

      expect(tracker.isLimited('github')).toBe(true);
      expect(tracker.isLimited('linear')).toBe(false);
    });

    it('removes source from getAllLimits', () => {
      tracker.recordLimit('linear', 5000);
      tracker.recordLimit('github', 3000);

      tracker.reset('linear');

      const limits = tracker.getAllLimits();
      expect(limits).toHaveLength(1);
      expect(limits[0].source).toBe('github');
    });

    it('is a no-op for unknown sources', () => {
      expect(() => tracker.reset('unknown')).not.toThrow();
    });
  });
});
