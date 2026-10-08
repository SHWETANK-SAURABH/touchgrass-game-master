import { type Clock, type Result, err, ok, systemClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { type RealtimeServer, createRealtimeServer } from '@touchgrass/realtime';
import type { SessionPersistenceError } from '@touchgrass/session-persistence';
import type { SessionStore } from '@touchgrass/session-store';
import { type CreateSessionError, createPersistentSessions } from './persistent-sessions';
import { type SessionHandle, createSessionHandle, hostSession } from './session-handle';

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
 * Everything that belongs to the game alone, which is the session, the room,
 * the host token, the dirty marker and the save queue, is a SessionHandle. This
 * module adds the two things a handle does not have: a listener, and a store to
 * close.
 *
 * Saving happens in two places only. Creating a game saves its first snapshot.
 * After that, `save()` saves when it is called, and `shutdown()` saves once on
 * the way out if there is anything unsaved. Saves are made one at a time.
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

export interface PersistentServer extends SessionHandle {
  /** The port actually bound. */
  readonly port: number;
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

  // The handle is made now, while the session is exactly what the store holds.
  // It stops the listener first and closes the store last; the listener does
  // not exist yet, and is filled in below.
  let realtime: RealtimeServer | undefined;
  const handle = createSessionHandle({
    hosted: hostSession(
      ready.value,
      options.createToken ? { createToken: options.createToken } : {},
    ),
    persist: sessions.save,
    beforeStop: () => realtime?.close(),
    afterStop: () => store.close?.(),
  });

  try {
    realtime = await createRealtimeServer({
      room: handle.room,
      port: options.port,
      clock,
      ...(options.host ? { host: options.host } : {}),
    });
  } catch {
    return err({ code: 'SERVER_NOT_STARTED', message: 'The server could not start listening.' });
  }

  return ok({ ...handle, port: realtime.port });
}
