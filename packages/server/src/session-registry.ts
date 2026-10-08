import { type Result, err, ok } from '@touchgrass/shared';
import type { EngineContext } from '@touchgrass/game-engine';
import type { GameSession } from '@touchgrass/game-session';
import type { SessionPersistenceError } from '@touchgrass/session-persistence';
import type { ClosableSessionStore } from './persistent-server';
import {
  type CreateSessionError,
  createPersistentSessions,
  makeSession,
  saveNewSession,
} from './persistent-sessions';
import { createPlayerTokens } from './player-tokens';
import { type SessionHandle, createSessionHandle, hostSession } from './session-handle';

/**
 * The games loaded in one process.
 *
 *   SessionStore       one, shared, closed once
 *   SessionRegistry
 *     ├── SessionHandle A   its own session, room, host token, dirty marker, saves
 *     ├── SessionHandle B
 *     └── SessionHandle C
 *
 * The registry keeps one rule: an id has no loaded session, or exactly one. It
 * holds the handles, runs the operations on any one id one after another, and
 * closes the store when it shuts down. It never reads or changes a game: a
 * handle is handed out, and the session inside it stays the authority.
 *
 * Everything here is held by the registry that `createSessionRegistry` returns.
 * Nothing is kept at module level, so two registries know nothing of each other,
 * even over the same store. The rule is per registry and per process: it does
 * not stop another process, or another registry, loading the same session.
 *
 * A registry attaches no listener. Its handles are reached through their rooms
 * by whatever the application puts in front of them.
 */

/** The registry is shutting down or has shut down. It does not reopen. */
export interface RegistryClosedError {
  readonly code: 'REGISTRY_CLOSED';
  readonly message: string;
}

/** The session is loaded, so its stored snapshot was not deleted. */
export interface SessionLoadedError {
  readonly code: 'SESSION_LOADED';
  readonly message: string;
}

/** What one registry shutdown could not do. Everything else was done. */
export interface RegistryShutdownError {
  readonly code: 'SHUTDOWN_INCOMPLETE';
  readonly message: string;
  /** The sessions whose final save failed, each with its reason. */
  readonly failures: readonly {
    readonly sessionId: string;
    readonly error: SessionPersistenceError;
  }[];
  /** False if the store could not be closed. */
  readonly storeClosed: boolean;
}

export type RegistryShutdownResult = Result<void, RegistryShutdownError>;

export interface SessionRegistryOptions {
  /** Where snapshots are kept. Every handle uses it; only the registry closes it. */
  readonly store: ClosableSessionStore;
  /** Makes host tokens. Defaults to 32 random bytes. */
  readonly createToken?: () => string;
  /**
   * The key player tokens are worked out from: at least 32 random bytes. With
   * the same key, a player's token is the same in every room this registry
   * makes for their session, so they can resume after it is unloaded and loaded
   * again. Left out, a new key is made for this registry, and tokens last as
   * long as the registry does. The key is never stored or sent.
   */
  readonly tokenKey?: Uint8Array;
}

export interface SessionRegistry {
  /**
   * Creates a new game, saves its first snapshot, and loads it.
   *
   * An id that is loaded, being created, or already stored is refused with
   * SESSION_ALREADY_EXISTS. If anything fails, nothing is left behind: no entry,
   * no room, no host token, and the same id can be tried again.
   */
  readonly create: (
    command: unknown,
    ctx: EngineContext,
  ) => Promise<Result<SessionHandle, CreateSessionError | RegistryClosedError>>;
  /**
   * The handle of a session: the one already loaded, or else a new one restored
   * from the store. Asking again, or while a load is under way, gives the same
   * handle and reads the store no further. A failed load leaves nothing behind
   * and can be tried again.
   */
  readonly load: (
    sessionId: string,
  ) => Promise<Result<SessionHandle, SessionPersistenceError | RegistryClosedError>>;
  /** The handle of a session that is loaded here now. The store is not asked. */
  readonly get: (sessionId: string) => SessionHandle | undefined;
  /**
   * Deletes a stored snapshot. A loaded session is refused with SESSION_LOADED
   * and nothing is deleted: unload it first, with its handle's `close()` or
   * `shutdown()`. Nothing is loaded in order to delete it.
   */
  readonly delete: (
    sessionId: string,
  ) => Promise<Result<void, SessionPersistenceError | SessionLoadedError | RegistryClosedError>>;
  /**
   * Shuts down every loaded session, then closes the store, once.
   *
   * From the moment it is called, `create`, `load` and `delete` are refused.
   * Operations already under way are waited for, and a session one of them
   * loads is shut down with the rest. Every session is attempted, whatever
   * happens to the others, and the store is closed last, whatever happened.
   *
   * Calling it again returns the first call's result.
   */
  readonly shutdown: () => Promise<RegistryShutdownResult>;
}

/** What the registry holds for an id: a loaded session, or an operation on it. */
type Entry =
  | { readonly handle: SessionHandle }
  | {
      readonly kind: 'creating' | 'loading' | 'unloading' | 'deleting';
      /** Settles, without a value, when the operation is over. */
      readonly settled: Promise<void>;
      /** A load under way, for other callers of `load` to share. */
      result?: Promise<Result<SessionHandle, SessionPersistenceError | RegistryClosedError>>;
    };

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  const { store } = options;
  const sessions = createPersistentSessions(store);
  const entries = new Map<string, Entry>();
  const playerTokens = createPlayerTokens(options.tokenKey);
  let shuttingDown: Promise<RegistryShutdownResult> | undefined;

  const registryClosed = (): RegistryClosedError => ({
    code: 'REGISTRY_CLOSED',
    message: 'The session registry is shut down.',
  });

  /**
   * Takes an id for one operation. The returned function ends the operation:
   * it frees the id, unless a loaded session has taken its place, and lets
   * whatever was waiting for the id go on.
   */
  const reserve = (sessionId: string, kind: 'creating' | 'loading' | 'unloading' | 'deleting') => {
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = { kind, settled };
    entries.set(sessionId, entry);
    return {
      entry,
      release: (): void => {
        if (entries.get(sessionId) === entry) entries.delete(sessionId);
        settle();
      },
    };
  };

  /**
   * Makes the handle for a session that is stored as it is now, and registers
   * it. The room and the host token are new; the players' tokens are the ones
   * they have always had in this registry. When the handle stops, by its own
   * `close()` or `shutdown()`, its id is held until it has finished and then
   * freed; the store is left open.
   */
  const register = (session: GameSession): SessionHandle => {
    let unloading: { readonly release: () => void } | undefined;
    let unloaded = false;
    const handle = createSessionHandle({
      hosted: hostSession(session, {
        ...(options.createToken ? { createToken: options.createToken } : {}),
        playerToken: playerTokens(session.id),
      }),
      // A handle that has been unloaded no longer speaks for its session: the
      // id may have been loaded again, or its snapshot deleted.
      persist: (live) =>
        unloaded
          ? Promise.resolve(
              err({ code: 'STORAGE_ERROR', message: 'The session is no longer loaded.' }),
            )
          : sessions.save(live),
      beforeStop: () => {
        unloading = reserve(session.id, 'unloading');
      },
      afterStop: () => {
        unloaded = true;
        unloading?.release();
      },
    });
    entries.set(session.id, { handle });
    return handle;
  };

  const stopAll = async (): Promise<RegistryShutdownResult> => {
    const failures: { sessionId: string; error: SessionPersistenceError }[] = [];
    for (;;) {
      const all = [...entries.values()];
      // Operations already under way come first. One that loads a session
      // leaves it here to be shut down on the next turn of this loop.
      const busy = all.flatMap((entry) => ('handle' in entry ? [] : [entry.settled]));
      if (busy.length > 0) {
        await Promise.all(busy);
        continue;
      }
      const loaded = all.flatMap((entry) => ('handle' in entry ? [entry.handle] : []));
      if (loaded.length === 0) break;
      // Together: each session has its own saves, and none waits for another.
      await Promise.all(
        loaded.map(async (handle) => {
          const stopped = await handle.shutdown();
          if (!stopped.ok) failures.push({ sessionId: handle.session.id, error: stopped.error });
        }),
      );
    }

    let storeClosed = true;
    try {
      await store.close?.();
    } catch {
      storeClosed = false;
    }
    if (failures.length === 0 && storeClosed) return ok(undefined);
    return err({
      code: 'SHUTDOWN_INCOMPLETE',
      message: storeClosed
        ? 'Some sessions could not be saved.'
        : 'The session store could not be closed.',
      failures,
      storeClosed,
    });
  };

  return {
    async create(command, ctx) {
      if (shuttingDown) return err(registryClosed());
      const made = makeSession(command, ctx);
      if (!made.ok) return made;
      const session = made.value;

      for (;;) {
        const entry = entries.get(session.id);
        if (!entry) break;
        if ('handle' in entry || entry.kind === 'creating') {
          return err({
            code: 'SESSION_ALREADY_EXISTS',
            message: `A session "${session.id}" is already loaded.`,
          });
        }
        await entry.settled;
        if (shuttingDown) return err(registryClosed());
      }

      const { release } = reserve(session.id, 'creating');
      try {
        const saved = await saveNewSession(store, session);
        if (!saved.ok) return saved;
        // Only now, with the first snapshot stored, is there a room or a token.
        return ok(register(session));
      } finally {
        release();
      }
    },

    async load(sessionId) {
      for (;;) {
        if (shuttingDown) return err(registryClosed());
        const entry = entries.get(sessionId);
        if (!entry) break;
        if ('handle' in entry) return ok(entry.handle);
        if (entry.result) return entry.result;
        await entry.settled;
      }

      const { entry, release } = reserve(sessionId, 'loading');
      const restore = async (): Promise<Result<SessionHandle, SessionPersistenceError>> => {
        try {
          const loaded = await sessions.load(sessionId);
          if (!loaded.ok) return loaded;
          return ok(register(loaded.value));
        } finally {
          release();
        }
      };
      entry.result = restore();
      return entry.result;
    },

    get(sessionId) {
      const entry = entries.get(sessionId);
      return entry && 'handle' in entry ? entry.handle : undefined;
    },

    async delete(sessionId) {
      for (;;) {
        if (shuttingDown) return err(registryClosed());
        const entry = entries.get(sessionId);
        if (!entry) break;
        if ('handle' in entry) {
          return err({
            code: 'SESSION_LOADED',
            message: `The session "${sessionId}" is loaded. Unload it before deleting it.`,
          });
        }
        await entry.settled;
      }

      const { release } = reserve(sessionId, 'deleting');
      try {
        return await sessions.delete(sessionId);
      } finally {
        release();
      }
    },

    shutdown() {
      shuttingDown ??= stopAll();
      return shuttingDown;
    },
  };
}
