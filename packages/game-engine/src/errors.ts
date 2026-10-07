/**
 * Why the engine refused a command.
 *
 * Returned as a value through `Result`, never thrown. A refusal is the normal,
 * expected outcome of an illegal command — the engine saying no is the engine
 * working, so the type system should force callers to handle it.
 */
export const ENGINE_ERROR_CODES = [
  'UNKNOWN_GAME',
  'INVALID_COMMAND',
  'WRONG_STATUS',
  'DUPLICATE_PLAYER',
  'UNKNOWN_PLAYER',
  'SESSION_FULL',
  'NOT_ENOUGH_PLAYERS',
  'ROLE_CONSTRAINT_VIOLATED',
  'NO_FURTHER_PHASE',
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export interface EngineError {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export function engineError(
  code: EngineErrorCode,
  message: string,
  context?: Record<string, unknown>,
): EngineError {
  return context ? { code, message, context } : { code, message };
}
