import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveEnvVars,
  parseWorkflow,
  validateConfig,
  normalizeStateName,
  parseCsvList,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// resolveEnvVars
// ---------------------------------------------------------------------------
describe('resolveEnvVars', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('replaces $VAR with the corresponding env value', () => {
    process.env.MY_TOKEN = 'secret-123';
    expect(resolveEnvVars('$MY_TOKEN')).toBe('secret-123');
  });

  it('throws ConfigError when the env var is not set', () => {
    delete process.env.MISSING_VAR;
    expect(() => resolveEnvVars('$MISSING_VAR')).toThrow(ConfigError);
  });

  it('returns a literal string as-is when there is no $ prefix', () => {
    expect(resolveEnvVars('plain-value')).toBe('plain-value');
  });

  it('handles $VAR_NAME with underscores', () => {
    process.env.MY_LONG_VAR_NAME = 'underscore-value';
    expect(resolveEnvVars('$MY_LONG_VAR_NAME')).toBe('underscore-value');
  });
});

// ---------------------------------------------------------------------------
// parseWorkflow
// ---------------------------------------------------------------------------
describe('parseWorkflow', () => {
  it('extracts YAML frontmatter and body from WORKFLOW.md content', () => {
    const content = [
      '---',
      'tracker:',
      '  kind: linear',
      '---',
      'Hello {{ identifier }}',
    ].join('\n');

    const result = parseWorkflow(content);

    expect(result.config).toEqual({ tracker: { kind: 'linear' } });
    expect(result.promptTemplate).toBe('Hello {{ identifier }}');
  });

  it('throws ConfigError when frontmatter is missing', () => {
    const content = 'Just some text without frontmatter';
    expect(() => parseWorkflow(content)).toThrow(ConfigError);
  });

  it('handles an empty body after frontmatter', () => {
    const content = ['---', 'tracker:', '  kind: github', '---', ''].join('\n');

    const result = parseWorkflow(content);

    expect(result.config).toEqual({ tracker: { kind: 'github' } });
    expect(result.promptTemplate).toBe('');
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------
describe('validateConfig', () => {
  const minimalRaw = {
    tracker: {
      kind: 'linear',
      apiKey: 'lin_api_test',
      projectSlug: 'MY-PROJECT',
    },
    workspace: {
      rootDir: '/tmp/workspaces',
    },
  };

  it('accepts a valid minimal config', () => {
    const cfg = validateConfig(minimalRaw);
    expect(cfg.tracker.kind).toBe('linear');
    expect(cfg.tracker.apiKey).toBe('lin_api_test');
    expect(cfg.tracker.projectSlug).toBe('MY-PROJECT');
    expect(cfg.workspace.rootDir).toBe('/tmp/workspaces');
  });

  it('applies all default values', () => {
    const cfg = validateConfig(minimalRaw);

    // polling defaults
    expect(cfg.polling.intervalMs).toBe(30_000);

    // hooks defaults
    expect(cfg.hooks.timeoutMs).toBe(60_000);
    expect(cfg.hooks.afterCreate).toBeNull();
    expect(cfg.hooks.beforeRun).toBeNull();
    expect(cfg.hooks.afterRun).toBeNull();
    expect(cfg.hooks.beforeRemove).toBeNull();

    // agent defaults
    expect(cfg.agent.maxTurns).toBe(20);
    expect(cfg.agent.maxConcurrentAgents).toBe(10);
    expect(cfg.agent.maxRetryBackoffMs).toBe(300_000);
    expect(cfg.agent.maxConcurrentAgentsByState).toEqual({});

    // claude defaults
    expect(cfg.claude.permissionMode).toBe('bypassPermissions');
    expect(cfg.claude.model).toBeNull();
    expect(cfg.claude.turnTimeoutMs).toBe(3_600_000);
    expect(cfg.claude.stallTimeoutMs).toBe(300_000);
    expect(cfg.claude.allowedTools).toBeNull();
    expect(cfg.claude.disallowedTools).toBeNull();
    expect(cfg.claude.systemPrompt).toBeNull();

    // server defaults
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.server.port).toBeNull();

    // tracker defaults
    expect(cfg.tracker.activeStates).toEqual(['Todo', 'In Progress']);
    expect(cfg.tracker.terminalStates).toEqual([
      'Closed',
      'Cancelled',
      'Canceled',
      'Duplicate',
      'Done',
    ]);
    expect(cfg.tracker.assignee).toBeNull();
  });

  it('rejects config with missing tracker.kind', () => {
    const raw = {
      tracker: { apiKey: 'key', projectSlug: 'slug' },
      workspace: { rootDir: '/tmp' },
    };
    expect(() => validateConfig(raw)).toThrow();
  });

  it('applies default apiKey and projectSlug for memory tracker', () => {
    const raw = {
      tracker: { kind: 'memory' as const },
      workspace: { rootDir: '/tmp' },
    };
    const cfg = validateConfig(raw);
    expect(cfg.tracker.apiKey).toBe('demo');
    expect(cfg.tracker.projectSlug).toBe('demo');
  });

  it('rejects config with missing workspace.rootDir', () => {
    const raw = {
      tracker: { kind: 'linear', apiKey: 'key', projectSlug: 'slug' },
    };
    expect(() => validateConfig(raw)).toThrow();
  });

  it('accepts github as tracker kind', () => {
    const raw = {
      tracker: {
        kind: 'github',
        apiKey: 'ghp_test',
        projectSlug: 'owner/repo',
      },
      workspace: { rootDir: '/tmp' },
    };
    const cfg = validateConfig(raw);
    expect(cfg.tracker.kind).toBe('github');
  });
});

// ---------------------------------------------------------------------------
// normalizeStateName
// ---------------------------------------------------------------------------
describe('normalizeStateName', () => {
  it('trims whitespace and lowercases the state name', () => {
    expect(normalizeStateName('  In Progress  ')).toBe('in progress');
    expect(normalizeStateName('TODO')).toBe('todo');
    expect(normalizeStateName(' Done ')).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// parseCsvList
// ---------------------------------------------------------------------------
describe('parseCsvList', () => {
  it('splits a CSV string into a trimmed array', () => {
    expect(parseCsvList('a, b , c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvList('single')).toEqual(['single']);
  });

  it('passes through a string array unchanged', () => {
    const input = ['alpha', 'beta', 'gamma'];
    expect(parseCsvList(input)).toEqual(['alpha', 'beta', 'gamma']);
  });
});
