import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionLogger } from '../src/session-logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// SessionLogger
// ---------------------------------------------------------------------------
describe('SessionLogger', () => {
  let logDir: string;
  let sessionLogger: SessionLogger;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatice-session-log-'));
    sessionLogger = new SessionLogger(logDir);
  });

  afterEach(() => {
    sessionLogger.cleanup();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // createSessionLog returns a pino logger
  // -------------------------------------------------------------------------
  it('createSessionLog returns a pino logger', () => {
    const logger = sessionLogger.createSessionLog('issue-1', 'fix-auth-bug');

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  // -------------------------------------------------------------------------
  // getLogPath returns correct path for active session
  // -------------------------------------------------------------------------
  it('getLogPath returns correct path for active session', () => {
    sessionLogger.createSessionLog('issue-2', 'add-feature');

    const logPath = sessionLogger.getLogPath('issue-2');

    expect(logPath).not.toBeNull();
    expect(logPath!).toContain(logDir);
    expect(logPath!).toContain('add-feature');
    expect(logPath!).toMatch(/\.log$/);
  });

  // -------------------------------------------------------------------------
  // getLogPath returns null for unknown session
  // -------------------------------------------------------------------------
  it('getLogPath returns null for unknown session', () => {
    const logPath = sessionLogger.getLogPath('nonexistent-issue');

    expect(logPath).toBeNull();
  });

  // -------------------------------------------------------------------------
  // closeSessionLog closes file handle
  // -------------------------------------------------------------------------
  it('closeSessionLog closes file handle', () => {
    sessionLogger.createSessionLog('issue-3', 'refactor-db');

    expect(sessionLogger.getLogPath('issue-3')).not.toBeNull();

    sessionLogger.closeSessionLog('issue-3');

    expect(sessionLogger.getLogPath('issue-3')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // cleanup closes all sessions
  // -------------------------------------------------------------------------
  it('cleanup closes all sessions', () => {
    sessionLogger.createSessionLog('issue-a', 'task-a');
    sessionLogger.createSessionLog('issue-b', 'task-b');
    sessionLogger.createSessionLog('issue-c', 'task-c');

    expect(sessionLogger.getLogPath('issue-a')).not.toBeNull();
    expect(sessionLogger.getLogPath('issue-b')).not.toBeNull();
    expect(sessionLogger.getLogPath('issue-c')).not.toBeNull();

    sessionLogger.cleanup();

    expect(sessionLogger.getLogPath('issue-a')).toBeNull();
    expect(sessionLogger.getLogPath('issue-b')).toBeNull();
    expect(sessionLogger.getLogPath('issue-c')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // log file is created on disk with JSON content
  // -------------------------------------------------------------------------
  it('log file is created on disk with JSON content', () => {
    const logger = sessionLogger.createSessionLog('issue-4', 'deploy-fix');

    logger.info({ action: 'test' }, 'hello from test');

    // Sync mode writes immediately — flush and close to ensure all data is on disk
    const logPath = sessionLogger.getLogPath('issue-4')!;
    expect(logPath).not.toBeNull();

    sessionLogger.closeSessionLog('issue-4');

    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8').trim();
    expect(content.length).toBeGreaterThan(0);

    // Each line should be valid JSON (NDJSON format from pino)
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.msg).toBe('hello from test');
    expect(parsed.action).toBe('test');
  });

  // -------------------------------------------------------------------------
  // sanitizes identifier for filename
  // -------------------------------------------------------------------------
  it('sanitizes identifier with special characters for filename', () => {
    sessionLogger.createSessionLog('issue-5', 'feat/add login & auth');

    const logPath = sessionLogger.getLogPath('issue-5');

    expect(logPath).not.toBeNull();
    // Should not contain slashes, ampersands, or spaces in filename
    const filename = path.basename(logPath!);
    expect(filename).not.toMatch(/[\/&\s]/);
    expect(filename).toMatch(/\.log$/);
  });

  // -------------------------------------------------------------------------
  // closeSessionLog is no-op for unknown session
  // -------------------------------------------------------------------------
  it('closeSessionLog does not throw for unknown session', () => {
    expect(() => sessionLogger.closeSessionLog('ghost-issue')).not.toThrow();
  });
});
