export class haticeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'haticeError';
    this.code = code;
  }
}

export class ConfigError extends haticeError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFIG_ERROR', message, options);
    this.name = 'ConfigError';
  }
}

export class TrackerError extends haticeError {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number, options?: ErrorOptions) {
    super('TRACKER_ERROR', message, options);
    this.name = 'TrackerError';
    this.statusCode = statusCode;
  }
}

export class WorkspaceError extends haticeError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKSPACE_ERROR', message, options);
    this.name = 'WorkspaceError';
  }
}

export class AgentError extends haticeError {
  constructor(message: string, options?: ErrorOptions) {
    super('AGENT_ERROR', message, options);
    this.name = 'AgentError';
  }
}

export class HookError extends haticeError {
  readonly hookName: string;
  readonly exitCode?: number;
  constructor(hookName: string, message: string, exitCode?: number, options?: ErrorOptions) {
    super('HOOK_ERROR', message, options);
    this.name = 'HookError';
    this.hookName = hookName;
    this.exitCode = exitCode;
  }
}

// Result type for operations that can fail gracefully
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
