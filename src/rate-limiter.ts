export interface RateLimitInfo {
  isLimited: boolean;
  retryAfterMs: number | null;
  lastLimitedAt: Date | null;
  limitCount: number;
  source: string;
}

interface TrackerEntry {
  retryAfterMs: number | null;
  lastLimitedAt: Date | null;
  limitCount: number;
  limitedUntil: number | null;
}

export class RateLimitTracker {
  private entries = new Map<string, TrackerEntry>();

  recordLimit(source: string, retryAfterMs?: number): void {
    const existing = this.entries.get(source);
    const now = Date.now();
    const limitedUntil =
      retryAfterMs != null ? now + retryAfterMs : null;

    this.entries.set(source, {
      retryAfterMs: retryAfterMs ?? null,
      lastLimitedAt: new Date(),
      limitCount: (existing?.limitCount ?? 0) + 1,
      limitedUntil,
    });
  }

  recordSuccess(source: string): void {
    const existing = this.entries.get(source);
    if (!existing) return;

    this.entries.set(source, {
      retryAfterMs: null,
      lastLimitedAt: existing.lastLimitedAt,
      limitCount: existing.limitCount,
      limitedUntil: 0,
    });
  }

  isLimited(source: string): boolean {
    const entry = this.entries.get(source);
    if (!entry) return false;

    // No retryAfter was given -- stays limited until explicit success/reset
    if (entry.limitedUntil === null) return true;

    // Expired?
    if (entry.limitedUntil <= Date.now()) return false;

    return true;
  }

  getInfo(source: string): RateLimitInfo {
    const entry = this.entries.get(source);
    if (!entry) {
      return {
        isLimited: false,
        retryAfterMs: null,
        lastLimitedAt: null,
        limitCount: 0,
        source,
      };
    }

    return {
      isLimited: this.isLimited(source),
      retryAfterMs: entry.retryAfterMs,
      lastLimitedAt: entry.lastLimitedAt,
      limitCount: entry.limitCount,
      source,
    };
  }

  getAllLimits(): RateLimitInfo[] {
    const results: RateLimitInfo[] = [];
    for (const source of this.entries.keys()) {
      results.push(this.getInfo(source));
    }
    return results;
  }

  reset(source: string): void {
    this.entries.delete(source);
  }
}
