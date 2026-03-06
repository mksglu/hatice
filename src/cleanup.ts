import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';

export interface CleanupOptions {
  workspaceRoot: string;
  maxAgeMs: number; // default 24 hours
}

export interface CleanupResult {
  scanned: number;
  removed: number;
  errors: number;
  removedPaths: string[];
}

export class StartupCleanup {
  private log;

  constructor(private options: CleanupOptions) {
    this.log = createLogger({ component: 'cleanup' });
  }

  async run(): Promise<CleanupResult> {
    const result: CleanupResult = {
      scanned: 0,
      removed: 0,
      errors: 0,
      removedPaths: [],
    };

    let entries: string[];
    try {
      entries = await readdir(this.options.workspaceRoot);
    } catch {
      // Workspace root does not exist or is unreadable — nothing to clean
      this.log.info({ workspaceRoot: this.options.workspaceRoot }, 'workspace root not found, skipping cleanup');
      return result;
    }

    const now = Date.now();

    for (const entry of entries) {
      const fullPath = join(this.options.workspaceRoot, entry);

      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        // Cannot stat entry — skip silently
        continue;
      }

      if (!entryStat.isDirectory()) {
        continue;
      }

      result.scanned++;

      const ageMs = now - entryStat.mtimeMs;
      if (ageMs <= this.options.maxAgeMs) {
        continue;
      }

      try {
        await rm(fullPath, { recursive: true, force: true });
        result.removed++;
        result.removedPaths.push(fullPath);
        this.log.info({ path: fullPath, ageMs }, 'removed stale workspace');
      } catch (err) {
        result.errors++;
        this.log.warn({ path: fullPath, err }, 'failed to remove stale workspace');
      }
    }

    this.log.info(
      { scanned: result.scanned, removed: result.removed, errors: result.errors },
      'startup cleanup complete',
    );

    return result;
  }
}
