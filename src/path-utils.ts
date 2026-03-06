import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Expand a leading `~` or `~/` in a file path to the user's home directory.
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return resolve(homedir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Deep-traverse a config object and expand `~/` prefixed string values
 * to absolute paths using the user's home directory.
 */
export function expandConfigPaths(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config), (_key, value) => {
    if (typeof value === 'string' && value.startsWith('~/')) {
      return expandHome(value);
    }
    return value;
  });
}
