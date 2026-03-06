import { spawn } from 'node:child_process';

type SpawnLike = typeof spawn;

/**
 * Creates a custom spawn function for the Claude Agent SDK's
 * `spawnClaudeCodeProcess` option.
 *
 * When `claudeCodePath` is null, returns undefined so the SDK
 * uses its default binary resolution.
 *
 * An optional `spawnImpl` parameter allows injecting a mock for testing.
 */
export function createSpawnFunction(
  claudeCodePath: string | null,
  spawnImpl: SpawnLike = spawn,
): ((command: string, args: string[], options: Record<string, unknown>) => ReturnType<SpawnLike>) | undefined {
  if (!claudeCodePath) return undefined;

  return (_command: string, args: string[], options: Record<string, unknown>) => {
    return spawnImpl(claudeCodePath, args, options as any);
  };
}
