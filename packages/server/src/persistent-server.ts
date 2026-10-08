import { type Clock, type Result, err, ok, systemClock } from '@touchgrass/shared';
import { type GameState, contextAt } from '@touchgrass/game-engine';
import type { GameSession } from '@touchgrass/game-session';
import {
  type RealtimeServer,
  type Room,
  createRealtimeServer,
  createRoom,
  createToken,
} from '@touchgrass/realtime';
import type { SessionPersistenceError } from '@touchgrass/session-persistence';
import type { SessionStore } from '@touchgrass/session-store';
import { type CreateSessionError, createPersistentSessions } from './persistent-sessions';

/**
 * A server for one persistent game.
 *
 *   store ──► create or load ──► GameSession ──► Room ──► WebSocket server
 *
 * It is the place where the pieces meet, and each keeps its own job:
 *
 *   the store     keeps snapshots
 *   the session   owns the running game
 *   the room      owns connections and bearer tokens
 *   this module   starts them, saves when asked, and shuts them down
 *
 * One server is one room around one session, as before. A session that is
 * loaded is the session the room is built around: it is not copied.
 *
 * Saving happens in two places only. Creating a game saves its first snapshot.
 * After that, `save()` saves when it is called, and `shutdown()` saves once on
 * the way out if there is anything unsaved. `hasUnsavedChanges()` says whether
 * there is, and never saves. `close()` never saves. No join, action, host command,
 * tick, leave, resume or disconnect saves anything; the room does not know a
 * store exists.
 *
 * The room is always new. Bearer tokens and connections are not in a snapshot,
 * so a loaded game starts with a new host token and no player tokens: the
 * players are all still in the game, and none of them can resume with a token
 * they were given before.
 *
 * A loaded game is not adjusted. Its timers, rounds, scores and roles are what
 * was saved. Nothing is advanced, paused or reset because time has passed.
 */

/** A store the server may also be asked to close, as the MongoDB store can be. */
export type ClosableSessionStore = SessionStore & { close?: () => Promise<void> };

/** A game a room has been made for. */
export interface HostedSession {
  readonly session: GameSession;
  readonly room: Room;
  /** A new bearer secret for the host role. It is not stored anywhere. */
  readonly hostToken: string;
}

/**
 * Makes a room around a session that already exists. The session is used as it
 * is; the room and the host token are new.
 */
export function hostSession(
  session: GameSession,
  options: { readonly createToken?: () => string } = {},
): HostedSession {
  const hostToken = (options.createToken ?? createToken)();
  const room = createRoom({ session, hostToken, ...options });
  return { session, room, hostToken };
}

export interface PersistentServerOptions {
  /** Where snapshots are kept. The server uses it and, on `close`, closes it. */
  readonly store: ClosableSessionStore;
  /** Create a new game from this command, or load the one with this id. */
  readonly game: { readonly create: unknown } | { readonly load: string };
  /** The port to listen on. 0 picks a free one. */
  readonly port: number;
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  readonly host?: string;
  readonly createToken?: () => string;
}

export interface PersistentServer extends HostedSession {
  /** The port actually bound. */
  readonly port: number;
  /**
   * Saves the game as it is now. This is the explicit save: nothing else calls
   * it. A failure is returned and changes nothing in the running game.
   */
  readonly save: () => Promise<Result<void, SessionPersistenceError>>;
  /**
   * Whether the game has changed since this server last saved it successfully.
   *
   * It is a question, not a trigger: a true answer saves nothing. It compares
   * the session's current state with the exact state object that was last
   * saved, which is kept here in memory and nowhere else.
   *
   * It speaks only for this server. It does not know whether another process
   * has overwritten or deleted what is stored.
   */
  readonly hasUnsavedChanges: () => boolean;
  /**
   * Stops listening, closes every connection, then closes the store. It does
   * not save: whatever has changed since the last save is discarded. Calling it
   * again, or after `shutdown`, does nothing.
   *
   * The store is closed even if stopping the realtime server fails; the failure
   * is then thrown.
   */
  readonly close: () => Promise<void>;
  /**
   * Stops gracefully, keeping the game:
   *
   *   1. stops the realtime server, so no client can change the game any more;
   *   2. saves the game, once, if it has unsaved changes;
   *   3. closes the store.
   *
   * It returns the result of that final save, or success if nothing needed
   * saving. If the save fails the store is still closed, the failure is
   * returned, nothing is retried, and `hasUnsavedChanges()` stays true.
   *
   * Calling it again returns the first call's result and does nothing more.
   * After `close` it does nothing: the store is closed and nothing can be saved.
   *
   * The store is closed even if stopping the realtime server fails; the final
   * save is still attempted, and the failure is then thrown.
   */
  readonly shutdown: () => Promise<Result<void, SessionPersistenceError>>;
}

export type PersistentServerError =
  | CreateSessionError
  /** The game is ready but the server could not listen. Nothing is left running. */
  | { readonly code: 'SERVER_NOT_STARTED'; readonly message: string };

/**
 * Creates or loads a game and serves it.
 *
 * If the game cannot be created, saved or loaded, or the port cannot be bound,
 * the reason is returned and nothing is left running. The store is not closed
 * in that case: the caller gave it and still owns it.
 */
export async function startPersistentServer(
  options: PersistentServerOptions,
): Promise<Result<PersistentServer, PersistentServerError>> {
  const { store } = options;
  const clock = options.clock ?? systemClock;
  const sessions = createPersistentSessions(store);

  const game = options.game;
  const ready =
    'load' in game
      ? await sessions.load(game.load)
      : await sessions.create(game.create, contextAt(clock));
  if (!ready.ok) return ready;

  // The state the store is known to hold. A created game has just been saved
  // and a loaded one has just been read, so at this moment it is the session's
  // own state. A GameSession replaces its state object only when the game
  // really changes, so comparing references is an exact test for "changed".
  let lastSavedState: GameState = ready.value.getState();

  const hosted = hostSession(
    ready.value,
    options.createToken ? { createToken: options.createToken } : {},
  );

  let realtime: RealtimeServer;
  try {
    realtime = await createRealtimeServer({
      room: hosted.room,
      port: options.port,
      clock,
      ...(options.host ? { host: options.host } : {}),
    });
  } catch {
    return err({ code: 'SERVER_NOT_STARTED', message: 'The server could not start listening.' });
  }

  const save = async (): Promise<Result<void, SessionPersistenceError>> => {
    // Taken before the save is awaited. The game may change while the store is
    // working, and what was saved is this state, not whatever came after.
    const stateBeingSaved = hosted.session.getState();
    const saved = await sessions.save(hosted.session);
    if (saved.ok) lastSavedState = stateBeingSaved;
    return saved;
  };
  const hasUnsavedChanges = (): boolean => hosted.session.getState() !== lastSavedState;

  /**
   * Stops the realtime server and closes the store, with one save in between if
   * asked for and needed. The store is closed whatever happens before it. If the
   * realtime server or the store fails to close, the first such failure is
   * thrown once everything has been attempted.
   */
  const stop = async (finalSave: boolean): Promise<Result<void, SessionPersistenceError>> => {
    let failure: { readonly error: unknown } | undefined;
    try {
      await realtime.close();
    } catch (error) {
      failure = { error };
    }

    let saved: Result<void, SessionPersistenceError> = ok(undefined);
    if (finalSave && hasUnsavedChanges()) saved = await save();

    try {
      await store.close?.();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
    return saved;
  };

  let closed = false;
  let shuttingDown: Promise<Result<void, SessionPersistenceError>> | undefined;

  return ok({
    ...hosted,
    port: realtime.port,
    save,
    hasUnsavedChanges,
    async close() {
      if (closed) return;
      closed = true;
      await stop(false);
    },
    shutdown() {
      if (shuttingDown) return shuttingDown;
      // Already closed without saving. The store is gone; there is nothing to do.
      if (closed) return Promise.resolve(ok(undefined));
      closed = true;
      shuttingDown = stop(true);
      return shuttingDown;
    },
  });
}
