import pino from 'pino';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface SessionEntry {
  logger: pino.Logger;
  logPath: string;
  destination: pino.DestinationStream;
}

/**
 * Manages per-agent-session log files using Pino.
 * Each session gets its own log file written in NDJSON format.
 */
export class SessionLogger {
  private readonly logDir: string;
  private readonly sessions: Map<string, SessionEntry> = new Map();

  constructor(logDir: string) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  /**
   * Create a new session log for the given issue.
   * Log file path: `{logDir}/{sanitized-identifier}-{timestamp}.log`
   */
  createSessionLog(issueId: string, identifier: string): pino.Logger {
    // Close any existing session for this issue
    this.closeSessionLog(issueId);

    const sanitized = this.sanitize(identifier);
    const timestamp = Date.now();
    const filename = `${sanitized}-${timestamp}.log`;
    const logPath = path.join(this.logDir, filename);

    const destination = pino.destination({ dest: logPath, sync: true });
    const logger = pino({ name: `session-${issueId}` }, destination);

    this.sessions.set(issueId, { logger, logPath, destination });

    return logger;
  }

  /**
   * Close and remove the session log for the given issue.
   * No-op if the session does not exist.
   */
  closeSessionLog(issueId: string): void {
    const entry = this.sessions.get(issueId);
    if (!entry) return;

    try {
      (entry.destination as any).flushSync?.();
    } catch {
      // Ignore flush errors (e.g. stream already closed)
    }
    try {
      (entry.destination as any).end?.();
    } catch {
      // Ignore close errors
    }
    this.sessions.delete(issueId);
  }

  /**
   * Get the log file path for an active session.
   * Returns null if no session exists for the given issue.
   */
  getLogPath(issueId: string): string | null {
    const entry = this.sessions.get(issueId);
    return entry ? entry.logPath : null;
  }

  /**
   * Close all open session log handles.
   */
  cleanup(): void {
    const issueIds = [...this.sessions.keys()];
    for (const issueId of issueIds) {
      this.closeSessionLog(issueId);
    }
  }

  /**
   * Sanitize an identifier for use in a filename.
   * Replaces non-alphanumeric characters (except hyphens and underscores) with hyphens,
   * collapses consecutive hyphens, and trims leading/trailing hyphens.
   */
  private sanitize(value: string): string {
    return value
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
