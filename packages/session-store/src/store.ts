import { type Result, err, ok } from '@touchgrass/shared';
import type { GameSessionSnapshot } from '@touchgrass/game-session';

/**
 * The persistence boundary.
 *
 *   GameSession → snapshot() → SessionStore.save
 *   SessionStore.load → restoreGameSession() → GameSession
 *
 * A store keeps snapshots and gives them back. That is all it does. It never
 * sees a live GameSession, it applies no rule of any game, and it does not
 * decide whether a snapshot is a valid game: `restoreGameSession` does that when
 * a snapshot is turned back into a session. The only thing a store checks is
 * its own key, the session id.
 *
 * Nothing calls a store on its own. A session does not know stores exist, and
 * neither does the realtime layer. Whatever uses a store decides when to save.
 *
 * The interface is asynchronous because a real store talks to something over a
 * network. It names no database: an implementation turns whatever goes wrong
 * underneath into one of the two errors below.
 */

export const SESSION_STORE_ERROR_CODES = [
  /** The session id is not one a session could have. Nothing was read or written. */
  'INVALID_SESSION_ID',
  /** The store could not complete the operation. */
  'STORAGE_ERROR',
] as const;
export type SessionStoreErrorCode = (typeof SESSION_STORE_ERROR_CODES)[number];

/** Why a store refused or failed. Plain data: a code and a sentence. */
export interface SessionStoreError {
  readonly code: SessionStoreErrorCode;
  readonly message: string;
}

export function sessionStoreError(code: SessionStoreErrorCode, message: string): SessionStoreError {
  return { code, message };
}

export interface SessionStore {
  /**
   * Stores a snapshot under its session id, replacing any snapshot already
   * stored for that id. The store keeps its own copy: changing the object that
   * was passed in afterwards does not change what is stored.
   */
  save(snapshot: GameSessionSnapshot): Promise<Result<void, SessionStoreError>>;

  /**
   * The snapshot stored for a session id, or null if there is none. Each call
   * returns a separate copy.
   */
  load(sessionId: string): Promise<Result<GameSessionSnapshot | null, SessionStoreError>>;

  /**
   * Removes the snapshot stored for a session id. Removing one that is not
   * there succeeds and changes nothing.
   */
  delete(sessionId: string): Promise<Result<void, SessionStoreError>>;
}

/**
 * Checks a value as a session id.
 *
 * The rule is the one sessions already have, not a new one: the engine accepts
 * any non-empty string as a session id when a game is created, and requires the
 * same of the id in a game state. So that is what a store accepts as a key.
 */
export function parseSessionId(value: unknown): Result<string, SessionStoreError> {
  if (typeof value !== 'string' || value.length === 0) {
    return err(sessionStoreError('INVALID_SESSION_ID', 'A session id is a non-empty string.'));
  }
  return ok(value);
}
