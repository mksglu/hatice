/**
 * Per-turn read timeout utility.
 *
 * Wraps async operations with an AbortController-based timeout that is
 * independent of the stall timeout. Supports optional parent signal
 * propagation so callers can cancel from the outside.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Turn timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class TurnTimeout {
  private controller: AbortController;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private timeoutMs: number,
    parentSignal?: AbortSignal,
  ) {
    this.controller = new AbortController();

    // If a parent signal is provided, propagate its abort immediately.
    if (parentSignal) {
      if (parentSignal.aborted) {
        this.controller.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          'abort',
          () => {
            this.controller.abort(parentSignal.reason);
            this.clearTimer();
          },
          { once: true },
        );
      }
    }
  }

  /** The AbortSignal that downstream consumers should observe. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Start the timeout timer. */
  start(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.controller.abort(new TimeoutError(this.timeoutMs));
    }, this.timeoutMs);
  }

  /** Clear the timer without aborting the signal. */
  clear(): void {
    this.clearTimer();
  }

  /**
   * Convenience wrapper: runs `fn` with an auto-managed timeout.
   *
   * - If `fn` resolves before the deadline, its value is returned and the
   *   timer is cleaned up.
   * - If the deadline fires first, the returned promise rejects with a
   *   `TimeoutError` and the signal passed to `fn` is aborted.
   * - If a `parentSignal` is already aborted (or aborts during execution),
   *   the promise rejects with the parent's abort reason.
   */
  static async withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const tt = new TurnTimeout(timeoutMs, parentSignal);
    tt.start();

    try {
      // Race the user function against the abort signal.
      const result = await Promise.race([
        fn(tt.signal),
        new Promise<never>((_resolve, reject) => {
          if (tt.signal.aborted) {
            reject(tt.signal.reason);
            return;
          }
          tt.signal.addEventListener('abort', () => {
            reject(tt.signal.reason);
          }, { once: true });
        }),
      ]);

      return result;
    } finally {
      tt.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
