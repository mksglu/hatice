import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StartupCleanup } from '../src/cleanup.js';
import type { CleanupOptions, CleanupResult } from '../src/cleanup.js';

describe('StartupCleanup', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `hatice-cleanup-test-${randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeCleanup(overrides: Partial<CleanupOptions> = {}): StartupCleanup {
    return new StartupCleanup({
      workspaceRoot: rootDir,
      maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
      ...overrides,
    });
  }

  describe('run()', () => {
    it('returns zero counts on empty directory', async () => {
      const cleanup = makeCleanup();
      const result = await cleanup.run();

      expect(result.scanned).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.removedPaths).toEqual([]);
    });

    it('removes directories older than maxAge', async () => {
      const cleanup = makeCleanup({ maxAgeMs: 1000 }); // 1 second max age

      // Create a directory and backdate its mtime
      const oldDir = join(rootDir, 'stale-workspace');
      await mkdir(oldDir, { recursive: true });
      const pastTime = new Date(Date.now() - 60_000); // 60 seconds ago
      await utimes(oldDir, pastTime, pastTime);

      const result = await cleanup.run();

      expect(result.scanned).toBe(1);
      expect(result.removed).toBe(1);
      expect(result.removedPaths).toContain(oldDir);
    });

    it('keeps directories newer than maxAge', async () => {
      const cleanup = makeCleanup({ maxAgeMs: 60_000 }); // 60 seconds max age

      // Create a fresh directory (mtime = now)
      const freshDir = join(rootDir, 'fresh-workspace');
      await mkdir(freshDir, { recursive: true });

      const result = await cleanup.run();

      expect(result.scanned).toBe(1);
      expect(result.removed).toBe(0);
      expect(result.removedPaths).toEqual([]);
    });

    it('handles non-existent workspace root gracefully', async () => {
      const cleanup = makeCleanup({
        workspaceRoot: join(tmpdir(), `hatice-nonexistent-${randomUUID()}`),
      });

      const result = await cleanup.run();

      expect(result.scanned).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.removedPaths).toEqual([]);
    });

    it('counts errors for permission issues', async () => {
      // Create an old directory inside a parent that lacks write permission.
      // 0o544 (r-x) allows readdir + stat but blocks rm (needs write on parent).
      const protectedDir = join(rootDir, 'protected');
      await mkdir(protectedDir, { recursive: true });

      const staleChild = join(protectedDir, 'stale-child');
      await mkdir(staleChild, { recursive: true });
      await writeFile(join(staleChild, 'data.txt'), 'content');

      // Backdate mtime AFTER all writes (writeFile updates parent dir mtime)
      const pastTime = new Date(Date.now() - 60_000);
      await utimes(staleChild, pastTime, pastTime);

      const { chmod } = await import('node:fs/promises');
      await chmod(protectedDir, 0o544);

      const protectedCleanup = new StartupCleanup({
        workspaceRoot: protectedDir,
        maxAgeMs: 1000,
      });

      const result = await protectedCleanup.run();

      // Restore permissions for cleanup
      await chmod(protectedDir, 0o755);

      expect(result.scanned).toBe(1);
      expect(result.errors).toBe(1);
      expect(result.removed).toBe(0);
    });

    it('removedPaths lists what was cleaned up', async () => {
      const cleanup = makeCleanup({ maxAgeMs: 1000 });

      const dir1 = join(rootDir, 'old-ws-1');
      const dir2 = join(rootDir, 'old-ws-2');
      const dir3 = join(rootDir, 'fresh-ws');
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await mkdir(dir3, { recursive: true });

      const pastTime = new Date(Date.now() - 60_000);
      await utimes(dir1, pastTime, pastTime);
      await utimes(dir2, pastTime, pastTime);
      // dir3 stays fresh (mtime = now)

      const result = await cleanup.run();

      expect(result.scanned).toBe(3);
      expect(result.removed).toBe(2);
      expect(result.removedPaths).toHaveLength(2);
      expect(result.removedPaths).toContain(dir1);
      expect(result.removedPaths).toContain(dir2);
      expect(result.errors).toBe(0);
    });

    it('ignores regular files in workspace root', async () => {
      const cleanup = makeCleanup({ maxAgeMs: 1000 });

      // Create a file (not a directory) that is old
      const oldFile = join(rootDir, 'stale-file.txt');
      await writeFile(oldFile, 'leftover');
      const pastTime = new Date(Date.now() - 60_000);
      await utimes(oldFile, pastTime, pastTime);

      const result = await cleanup.run();

      expect(result.scanned).toBe(0); // files should not be scanned
      expect(result.removed).toBe(0);
    });
  });
});
