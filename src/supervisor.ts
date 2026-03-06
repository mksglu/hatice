/**
 * Process Supervisor — OTP-like crash recovery for Node.js
 *
 * Wraps an async function with automatic restart on uncaught exceptions,
 * respecting max-restart limits within a sliding time window.
 */

export interface SupervisorOptions {
  /** Maximum number of restarts allowed within the restart window (default 5) */
  maxRestarts: number;
  /** Window size in milliseconds for counting restarts (default 60000) */
  restartWindowMs: number;
  /** Health check interval in milliseconds (default 30000) */
  healthCheckIntervalMs: number;
  /** Callback invoked on each crash before restart */
  onCrash?: (error: Error, restartCount: number) => void;
}

const DEFAULT_OPTIONS: SupervisorOptions = {
  maxRestarts: 5,
  restartWindowMs: 60_000,
  healthCheckIntervalMs: 30_000,
};

export class Supervisor {
  private readonly options: SupervisorOptions;
  private restartTimestamps: number[] = [];
  private stopped = false;
  private healthy = true;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options?: Partial<SupervisorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Start the supervised function with crash recovery.
   * The function is executed immediately and restarted on failure
   * until maxRestarts is exceeded within the restart window.
   */
  start(fn: () => Promise<void>): void {
    this.stopped = false;
    this.healthy = true;
    this.restartTimestamps = [];
    this.running = true;

    this.startHealthCheck();
    this.execute(fn);
  }

  /**
   * Gracefully stop the supervisor. Prevents further restarts.
   */
  stop(): void {
    this.stopped = true;
    this.running = false;
    this.clearHealthCheck();
  }

  /**
   * Returns whether the supervisor is in a healthy state.
   * False when max restarts have been exceeded.
   */
  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Returns the number of restarts within the current window.
   */
  getRestartCount(): number {
    this.pruneOldRestarts();
    return this.restartTimestamps.length;
  }

  private execute(fn: () => Promise<void>): void {
    if (this.stopped) return;

    fn().catch((error: Error) => {
      if (this.stopped) return;

      this.pruneOldRestarts();

      const currentCount = this.restartTimestamps.length;

      if (currentCount >= this.options.maxRestarts) {
        // Already at the limit — no more restarts allowed
        this.healthy = false;
        this.running = false;
        this.clearHealthCheck();
        return;
      }

      // Record this restart
      this.restartTimestamps.push(Date.now());
      const restartCount = this.restartTimestamps.length;

      if (this.options.onCrash) {
        this.options.onCrash(error, restartCount);
      }

      // Schedule restart on next tick to avoid stack overflow on rapid crashes
      setImmediate(() => this.execute(fn));
    });
  }

  private pruneOldRestarts(): void {
    const now = Date.now();
    const windowStart = now - this.options.restartWindowMs;
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => ts > windowStart,
    );
  }

  private startHealthCheck(): void {
    this.clearHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      if (!this.running || this.stopped) {
        this.healthy = false;
      }
    }, this.options.healthCheckIntervalMs);

    // Ensure timer doesn't prevent process exit
    if (this.healthCheckTimer && typeof this.healthCheckTimer === 'object' && 'unref' in this.healthCheckTimer) {
      this.healthCheckTimer.unref();
    }
  }

  private clearHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
