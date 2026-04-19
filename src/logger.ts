import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'warn';
const logFormat = process.env.LOG_FORMAT || 'json';

const pinoConfig = {
  level: logLevel,
  transport: logFormat === 'pretty'
    ? { target: 'pino-pretty' }
    : undefined,
};

export const log = pino(pinoConfig);

export function setLogLevel(level: string): void {
  log.level = level;
}

export function getLogLevel(): string {
  return log.level;
}
