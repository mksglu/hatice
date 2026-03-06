import pino from 'pino';

const logLevel = process.env.hatice_LOG_LEVEL || 'info';

export const logger = pino({
  name: 'hatice',
  level: logLevel,
  ...(process.env.NODE_ENV === 'development' ? { transport: { target: 'pino/file', options: { destination: 1 } } } : {}),
});

export interface LogContext {
  issueId?: string;
  identifier?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export function createLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}

export type Logger = pino.Logger;
