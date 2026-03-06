import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expandHome, expandConfigPaths } from '../src/path-utils.js';

describe('expandHome', () => {
  it('expands ~/workspace to {homedir}/workspace', () => {
    const result = expandHome('~/workspace');
    expect(result).toBe(resolve(homedir(), 'workspace'));
  });

  it('expands ~ alone to {homedir}', () => {
    const result = expandHome('~');
    expect(result).toBe(resolve(homedir()));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('relative/path')).toBe('relative/path');
  });

  it('does not expand ~ in the middle of a path', () => {
    expect(expandHome('/some/~/path')).toBe('/some/~/path');
  });

  it('expands ~/deeply/nested/path correctly', () => {
    const result = expandHome('~/deeply/nested/path');
    expect(result).toBe(resolve(homedir(), 'deeply/nested/path'));
  });
});

describe('expandConfigPaths', () => {
  it('expands nested string values starting with ~/', () => {
    const config = {
      workspace: {
        rootDir: '~/projects/myapp',
      },
      hooks: {
        afterCreate: '~/scripts/setup.sh',
      },
    };

    const result = expandConfigPaths(config);

    expect(result).toEqual({
      workspace: {
        rootDir: resolve(homedir(), 'projects/myapp'),
      },
      hooks: {
        afterCreate: resolve(homedir(), 'scripts/setup.sh'),
      },
    });
  });

  it('ignores non-path strings', () => {
    const config = {
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'demo',
      },
    };

    const result = expandConfigPaths(config);

    expect(result).toEqual({
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'demo',
      },
    });
  });

  it('preserves non-string values', () => {
    const config = {
      polling: { intervalMs: 30000 },
      agent: { maxConcurrentAgents: 10 },
      enabled: true,
      tags: ['a', 'b'],
    };

    const result = expandConfigPaths(config);

    expect(result).toEqual({
      polling: { intervalMs: 30000 },
      agent: { maxConcurrentAgents: 10 },
      enabled: true,
      tags: ['a', 'b'],
    });
  });

  it('handles empty config', () => {
    expect(expandConfigPaths({})).toEqual({});
  });

  it('expands values in arrays that start with ~/', () => {
    const config = {
      paths: ['~/first', '/absolute', '~/second'],
    };

    const result = expandConfigPaths(config);

    expect(result).toEqual({
      paths: [
        resolve(homedir(), 'first'),
        '/absolute',
        resolve(homedir(), 'second'),
      ],
    });
  });
});
