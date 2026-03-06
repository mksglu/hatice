import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor } from '../src/supervisor.js';
import type { SupervisorOptions } from '../src/supervisor.js';

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Supervisor', () => {
  let supervisor: Supervisor;

  afterEach(() => {
    supervisor?.stop();
  });

  it('executes provided function on start', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    supervisor = new Supervisor({ maxRestarts: 3, restartWindowMs: 1000, healthCheckIntervalMs: 60_000 });

    supervisor.start(fn);
    await tick(50);

    expect(fn).toHaveBeenCalledOnce();
  });

  it('restarts function after crash', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        throw new Error('simulated crash');
      }
      // second call succeeds and stays alive
    });

    supervisor = new Supervisor({ maxRestarts: 3, restartWindowMs: 5000, healthCheckIntervalMs: 60_000 });
    supervisor.start(fn);

    // Wait enough for first crash + restart
    await tick(200);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(supervisor.getRestartCount()).toBe(1);
  });

  it('respects maxRestarts limit', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always crash'));

    supervisor = new Supervisor({ maxRestarts: 2, restartWindowMs: 5000, healthCheckIntervalMs: 60_000 });
    supervisor.start(fn);

    // Wait enough for all crashes to play out
    await tick(500);

    // Initial call + 2 restarts = 3 total calls
    expect(fn).toHaveBeenCalledTimes(3);
    expect(supervisor.getRestartCount()).toBe(2);
    expect(supervisor.isHealthy()).toBe(false);
  });

  it('resets restart count after window expires', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('crash once');
      }
      // After restart, wait for window to expire then crash again
      if (callCount === 2) {
        // Stay alive long enough for the first restart's timestamp to leave the window
        await tick(300);
        throw new Error('crash after window');
      }
      // Third call succeeds
    });

    // Window is 200ms — the first crash timestamp will expire after 200ms
    // restartWindowMs for the *assertion* check is 5000ms so the second crash is still visible
    supervisor = new Supervisor({ maxRestarts: 2, restartWindowMs: 200, healthCheckIntervalMs: 60_000 });
    supervisor.start(fn);

    // First crash + restart happens quickly
    await tick(100);
    expect(supervisor.getRestartCount()).toBe(1);

    // Wait for the second call to stay alive (300ms) then crash, plus buffer
    // At ~300ms the second call crashes. The first restart timestamp (~0ms) is
    // now >200ms old and gets pruned. Only the new crash at ~300ms remains.
    await tick(350);

    // The first crash has been pruned from the window; only the second crash remains
    // So restart count should be 1 (not accumulated to 2)
    expect(supervisor.getRestartCount()).toBe(1);
    expect(supervisor.isHealthy()).toBe(true);
  });

  it('calls onCrash callback on each restart', async () => {
    const onCrash = vi.fn();
    let callCount = 0;
    const crashError = new Error('boom');

    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        throw crashError;
      }
    });

    supervisor = new Supervisor({
      maxRestarts: 3,
      restartWindowMs: 5000,
      healthCheckIntervalMs: 60_000,
      onCrash,
    });
    supervisor.start(fn);

    await tick(300);

    expect(onCrash).toHaveBeenCalledTimes(2);
    expect(onCrash).toHaveBeenCalledWith(crashError, 1);
    expect(onCrash).toHaveBeenCalledWith(crashError, 2);
  });

  it('stop() prevents further restarts', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: stay alive a bit then crash
        await tick(50);
        throw new Error('crash');
      }
      // Should not reach here if stop() is called before restart
    });

    supervisor = new Supervisor({ maxRestarts: 5, restartWindowMs: 5000, healthCheckIntervalMs: 60_000 });
    supervisor.start(fn);

    // Wait for first invocation to start
    await tick(20);
    supervisor.stop();

    // Wait to see if any restart happens
    await tick(300);

    // Only the initial call should have happened (or it may have crashed before stop took effect)
    // The key assertion: no restart after stop
    expect(fn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('isHealthy returns false when max restarts exceeded', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always crash'));

    supervisor = new Supervisor({ maxRestarts: 1, restartWindowMs: 5000, healthCheckIntervalMs: 60_000 });

    expect(supervisor.isHealthy()).toBe(true); // healthy before start

    supervisor.start(fn);
    await tick(300);

    // After exceeding max restarts
    expect(supervisor.isHealthy()).toBe(false);
    expect(supervisor.getRestartCount()).toBe(1);
  });
});
