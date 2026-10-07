export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that stamps `fields` onto every subsequent line. */
  child(fields: Record<string, unknown>): Logger;
}

/**
 * Line-per-event JSON logger.
 *
 * Deliberately dependency-free: the interesting observability work in this
 * project is *what* gets logged around the model boundary — prompts, latency,
 * validation failures, safety rejections — not which logging library carries it.
 * A richer backend can be dropped in behind this interface later.
 */
export function createLogger(options: {
  level?: LogLevel;
  name?: string;
  bindings?: Record<string, unknown>;
  sink?: (line: string) => void;
}): Logger {
  const level = options.level ?? 'info';
  const minRank = LEVEL_RANK[level];
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (lineLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[lineLevel] < minRank) return;
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: lineLevel,
        ...(options.name ? { logger: options.name } : {}),
        msg: message,
        ...bindings,
        ...fields,
      }),
    );
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) =>
      createLogger({
        ...(options.level ? { level: options.level } : {}),
        ...(options.name ? { name: options.name } : {}),
        bindings: { ...bindings, ...fields },
        ...(options.sink ? { sink: options.sink } : {}),
      }),
  };
}
