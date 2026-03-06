import { spawn } from 'node:child_process';
import { mkdir, rm, lstat, access } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { WorkspaceError, HookError } from './errors.js';
import type { HooksConfig } from './types.js';
import { createLogger } from './logger.js';

export class Workspace {
  private rootDir: string;
  private hooks: HooksConfig;
  private log;

  constructor(rootDir: string, hooks: HooksConfig) {
    this.rootDir = resolve(rootDir);
    this.hooks = hooks;
    this.log = createLogger({ component: 'workspace' });
  }

  static sanitizeIdentifier(identifier: string): string {
    return identifier.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
  }

  async validatePathSafety(targetPath: string): Promise<void> {
    const resolved = resolve(targetPath);
    const rel = relative(this.rootDir, resolved);
    if (rel.startsWith('..') || resolve(this.rootDir, rel) !== resolved) {
      throw new WorkspaceError(`Path escapes workspace root: ${targetPath}`);
    }
    // Check each segment for symlinks
    const segments = rel.split('/');
    let current = this.rootDir;
    for (const seg of segments) {
      current = join(current, seg);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          throw new WorkspaceError(`Symlink detected in path: ${current}`);
        }
      } catch (e: unknown) {
        if (e instanceof WorkspaceError) throw e;
        // Path segment doesn't exist yet, that's ok for creation
        break;
      }
    }
  }

  getWorkspacePath(identifier: string): string {
    const sanitized = Workspace.sanitizeIdentifier(identifier);
    return join(this.rootDir, sanitized);
  }

  async ensureWorkspace(identifier: string, issueId: string): Promise<string> {
    const workspacePath = this.getWorkspacePath(identifier);
    await this.validatePathSafety(workspacePath);

    let isNew = false;
    try {
      await access(workspacePath);
    } catch {
      await mkdir(workspacePath, { recursive: true });
      isNew = true;
    }

    if (isNew && this.hooks.afterCreate) {
      await this.runHook('afterCreate', this.hooks.afterCreate, workspacePath, { issueId, identifier });
    }

    if (!isNew) {
      await this.cleanArtifacts(workspacePath);
    }

    return workspacePath;
  }

  private static readonly ARTIFACT_DIRS = [
    '.cache',
    'node_modules/.cache',
    'tmp',
    '.tmp',
    '.vite',
    '.turbo',
    '.next/cache',
    '.nuxt',
  ];

  async cleanArtifacts(workspacePath: string): Promise<void> {
    for (const dir of Workspace.ARTIFACT_DIRS) {
      const target = join(workspacePath, dir);
      try {
        await rm(target, { recursive: true, force: true });
        this.log.debug({ target }, 'Cleaned artifact directory');
      } catch (err) {
        this.log.debug({ target, err }, 'Failed to clean artifact directory, skipping');
      }
    }
  }

  async removeWorkspace(identifier: string, issueId: string): Promise<void> {
    const workspacePath = this.getWorkspacePath(identifier);
    await this.validatePathSafety(workspacePath);

    if (this.hooks.beforeRemove) {
      try {
        await this.runHook('beforeRemove', this.hooks.beforeRemove, workspacePath, { issueId, identifier });
      } catch (e) {
        // before_remove hook failures are best-effort, continue with removal
        this.log.warn({ err: e, hookName: 'beforeRemove' }, 'beforeRemove hook failed, continuing with removal');
      }
    }

    await rm(workspacePath, { recursive: true, force: true });
  }

  async runHook(
    hookName: string,
    command: string,
    workspacePath: string,
    context: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-lc', command], {
        cwd: workspacePath,
        env: {
          ...process.env,
          hatice_ISSUE_ID: context.issueId ?? '',
          hatice_IDENTIFIER: context.identifier ?? '',
          hatice_WORKSPACE: workspacePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new HookError(hookName, `Hook '${hookName}' timed out after ${this.hooks.timeoutMs}ms`));
      }, this.hooks.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.slice(0, 2048));
        } else {
          reject(new HookError(hookName, `Hook '${hookName}' exited with code ${code}: ${stderr.slice(0, 2048)}`, code ?? undefined));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new HookError(hookName, `Hook '${hookName}' failed to spawn: ${err.message}`));
      });
    });
  }
}
