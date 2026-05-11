import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'warn';
const logFormat = process.env.LOG_FORMAT || 'json';

const pinoConfig = {
  level: logLevel,
  transport: logFormat === 'pretty'
    ? { target: 'pino-pretty', options: { destination: 2 } }
    : undefined,
};

export const log = logFormat === 'pretty'
  ? pino(pinoConfig)
  : pino(pinoConfig, pino.destination(2));

export function setLogLevel(level: string): void {
  log.level = level;
}

export function getLogLevel(): string {
  return log.level;
}
