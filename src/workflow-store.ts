import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseWorkflow, validateConfig, resolveEnvVars } from './config.js';
import { expandConfigPaths } from './path-utils.js';
import type { Workflow } from './types.js';
import { createLogger } from './logger.js';

export class WorkflowStore {
  private filePath: string;
  private current: Workflow | null = null;
  private lastMtime: number = 0;
  private lastHash: string = '';
  private log;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.log = createLogger({ component: 'workflow-store' });
  }

  load(): Workflow | null {
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const stat = statSync(this.filePath);
      const hash = createHash('sha256').update(content).digest('hex');

      // Skip if unchanged
      if (this.lastHash === hash && this.lastMtime === stat.mtimeMs) {
        return this.current;
      }

      const { config: rawConfig, promptTemplate } = parseWorkflow(content);

      // Resolve env vars in config
      const resolved = this.resolveConfigEnvVars(rawConfig);
      const config = validateConfig(resolved);

      this.current = { config, promptTemplate };
      this.lastMtime = stat.mtimeMs;
      this.lastHash = hash;

      this.log.info('Workflow loaded successfully');
      return this.current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log.warn({ filePath: this.filePath }, 'Workflow file not found');
        return null;
      }

      if (this.current) {
        this.log.warn({ err: error }, 'Workflow reload failed, keeping last good config');
        return this.current;
      }

      throw error;
    }
  }

  getCurrentWorkflow(): Workflow | null {
    return this.current;
  }

  hasChanged(): boolean {
    try {
      const stat = statSync(this.filePath);
      if (stat.mtimeMs !== this.lastMtime) {
        const content = readFileSync(this.filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        return hash !== this.lastHash;
      }
      return false;
    } catch {
      return false;
    }
  }

  private resolveConfigEnvVars(config: Record<string, unknown>): Record<string, unknown> {
    // Deep traverse and resolve $VAR patterns in string values
    const envResolved = JSON.parse(JSON.stringify(config), (_key, value) => {
      if (typeof value === 'string' && value.startsWith('$')) {
        return resolveEnvVars(value);
      }
      return value;
    });

    // Expand ~/... paths to absolute paths
    return expandConfigPaths(envResolved);
  }
}
