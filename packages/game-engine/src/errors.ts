/**
 * Why the engine refused something.
 *
 * Returned as a value through `Result`, never thrown. A refusal is the normal,
 * expected outcome of an illegal command, action or event — the engine saying no
 * is the engine working, so the type system should force callers to handle it.
 */
export const ENGINE_ERROR_CODES = [
  /** The game definition is unknown or unusable. */
  'INVALID_GAME_CONFIGURATION',
  /** The state itself is inconsistent; it should never have been produced. */
  'INVALID_GAME_STATE',
  /** The lifecycle status does not allow this. */
  'INVALID_STATE_TRANSITION',
  /** Something that is only possible before the game starts. */
  'GAME_ALREADY_STARTED',
  /** The game has finished or been stopped. */
  'GAME_ALREADY_COMPLETED',
  /** The player is not in this game, or has left it. */
  'INVALID_PLAYER',
  /** The player is already in this game. */
  'DUPLICATE_PLAYER',
  /** The game is full. */
  'PLAYER_LIMIT_EXCEEDED',
  /** Too few players to start. */
  'NOT_ENOUGH_PLAYERS',
  /** The role does not exist, or the player does not hold the role required. */
  'INVALID_ROLE',
  /** There is no such phase to move to. */
  'INVALID_PHASE',
  /** The action is malformed, or not one this player may take now. */
  'INVALID_ACTION',
  /** The event is malformed, or refers to something that does not exist. */
  'INVALID_EVENT',
  /** The event is well formed but this game does not support its kind. */
  'UNSUPPORTED_EVENT',
  /** The modifier is not one this game allows. */
  'INVALID_MODIFIER',
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
