import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Clock, type Result, err, ok } from '@touchgrass/shared';
import {
  type RouteError,
  type RoutedRealtimeServer,
  createRoutedRealtimeServer,
} from '@touchgrass/realtime';
import type { SessionUpdate } from '@touchgrass/game-session';
import {
  type GameMasterAudit,
  type GameMasterTurnsOptions,
  createGameMasterTurns,
  gameMasterTriggerFor,
} from './game-master-turns';
import { type ObservabilityOptions, createObserver } from './observability';
import type { ClosableSessionStore } from './persistent-server';
import {
  type RegistryShutdownResult,
  type SessionLifecycleEvent,
  type SessionRegistry,
  createSessionRegistry,
} from './session-registry';

/**
 * One listener for many persistent games.
 *
 *   client ──► ws://host/sessions/<sessionId>
 *                │   the address chooses the session, once, at connect time
 *                ▼
 *          SessionRegistry     get, or load from the one store
 *                ▼
 *          SessionHandle
 *                ▼
 *          Room ──► GameSession
 *
 * Each piece keeps its own job. The transport reads the address and asks for a
 * room. The registry decides which sessions are loaded and is the only thing
 * that loads one. The room owns the connection from then on, exactly as it does
 * behind a single-game server: the same messages, the same checks, the same
 * broadcasts, to that room's connections and no others.
 *
 * This module holds one registry over one store and one listener. It keeps no
 * table of its own, reads no game, and saves nothing itself.
 *
 * A session is not created over the network. The protocol has no message for
 * it, and nothing authenticates who would be asking. Trusted server code creates
 * sessions through `registry.create`.
 */

export interface SessionServerOptions {
  /** Where snapshots are kept. One store for every session; closed by `shutdown`. */
  readonly store: ClosableSessionStore;
  /** The port to listen on. 0 picks a free one. */
  readonly port: number;
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  readonly host?: string;
  readonly createToken?: () => string;
  /** The key player tokens are worked out from. See the registry's `tokenKey`. */
  readonly tokenKey?: Uint8Array;
  /** When an unused session may be evicted. See the registry's `idleMs`. */
  readonly idleMs?: number;
  /** The same, for a session whose game is over. */
  readonly finishedIdleMs?: number;
  /** Told what happens to sessions. See the registry's `onEvent`. */
  readonly onEvent?: (event: SessionLifecycleEvent) => void;
  /**
   * The Game Master, if there is to be one. Left out, no model is ever asked
   * and the games run exactly as they do without it.
   */
  readonly gameMaster?: GameMasterTurnsOptions;
  /**
   * Counters, log lines and error reports for everything this server runs. Each
   * part is optional, and with none of them the server behaves exactly the same.
   */
  readonly observability?: ObservabilityOptions;
  /** Answers plain HTTP requests on the same port. See the routed listener's `http`. */
  readonly http?: (request: IncomingMessage, response: ServerResponse) => void;
  /** How often to ping attached sockets. See the routed listener's `heartbeatMs`. */
  readonly heartbeatMs?: number;
}

export interface SessionServer {
  /** The port actually bound. */
  readonly port: number;
  /**
   * The registry behind the listener, for trusted server code: creating a
   * session, saving one, evicting or unloading one, deleting one.
   */
  readonly registry: SessionRegistry;
  /** How many sockets are open, with a session or not. */
  readonly socketCount: () => number;
  /** The most recent Game Master records, oldest first. Kept in memory only. */
  readonly recentGameMasterAudits: () => readonly GameMasterAudit[];
  /**
   * Takes one Game Master turn for a session that is loaded here, for trusted
   * server code. It resolves with what the turn did. Nothing is loaded for it:
   * a session that is not in memory gets no turn. With no Game Master
   * configured, no model is asked.
   */
  readonly runGameMaster: (sessionId: string) => Promise<GameMasterAudit | GameMasterNotRun>;
  /**
   * Stops gracefully:
   *
   *   1. new connections are refused with SESSION_CLOSED;
   *   2. the registry shuts down: every session's connections are closed, each
   *      session is saved once if it has unsaved changes, and the store closes;
   *   3. the listener stops, and any socket still open is closed.
   *
   * It returns the registry's result. Calling it again returns the first
   * call's result. If the listener fails to stop, that is thrown after
   * everything else has been done.
   */
  readonly shutdown: () => Promise<RegistryShutdownResult>;
}

/** A Game Master turn that was not taken, and why. No model was asked. */
export interface GameMasterNotRun {
  readonly outcome: 'SKIPPED';
  readonly sessionId: string;
  readonly code: 'GAME_MASTER_DISABLED' | 'SESSION_NOT_LOADED' | 'SERVER_STOPPING';
}

export interface SessionServerError {
  readonly code: 'SERVER_NOT_STARTED';
  readonly message: string;
}

/**
 * Starts serving every session in the store from one listener.
 *
 * If the port cannot be bound, the reason is returned, nothing is left running,
 * and the store is not closed: the caller gave it and still owns it.
 */
export async function startSessionServer(
  options: SessionServerOptions,
): Promise<Result<SessionServer, SessionServerError>> {
  const observer = createObserver(options.observability);
  const gameMaster = options.gameMaster;
  const turns = gameMaster
    ? createGameMasterTurns({
        ...(options.clock ? { clock: options.clock } : {}),
        ...gameMaster,
        // The caller's own listeners are still told; the observer is told first.
        onAudit: (audit) => {
          observer.onGameMasterAudit(audit);
          gameMaster.onAudit?.(audit);
        },
        onUnexpectedError: (error) => {
          observer.onUnexpectedError(error, {
            area: 'game_master',
            stage: 'turn',
            provider: gameMaster.gameMaster.provider,
            model: gameMaster.gameMaster.model,
          });
          gameMaster.onUnexpectedError?.(error);
        },
      })
    : undefined;
  let stopping: Promise<RegistryShutdownResult> | undefined;

  const registry: SessionRegistry = createSessionRegistry({
    store: options.store,
    ...(options.createToken ? { createToken: options.createToken } : {}),
    ...(options.tokenKey ? { tokenKey: options.tokenKey } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.finishedIdleMs === undefined ? {} : { finishedIdleMs: options.finishedIdleMs }),
    onEvent: (event) => {
      observer.onSessionEvent(event);
      options.onEvent?.(event);
    },
    // The trigger policy is applied here, to what the engine recorded. The
    // model has no say in whether or when it is asked.
    ...(turns
      ? {
          onUpdate: (sessionId: string, update: SessionUpdate) => {
            const trigger = gameMasterTriggerFor(update);
            const handle = trigger && !stopping ? registry.get(sessionId) : undefined;
            if (trigger && handle) void turns.run(handle, trigger);
          },
        }
      : {}),
  });

  /** The room of a session: the one already loaded, or else loaded now. */
  const route = async (sessionId: string) => {
    if (stopping) return 'SESSION_CLOSED' satisfies RouteError;
    const loaded = registry.get(sessionId);
    if (loaded) return loaded.room;

    const found = await registry.load(sessionId);
    if (found.ok) return found.value.room;
    // The reason is reduced to what a client may know. No storage detail leaves.
    const refusal: RouteError =
      found.error.code === 'SESSION_NOT_FOUND'
        ? 'SESSION_NOT_FOUND'
        : found.error.code === 'INVALID_SESSION_ID'
          ? 'INVALID_SESSION_PATH'
          : found.error.code === 'REGISTRY_CLOSED'
            ? 'SESSION_CLOSED'
            : 'SESSION_UNAVAILABLE';
    return refusal;
  };

  let realtime: RoutedRealtimeServer;
  try {
    realtime = await createRoutedRealtimeServer({
      route,
      onSocket: observer.onSocketEvent,
      onError: (error) => {
        observer.onUnexpectedError(error, { area: 'realtime', stage: 'listener' });
      },
      port: options.port,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.http ? { http: options.http } : {}),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    });
  } catch {
    return err({ code: 'SERVER_NOT_STARTED', message: 'The server could not start listening.' });
  }

  const stop = async (): Promise<RegistryShutdownResult> => {
    const result = await registry.shutdown();
    if (!result.ok) {
      observer.onFailure('server shutdown incomplete', {
        area: 'persistence',
        stage: 'shutdown',
        code: result.error.storeClosed ? 'SESSIONS_NOT_SAVED' : 'STORE_NOT_CLOSED',
      });
    }
    try {
      await realtime.close();
    } catch (error) {
      observer.onUnexpectedError(error, { area: 'realtime', stage: 'close' });
      throw error;
    }
    return result;
  };

  return ok({
    port: realtime.port,
    registry,
    socketCount: realtime.socketCount,
    recentGameMasterAudits: observer.recentAudits,
    runGameMaster(sessionId) {
      const notRun = (code: GameMasterNotRun['code']): Promise<GameMasterNotRun> =>
        Promise.resolve({ outcome: 'SKIPPED', sessionId, code });
      if (!turns) return notRun('GAME_MASTER_DISABLED');
      if (stopping) return notRun('SERVER_STOPPING');
      const handle = registry.get(sessionId);
      return handle ? turns.run(handle, 'manual') : notRun('SESSION_NOT_LOADED');
    },
    shutdown() {
      stopping ??= stop();
      return stopping;
    },
  });
}
