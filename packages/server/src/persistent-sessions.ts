import { type Result, err, ok } from '@touchgrass/shared';
import type { EngineContext } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from '@touchgrass/game-session';
import {
  type SessionPersistenceError,
  deleteSession,
  loadSession,
  saveSession,
} from '@touchgrass/session-persistence';
import type { SessionStore } from '@touchgrass/session-store';

/**
 * Persistent sessions, as the application sees them.
 *
 * This is a thin layer over three things that already exist. It makes a game
 * through the session package, and saves, loads and deletes it through the
 * persistence lifecycle, against whatever SessionStore it was given. It adds one
 * operation of its own, `create`, and one rule: a session it says it created is
 * one whose first snapshot was really saved.
 *
 * It holds a store and nothing else. It keeps no table of sessions: a caller is
 * handed a GameSession and holds it. Loading the same id twice gives two
 * sessions that know nothing of each other.
 *
 * Saving is explicit. Nothing here, and nothing it calls, saves a session
 * because the game changed.
 */

/** A session could not be created, or was created and could not be saved. */
export type CreateSessionError =
  /** The game could not be created. `cause` is the session package's reason. */
  | {
      readonly code: 'SESSION_NOT_CREATED';
      readonly message: string;
      readonly cause: { readonly code: string; readonly message: string };
    }
  /** A session with this id is already stored. It was left as it is. */
  | { readonly code: 'SESSION_ALREADY_EXISTS'; readonly message: string }
  /** The store could not be read or written. */
  | SessionPersistenceError;

export interface PersistentSessions {
  /**
   * Creates a new game and saves its first snapshot.
   *
   * It succeeds only if the snapshot was saved. If saving fails, the failure is
   * returned and the session that was briefly made is dropped: no session comes
   * back, nothing is retried, and nothing remembers it.
   *
   * An id that is already stored is refused rather than overwritten.
   */
  readonly create: (
    command: unknown,
    ctx: EngineContext,
  ) => Promise<Result<GameSession, CreateSessionError>>;

  /**
   * Loads a stored session as a live GameSession, exactly as it was saved. A
   * session that is not stored is SESSION_NOT_FOUND; nothing is created.
   */
  readonly load: (sessionId: string) => Promise<Result<GameSession, SessionPersistenceError>>;

  /** Saves a live session as it is now. Called only when a caller chooses to. */
  readonly save: (session: GameSession) => Promise<Result<void, SessionPersistenceError>>;

  /** Deletes the stored snapshot. A session still running is not touched. */
  readonly delete: (sessionId: string) => Promise<Result<void, SessionPersistenceError>>;
}

export function createPersistentSessions(store: SessionStore): PersistentSessions {
  return {
    async create(command, ctx) {
      const created = createGameSession(command, ctx);
      if (!created.ok) {
        return err({
          code: 'SESSION_NOT_CREATED',
          message: 'The game could not be created.',
          cause: { code: created.error.code, message: created.error.message },
        });
      }
      const session = created.value;

      // Creating must not replace a game that is already stored under this id.
      const existing = await loadSession(store, session.id);
      if (existing.ok || existing.error.code === 'INVALID_SNAPSHOT') {
        return err({
          code: 'SESSION_ALREADY_EXISTS',
          message: `A session "${session.id}" is already stored.`,
        });
      }
      if (existing.error.code !== 'SESSION_NOT_FOUND') return existing;

      const saved = await saveSession(store, session);
      if (!saved.ok) return saved;
      return ok(session);
    },

    load: (sessionId) => loadSession(store, sessionId),
    save: (session) => saveSession(store, session),
    delete: (sessionId) => deleteSession(store, sessionId),
  };
}
