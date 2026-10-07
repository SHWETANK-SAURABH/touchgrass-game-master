/**
 * Base class for faults that are worth reporting but are not programmer bugs:
 * an unreachable model host, a rejected proposal, a malformed command. Each
 * carries a stable machine-readable `code` so logs and future Sentry grouping
 * do not depend on message text.
 */
export abstract class TouchGrassError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  toJSON(): { name: string; code: string; message: string; context: Record<string, unknown> } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/** Thrown when environment parsing fails — always fatal, always at startup. */
export class ConfigurationError extends TouchGrassError {
  readonly code = 'CONFIGURATION_INVALID';
}

/** Normalises an unknown `catch` binding into something loggable. */
export function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
