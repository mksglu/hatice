import { z } from 'zod';
import matter from 'gray-matter';
import type { haticeConfig } from './types.js';
import { ConfigError } from './errors.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const trackerSchema = z.object({
  kind: z.enum(['linear', 'github', 'gitlab', 'memory']),
  endpoint: z.string().default('https://api.linear.app/graphql'),
  apiKey: z.string().default('demo'),
  projectSlug: z.string().default('demo'),
  activeStates: z.array(z.string()).default(['Todo', 'In Progress']),
  terminalStates: z
    .array(z.string())
    .default(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']),
  assignee: z.string().nullable().default(null),
});

const pollingSchema = z.object({
  intervalMs: z.number().default(30_000),
});

const workspaceSchema = z.object({
  rootDir: z.string(),
});

const hooksSchema = z.object({
  afterCreate: z.string().nullable().default(null),
  beforeRun: z.string().nullable().default(null),
  afterRun: z.string().nullable().default(null),
  beforeRemove: z.string().nullable().default(null),
  timeoutMs: z.number().default(60_000),
});

const agentSchema = z.object({
  maxConcurrentAgents: z.number().default(10),
  maxTurns: z.number().default(20),
  maxRetryBackoffMs: z.number().default(300_000),
  maxConcurrentAgentsByState: z.record(z.string(), z.number()).default({}),
  retryOnNormalExit: z.boolean().default(false),
});

const claudeSchema = z.object({
  model: z.string().nullable().default(null),
  permissionMode: z.string().default('bypassPermissions'),
  turnTimeoutMs: z.number().default(3_600_000),
  stallTimeoutMs: z.number().default(300_000),
  allowedTools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).nullable().default(null),
  systemPrompt: z.string().nullable().default(null),
  canUseTool: z.record(z.string(), z.boolean()).nullable().default(null),
  claudeCodePath: z.string().nullable().default(null),
  autoRespondToInput: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});

const serverSchema = z.object({
  port: z.number().nullable().default(null),
  host: z.string().default('127.0.0.1'),
});

const haticeConfigSchema = z.object({
  tracker: trackerSchema,
  polling: pollingSchema.default({ intervalMs: 30_000 }),
  workspace: workspaceSchema,
  hooks: hooksSchema.default({
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
  }),
  agent: agentSchema.default({
    maxConcurrentAgents: 10,
    maxTurns: 20,
    maxRetryBackoffMs: 300_000,
    maxConcurrentAgentsByState: {},
    retryOnNormalExit: false,
  }),
  claude: claudeSchema.default({
    model: null,
    permissionMode: 'bypassPermissions',
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    allowedTools: null,
    disallowedTools: null,
    systemPrompt: null,
    canUseTool: null,
    claudeCodePath: null,
    autoRespondToInput: true,
    dryRun: false,
  }),
  server: serverSchema.default({ port: null, host: '127.0.0.1' }),
});

// ---------------------------------------------------------------------------
// resolveEnvVars
// ---------------------------------------------------------------------------

/**
 * If `value` starts with `$`, resolve the rest as an environment variable name.
 * Throws `ConfigError` if the variable is not set.
 */
export function resolveEnvVars(value: string): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const varName = value.slice(1);
  const resolved = process.env[varName];

  if (resolved === undefined) {
    throw new ConfigError(
      `Environment variable "${varName}" is not set (referenced as "${value}")`,
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// parseWorkflow
// ---------------------------------------------------------------------------

/**
 * Parse a WORKFLOW.md string: extract YAML frontmatter as `config` and the
 * remaining body as `promptTemplate`.
 */
export function parseWorkflow(content: string): {
  config: Record<string, unknown>;
  promptTemplate: string;
} {
  const parsed = matter(content);

  // gray-matter returns empty data ({}) when there is no frontmatter delimiter
  if (!content.trimStart().startsWith('---')) {
    throw new ConfigError(
      'WORKFLOW.md is missing YAML frontmatter (expected --- delimiters)',
    );
  }

  return {
    config: parsed.data as Record<string, unknown>,
    promptTemplate: parsed.content.trim(),
  };
}

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

/**
 * Validate a raw config object against the Zod schema, applying defaults.
 * Throws `ConfigError` on validation failure.
 */
export function validateConfig(raw: Record<string, unknown>): haticeConfig {
  const result = haticeConfigSchema.safeParse(raw);

  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${messages}`);
  }

  return result.data as haticeConfig;
}

// ---------------------------------------------------------------------------
// normalizeStateName
// ---------------------------------------------------------------------------

/**
 * Normalize an issue state name: trim whitespace and convert to lowercase.
 */
export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// parseCsvList
// ---------------------------------------------------------------------------

/**
 * Normalize a value that may be a comma-separated string or an array of strings
 * into a trimmed string array.
 */
export function parseCsvList(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value.split(',').map((item) => item.trim());
}
