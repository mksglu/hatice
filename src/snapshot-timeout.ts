/**
 * Timeout utilities for dashboard snapshot operations.
 * Prevents hanging when snapshot generation takes too long.
 */

export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wraps an async (or sync) function with a timeout guard.
 *
 * - If `fn` resolves within `timeoutMs`, its result is returned.
 * - If `fn` exceeds `timeoutMs`:
 *   - Returns `fallback` when provided.
 *   - Throws `TimeoutError` otherwise.
 */
export async function withTimeout<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
  fallback?: T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = () => {
      const was = settled;
      settled = true;
      return !was;
    };

    const timer = setTimeout(() => {
      if (!settle()) return;
      if (fallback !== undefined) {
        resolve(fallback);
      } else {
        reject(
          new TimeoutError(
            `Operation timed out after ${timeoutMs}ms`,
            timeoutMs,
          ),
        );
      }
    }, timeoutMs);

    Promise.resolve()
      .then(() => fn())
      .then(
        (result) => {
          if (!settle()) return;
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          if (!settle()) return;
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

/**
 * Synchronous error-protection wrapper.
 *
 * True synchronous timeout is not possible in JavaScript, so this simply
 * runs `fn` and returns `fallback` if it throws.
 */
export function withTimeoutSync<T>(
  fn: () => T,
  _timeoutMs: number,
  fallback: T,
): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
