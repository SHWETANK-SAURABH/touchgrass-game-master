import { type Clock, type Result, err, ok, systemClock } from '@touchgrass/shared';
import type { EngineContext } from '@touchgrass/game-engine';
import type { GameSession, SessionUpdate } from '@touchgrass/game-session';
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
 *
 * A loaded session is in one of these states, and when it is in none of them it
 * is closed: not in memory, and still in the store.
 *
 *   active     it has at least one connection
 *   idle       it has none
 *   finished   its game is over, with connections or without
 *   closing    it is being evicted or unloaded
 *
 * Evicting a session releases what it holds in memory and keeps what is stored.
 * It is saved first if it has unsaved changes, and it is not released unless
 * that save succeeded. Deleting is a different operation and is never a
 * consequence of evicting.
 *
 * The registry has no timer. It evicts when `evict` or `evictIdle` is called,
 * and reads the time, when it needs it, from the clock it was given.
 */

/** A session with no connections for this long may be evicted: thirty minutes. */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
/** The same, for a session whose game is over: as soon as it has no connections. */
export const DEFAULT_FINISHED_IDLE_MS = 0;

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

/** The session has a connection, or changed while it was being saved. It stays loaded. */
export interface SessionInUseError {
  readonly code: 'SESSION_IN_USE';
  readonly message: string;
}

export type SessionLifecycleState = 'active' | 'idle' | 'finished' | 'closing';

/** A session that is in memory, and how it stands. One that is not listed is closed. */
export interface SessionInfo {
  readonly sessionId: string;
  readonly state: SessionLifecycleState;
  /** How many connections its room knows of, joined or not. */
  readonly connections: number;
  /** When a connection last arrived or went away, or the session was loaded. */
  readonly lastActiveAt?: number;
}

/**
 * Something that happened to a session. It carries the session id, the time and
 * at most an error code: never a token, a player or any part of a game.
 */
export interface SessionLifecycleEvent {
  readonly type:
    'created' | 'loaded' | 'idle' | 'eviction_started' | 'evicted' | 'eviction_failed' | 'unloaded';
  readonly sessionId: string;
  readonly at: number;
  /** For `eviction_failed`: why. */
  readonly code?: string;
}

/** What one sweep for unused sessions did. */
export interface EvictIdleResult {
  /** Sessions released from memory. */
  readonly evicted: readonly string[];
  /** Sessions that were due and could not be saved. They are still loaded. */
  readonly failed: readonly {
    readonly sessionId: string;
    readonly error: SessionPersistenceError;
  }[];
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
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * How long a session must have been without a connection before `evictIdle`
   * releases it. Defaults to DEFAULT_SESSION_IDLE_MS.
   */
  readonly idleMs?: number;
  /** The same, for a session whose game is over. Defaults to DEFAULT_FINISHED_IDLE_MS. */
  readonly finishedIdleMs?: number;
  /** Told what happens to sessions. A listener that throws is ignored. */
  readonly onEvent?: (event: SessionLifecycleEvent) => void;
  /**
   * Told each change a loaded session's room broadcasts, with the session's
   * id. It is what the connections are sent. A listener that throws is ignored.
   */
  readonly onUpdate?: (sessionId: string, update: SessionUpdate) => void;
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
   * Releases a loaded session from memory and keeps it in the store.
   *
   *   1. a session with a connection is refused with SESSION_IN_USE;
   *   2. it is saved if it has unsaved changes, after any save under way;
   *   3. if that save fails, the failure is returned and the session stays
   *      loaded, usable and unsaved;
   *   4. if a connection arrived or the game changed meanwhile, it is
   *      SESSION_IN_USE and stays loaded;
   *   5. otherwise its room is closed and its handle unloaded.
   *
   * A session that is not in memory is already evicted: that is success.
   * Calls that overlap share one eviction. Nothing is deleted.
   */
  readonly evict: (
    sessionId: string,
  ) => Promise<Result<void, SessionPersistenceError | SessionInUseError | RegistryClosedError>>;
  /**
   * Evicts every session that is due: no connections, and none for at least
   * `idleMs`, or `finishedIdleMs` if its game is over. Each is evicted as
   * `evict` does it, independently of the others. A session that turned out to
   * be in use is left alone and is in neither list.
   */
  readonly evictIdle: () => Promise<EvictIdleResult>;
  /** The sessions in memory and how each stands. The store is not asked. */
  readonly sessions: () => readonly SessionInfo[];
  /**
   * Shuts down every loaded session, then closes the store, once.
   *
   * From the moment it is called, `create`, `load`, `delete` and `evict` are
   * refused. An eviction under way is waited for.
   * Operations already under way are waited for, and a session one of them
   * loads is shut down with the rest. Every session is attempted, whatever
   * happens to the others, and the store is closed last, whatever happened.
   *
   * Calling it again returns the first call's result.
   */
  readonly shutdown: () => Promise<RegistryShutdownResult>;
}

/** A loaded session and what the registry knows of its use. */
interface Loaded {
  readonly handle: SessionHandle;
  /** How many connections its room knows of. */
  connections: number;
  /** When a connection last arrived or went away, or the session was loaded. */
  lastActiveAt: number;
  /** An eviction under way, for other callers of `evict` to share. */
  evicting?: Promise<Result<void, SessionPersistenceError | SessionInUseError>>;
}

/** What the registry holds for an id: a loaded session, or an operation on it. */
type Entry =
  | Loaded
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
  const clock = options.clock ?? systemClock;
  const idleMs = options.idleMs ?? DEFAULT_SESSION_IDLE_MS;
  const finishedIdleMs = options.finishedIdleMs ?? DEFAULT_FINISHED_IDLE_MS;
  let shuttingDown: Promise<RegistryShutdownResult> | undefined;

  const emit = (type: SessionLifecycleEvent['type'], sessionId: string, code?: string): void => {
    try {
      options.onEvent?.({ type, sessionId, at: clock.now(), ...(code ? { code } : {}) });
    } catch {
      // Being told is a courtesy. A listener that fails changes nothing here.
    }
  };

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
  const register = (session: GameSession, how: 'created' | 'loaded'): SessionHandle => {
    let unloading: { readonly release: () => void } | undefined;
    let unloaded = false;
    // Activity is a connection arriving or going away. Nothing else moves the
    // time: not a message, not a save, not anything trusted code does.
    const use = { connections: 0, lastActiveAt: clock.now() };
    const handle = createSessionHandle({
      hosted: hostSession(session, {
        ...(options.createToken ? { createToken: options.createToken } : {}),
        playerToken: playerTokens(session.id),
        onConnections: (count) => {
          const emptied = count === 0 && use.connections > 0;
          use.connections = count;
          use.lastActiveAt = clock.now();
          if (emptied) emit('idle', session.id);
        },
        ...(options.onUpdate
          ? { onUpdate: (update) => options.onUpdate?.(session.id, update) }
          : {}),
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
        emit('unloaded', session.id);
      },
    });
    entries.set(session.id, Object.assign(use, { handle }));
    emit(how, session.id);
    return handle;
  };

  /**
   * One eviction of a loaded session. The session stays registered, and so
   * reachable, until the moment it is known to be saved and unused; the check
   * and the start of the unload happen in one turn, so nothing can come between.
   */
  const evictLoaded = async (
    sessionId: string,
    entry: Loaded,
  ): Promise<Result<void, SessionPersistenceError | SessionInUseError>> => {
    const { handle } = entry;
    const inUse = (): Result<void, SessionInUseError> =>
      err({ code: 'SESSION_IN_USE', message: `The session "${sessionId}" is in use.` });
    if (entry.connections > 0) return inUse();
    emit('eviction_started', sessionId);

    // Through the handle's own save, so it waits for any save under way.
    if (handle.hasUnsavedChanges()) {
      const saved = await handle.save();
      if (!saved.ok) {
        emit('eviction_failed', sessionId, saved.error.code);
        return saved;
      }
    }
    // Its holder unloaded it while it was being saved. It is out of memory.
    if (entries.get(sessionId) !== entry) return ok(undefined);
    // A connection arrived, or the game changed, during the save. It is wanted.
    if (entry.connections > 0 || handle.hasUnsavedChanges()) {
      emit('eviction_failed', sessionId, 'SESSION_IN_USE');
      return inUse();
    }
    // Saved and unused. From this line the room is closed and the id is held.
    await handle.close();
    emit('evicted', sessionId);
    return ok(undefined);
  };

  const stopAll = async (): Promise<RegistryShutdownResult> => {
    const failures: { sessionId: string; error: SessionPersistenceError }[] = [];
    for (;;) {
      const all = [...entries.values()];
      // Operations already under way come first. One that loads a session
      // leaves it here to be shut down on the next turn of this loop.
      const busy = all.flatMap((entry): Promise<unknown>[] =>
        'handle' in entry ? (entry.evicting ? [entry.evicting] : []) : [entry.settled],
      );
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
        return ok(register(session, 'created'));
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
          return ok(register(loaded.value, 'loaded'));
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

    async evict(sessionId) {
      for (;;) {
        if (shuttingDown) return err(registryClosed());
        const entry = entries.get(sessionId);
        // Not in memory: there is nothing to release.
        if (!entry) return ok(undefined);
        if ('handle' in entry) {
          if (!entry.evicting) {
            // Cleared only after it has been set: an eviction that ends at once
            // must not be left standing as one that is under way.
            const eviction = evictLoaded(sessionId, entry).finally(() => {
              if (entry.evicting === eviction) delete entry.evicting;
            });
            entry.evicting = eviction;
          }
          return entry.evicting;
        }
        await entry.settled;
      }
    },

    async evictIdle() {
      if (shuttingDown) return { evicted: [], failed: [] };
      const now = clock.now();
      const due = [...entries].flatMap(([sessionId, entry]) => {
        if (!('handle' in entry) || entry.connections > 0 || entry.evicting) return [];
        const wait = entry.handle.isFinished() ? finishedIdleMs : idleMs;
        return now - entry.lastActiveAt >= wait ? [sessionId] : [];
      });

      const evicted: string[] = [];
      const failed: { sessionId: string; error: SessionPersistenceError }[] = [];
      // Together: one session's eviction never waits for another's.
      await Promise.all(
        due.map(async (sessionId) => {
          const result = await this.evict(sessionId);
          if (result.ok) evicted.push(sessionId);
          else if (
            result.error.code !== 'SESSION_IN_USE' &&
            result.error.code !== 'REGISTRY_CLOSED'
          ) {
            failed.push({ sessionId, error: result.error });
          }
        }),
      );
      return { evicted, failed };
    },

    sessions() {
      return [...entries].flatMap(([sessionId, entry]): SessionInfo[] => {
        if (!('handle' in entry)) {
          return entry.kind === 'unloading'
            ? [{ sessionId, state: 'closing', connections: 0 }]
            : [];
        }
        const state: SessionLifecycleState = entry.evicting
          ? 'closing'
          : entry.handle.isFinished()
            ? 'finished'
            : entry.connections > 0
              ? 'active'
              : 'idle';
        return [
          { sessionId, state, connections: entry.connections, lastActiveAt: entry.lastActiveAt },
        ];
      });
    },

    shutdown() {
      shuttingDown ??= stopAll();
      return shuttingDown;
    },
  };
}
