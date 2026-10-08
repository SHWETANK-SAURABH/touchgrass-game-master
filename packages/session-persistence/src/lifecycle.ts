import { type Result, err, ok } from '@touchgrass/shared';
import { type GameSession, restoreGameSession } from '@touchgrass/game-session';
import {
  type SessionStore,
  type SessionStoreError,
  parseSessionId,
} from '@touchgrass/session-store';

/**
 * The persistence lifecycle of a session, as three explicit operations.
 *
 *   loadSession    store.load → restoreGameSession → GameSession
 *   saveSession    session.snapshot() → store.save
 *   deleteSession  store.delete
 *
 * This is the application-level code that sits between two things that do not
 * know about each other. A GameSession owns a running game and can describe
 * itself as a snapshot. A SessionStore keeps snapshots. Neither calls the other;
 * these functions do, and only when a caller asks.
 *
 * Who is right about what:
 *
 *  - The GameSession is the authority on the game while it runs.
 *  - The store holds the latest snapshot that was successfully saved, and
 *    nothing newer.
 *
 * Those two can differ. Changing a game and saving it are separate steps, with
 * no transaction around them. If an action is accepted and the save that follows
 * fails, the session keeps the change, the store keeps the older snapshot, and
 * the caller is told the save failed. Nothing is rolled back, nothing is retried
 * and nothing is saved again behind the caller's back.
 *
 * Nothing here runs on its own. There is no autosave, timer or queue, and no
 * table of sessions: the caller holds the GameSession it loaded or created, and
 * the store it passes in. These functions keep nothing between calls.
 */

export const SESSION_PERSISTENCE_ERROR_CODES = [
  /** The session id is not one a session could have. The store was not asked. */
  'INVALID_SESSION_ID',
  /** The store has no snapshot for this session. Nothing was created. */
  'SESSION_NOT_FOUND',
  /** The store could not complete the operation. */
  'STORAGE_ERROR',
  /** A snapshot was found, or offered, and is not one a session can be built from. */
  'INVALID_SNAPSHOT',
] as const;
export type SessionPersistenceErrorCode = (typeof SESSION_PERSISTENCE_ERROR_CODES)[number];

/**
 * Why a load, save or delete did not happen. Plain data.
 *
 * `cause` is the error from the layer underneath, when there was one: the
 * store's error, or the reason the session boundary refused a snapshot.
 */
export interface SessionPersistenceError {
  readonly code: SessionPersistenceErrorCode;
  readonly message: string;
  readonly cause?: { readonly code: string; readonly message: string };
}

function failure(
  code: SessionPersistenceErrorCode,
  message: string,
  cause?: { readonly code: string; readonly message: string },
): SessionPersistenceError {
  return cause
    ? { code, message, cause: { code: cause.code, message: cause.message } }
    : { code, message };
}

/** A store error keeps its code, which this vocabulary shares, and its message. */
function fromStore(error: SessionStoreError): SessionPersistenceError {
  return failure(error.code, error.message, error);
}

/**
 * A store is meant to report failure as a value. One that throws or rejects
 * instead is reported the same way, so a caller has one thing to handle.
 */
async function ask<T>(
  operation: () => Promise<Result<T, SessionStoreError>>,
): Promise<Result<T, SessionPersistenceError>> {
  try {
    const result = await operation();
    return result.ok ? result : err(fromStore(result.error));
  } catch {
    return err(failure('STORAGE_ERROR', 'The store failed without reporting an error.'));
  }
}

/**
 * Loads a stored session and rebuilds it.
 *
 * A session that was never saved is SESSION_NOT_FOUND. It is not created: making
 * a new game is a different decision, and it is the caller's.
 *
 * A snapshot that is found is handed to `restoreGameSession`, which validates it.
 * If it is refused, the result is INVALID_SNAPSHOT with the reason, and no
 * session is returned. The store is only read; a bad snapshot is left where it
 * is for someone to look at.
 */
export async function loadSession(
  store: SessionStore,
  sessionId: string,
): Promise<Result<GameSession, SessionPersistenceError>> {
  const id = parseSessionId(sessionId);
  if (!id.ok) return err(fromStore(id.error));

  const loaded = await ask(() => store.load(id.value));
  if (!loaded.ok) return loaded;
  if (loaded.value === null) {
    return err(failure('SESSION_NOT_FOUND', `No saved session "${id.value}".`));
  }

  const restored = restoreGameSession(loaded.value);
  if (!restored.ok) {
    return err(
      failure('INVALID_SNAPSHOT', 'The saved session could not be restored.', restored.error),
    );
  }
  // A store must give back the session that was asked for.
  if (restored.value.id !== id.value) {
    return err(
      failure('INVALID_SNAPSHOT', 'The store returned a snapshot of a different session.'),
    );
  }
  return ok(restored.value);
}

/**
 * Saves a session as it is now.
 *
 * It takes a GameSession, not a state: the snapshot is asked of the session
 * itself, so what is saved is what the session says it is. The store is called
 * once. If it fails, that is returned, and the session is exactly as it was:
 * still usable, still holding whatever it held.
 */
export async function saveSession(
  store: SessionStore,
  session: GameSession,
): Promise<Result<void, SessionPersistenceError>> {
  if (typeof (session as { snapshot?: unknown } | null | undefined)?.snapshot !== 'function') {
    return err(failure('INVALID_SNAPSHOT', 'Only a game session can be saved.'));
  }
  const snapshot = session.snapshot();
  return ask(() => store.save(snapshot));
}

/**
 * Deletes the stored snapshot of a session.
 *
 * It touches the store and nothing else. A GameSession that is still running
 * is not stopped, changed or told; it can be saved again. Deleting a session
 * that was never saved succeeds, as it does in the store.
 */
export async function deleteSession(
  store: SessionStore,
  sessionId: string,
): Promise<Result<void, SessionPersistenceError>> {
  const id = parseSessionId(sessionId);
  if (!id.ok) return err(fromStore(id.error));
  return ask(() => store.delete(id.value));
}
