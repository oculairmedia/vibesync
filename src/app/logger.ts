import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');
const prettyLogsEnabled = isDevelopment && process.env.NO_PRETTY_LOGS !== '1';

const loggerConfig: pino.LoggerOptions = {
  level: logLevel,
  base: {
    service: 'vibesync',
    pid: process.pid,
  },
  redact: {
    paths: [
      'letta.password',
      'LETTA_PASSWORD',
      'config.letta.password',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.api_key',
    ],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label: string) => {
      return { level: label };
    },
  },
};

if (prettyLogsEnabled) {
  loggerConfig.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname,service',
      messageFormat: '{service} [{syncId}] {msg}',
    },
  };
}

export const logger = pino(loggerConfig);

export function createSyncLogger(syncId: string): pino.Logger {
  return logger.child({ syncId });
}

export function createContextLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

export const LogLevel = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;
