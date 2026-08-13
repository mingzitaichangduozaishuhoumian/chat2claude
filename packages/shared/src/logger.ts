export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export interface Logger { debug(message: string, meta?: unknown): void; info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void; }
export function createLogger(level: LogLevel = 'info'): Logger {
  const write = (entryLevel: LogLevel, message: string, meta?: unknown) => {
    if (weights[entryLevel] < weights[level]) return;
    const line = JSON.stringify({ level: entryLevel, message, meta, time: new Date().toISOString() });
    const sink = entryLevel === 'error' ? console.error : entryLevel === 'warn' ? console.warn : console.log;
    sink(line);
  };
  return { debug: (m, meta) => write('debug', m, meta), info: (m, meta) => write('info', m, meta), warn: (m, meta) => write('warn', m, meta), error: (m, meta) => write('error', m, meta) };
}
