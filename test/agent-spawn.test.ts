import { describe, it, expect, vi } from 'vitest';
import { createSpawnFunction } from '../src/agent-spawn.js';

describe('createSpawnFunction', () => {
  it('returns undefined when path is null (SDK default)', () => {
    const result = createSpawnFunction(null);
    expect(result).toBeUndefined();
  });

  it('returns a spawn function when path is provided', () => {
    const result = createSpawnFunction('/usr/local/bin/claude');
    expect(result).toBeTypeOf('function');
  });

  it('spawn function uses the custom path', () => {
    const mockSpawn = vi.fn().mockReturnValue({ pid: 1234 });

    // We test the logic by verifying the function calls spawn with the custom path
    const spawnFn = createSpawnFunction('/custom/bin/claude', mockSpawn);

    expect(spawnFn).toBeDefined();
    const result = spawnFn!('ignored-command', ['--flag'], { cwd: '/tmp' });

    expect(mockSpawn).toHaveBeenCalledWith('/custom/bin/claude', ['--flag'], { cwd: '/tmp' });
    expect(result).toEqual({ pid: 1234 });
  });
});
