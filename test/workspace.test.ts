import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, symlink, access, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/workspace.js';
import { WorkspaceError, HookError } from '../src/errors.js';
import type { HooksConfig } from '../src/types.js';

function makeHooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('Workspace.sanitizeIdentifier', () => {
  it('replaces spaces with underscore', () => {
    expect(Workspace.sanitizeIdentifier('hello world')).toBe('hello_world');
  });

  it('replaces special chars (/, @, #) with underscore', () => {
    expect(Workspace.sanitizeIdentifier('owner/repo#45@v2')).toBe('owner_repo_45_v2');
  });

  it('preserves valid chars (alphanumeric, dot, dash, underscore)', () => {
    expect(Workspace.sanitizeIdentifier('MT-123.fix_bug')).toBe('MT-123.fix_bug');
  });

  it('handles empty string', () => {
    expect(Workspace.sanitizeIdentifier('')).toBe('_');
  });
});

describe('Workspace.validatePathSafety', () => {
  let rootDir: string;
  let ws: Workspace;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
    ws = new Workspace(rootDir, makeHooks());
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('accepts valid path under root', async () => {
    const target = join(rootDir, 'valid-workspace');
    await expect(ws.validatePathSafety(target)).resolves.toBeUndefined();
  });

  it('rejects path outside root (../../escape)', async () => {
    const target = join(rootDir, '..', '..', 'escape');
    await expect(ws.validatePathSafety(target)).rejects.toThrow(WorkspaceError);
    await expect(ws.validatePathSafety(target)).rejects.toThrow(/Path escapes workspace root/);
  });

  it('rejects symlink in path segment', async () => {
    const realDir = join(rootDir, 'real');
    const linkDir = join(rootDir, 'link');
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir);

    const target = join(linkDir, 'sub');
    await expect(ws.validatePathSafety(target)).rejects.toThrow(WorkspaceError);
    await expect(ws.validatePathSafety(target)).rejects.toThrow(/Symlink detected/);
  });
});

describe('Workspace.ensureWorkspace', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('creates directory if not exists', async () => {
    const ws = new Workspace(rootDir, makeHooks());
    const path = await ws.ensureWorkspace('MT-100', 'issue-1');

    // directory should now exist
    await expect(access(path)).resolves.toBeUndefined();
    expect(path).toBe(join(rootDir, 'MT-100'));
  });

  it('reuses existing directory', async () => {
    const ws = new Workspace(rootDir, makeHooks());
    const existingPath = join(rootDir, 'MT-200');
    await mkdir(existingPath, { recursive: true });
    await writeFile(join(existingPath, 'marker.txt'), 'keep');

    const path = await ws.ensureWorkspace('MT-200', 'issue-2');
    expect(path).toBe(existingPath);
    // marker file should still exist (directory not recreated)
    await expect(access(join(existingPath, 'marker.txt'))).resolves.toBeUndefined();
  });

  it('runs afterCreate hook on new workspace', async () => {
    const hooks = makeHooks({ afterCreate: 'echo "created" > hook_ran.txt' });
    const ws = new Workspace(rootDir, hooks);

    const path = await ws.ensureWorkspace('MT-300', 'issue-3');
    await expect(access(join(path, 'hook_ran.txt'))).resolves.toBeUndefined();
  });
});

describe('Workspace.removeWorkspace', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('deletes directory', async () => {
    const ws = new Workspace(rootDir, makeHooks());
    const wsPath = join(rootDir, 'MT-400');
    await mkdir(wsPath, { recursive: true });
    await writeFile(join(wsPath, 'data.txt'), 'content');

    await ws.removeWorkspace('MT-400', 'issue-4');
    await expect(access(wsPath)).rejects.toThrow();
  });

  it('runs beforeRemove hook before deletion', async () => {
    // Hook writes a file to rootDir (outside workspace) so we can verify it ran
    const hooks = makeHooks({
      beforeRemove: `echo "$hatice_ISSUE_ID" > "${rootDir}/hook_proof.txt"`,
    });
    const ws = new Workspace(rootDir, hooks);
    const wsPath = join(rootDir, 'MT-500');
    await mkdir(wsPath, { recursive: true });

    await ws.removeWorkspace('MT-500', 'issue-5');
    // hook should have written proof file
    await expect(access(join(rootDir, 'hook_proof.txt'))).resolves.toBeUndefined();
    // workspace should be deleted
    await expect(access(wsPath)).rejects.toThrow();
  });
});

describe('Workspace.runHook', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('times out after configured timeout', async () => {
    const hooks = makeHooks({ timeoutMs: 200 });
    const ws = new Workspace(rootDir, hooks);

    await expect(
      ws.runHook('testHook', 'sleep 30', rootDir, { issueId: 'i1', identifier: 'id1' }),
    ).rejects.toThrow(HookError);
    await expect(
      ws.runHook('testHook', 'sleep 30', rootDir, { issueId: 'i1', identifier: 'id1' }),
    ).rejects.toThrow(/timed out/);
  }, 10_000);
});

describe('Workspace.cleanArtifacts', () => {
  let rootDir: string;
  let ws: Workspace;

  const ARTIFACT_DIRS = [
    '.cache',
    'node_modules/.cache',
    'tmp',
    '.tmp',
    '.vite',
    '.turbo',
    '.next/cache',
    '.nuxt',
  ];

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
    ws = new Workspace(rootDir, makeHooks());
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('removes temp directories that exist', async () => {
    const workspacePath = join(rootDir, 'ws-clean');
    await mkdir(workspacePath, { recursive: true });

    // Create all artifact directories with marker files
    for (const dir of ARTIFACT_DIRS) {
      const fullDir = join(workspacePath, dir);
      await mkdir(fullDir, { recursive: true });
      await writeFile(join(fullDir, 'junk.txt'), 'temp data');
    }

    await ws.cleanArtifacts(workspacePath);

    // All artifact directories should be gone
    for (const dir of ARTIFACT_DIRS) {
      await expect(access(join(workspacePath, dir))).rejects.toThrow();
    }
  });

  it('ignores non-existent directories without errors', async () => {
    const workspacePath = join(rootDir, 'ws-empty');
    await mkdir(workspacePath, { recursive: true });

    // No artifact dirs created — cleanArtifacts should not throw
    await expect(ws.cleanArtifacts(workspacePath)).resolves.toBeUndefined();
  });

  it('does not throw on permission errors', async () => {
    const workspacePath = join(rootDir, 'ws-perm');
    const protectedDir = join(workspacePath, '.cache');
    await mkdir(protectedDir, { recursive: true });
    await writeFile(join(protectedDir, 'file.txt'), 'data');

    // Make parent unwritable so rm will fail
    await chmod(workspacePath, 0o555);

    try {
      // Should not throw — cleanup is best-effort
      await expect(ws.cleanArtifacts(workspacePath)).resolves.toBeUndefined();
    } finally {
      // Restore permissions for afterEach cleanup
      await chmod(workspacePath, 0o755);
    }
  });
});

describe('Workspace.ensureWorkspace calls cleanArtifacts on existing workspace', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('calls cleanArtifacts when workspace already exists', async () => {
    const ws = new Workspace(rootDir, makeHooks());
    const existingPath = join(rootDir, 'MT-600');
    await mkdir(existingPath, { recursive: true });

    // Create an artifact directory
    const cacheDir = join(existingPath, '.cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'stale.txt'), 'stale');

    const path = await ws.ensureWorkspace('MT-600', 'issue-6');
    expect(path).toBe(existingPath);

    // .cache should have been cleaned
    await expect(access(cacheDir)).rejects.toThrow();
  });

  it('does not call cleanArtifacts on newly created workspace', async () => {
    const ws = new Workspace(rootDir, makeHooks());
    const cleanSpy = vi.spyOn(ws, 'cleanArtifacts');

    await ws.ensureWorkspace('MT-700', 'issue-7');

    expect(cleanSpy).not.toHaveBeenCalled();
    cleanSpy.mockRestore();
  });
});
