import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Clock,
  type Logger,
  type Result,
  createJoinCode,
  createSessionId,
  seedFromString,
  systemClock,
} from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { loadSession } from '@touchgrass/session-persistence';
import type { GameMasterTurnsOptions } from './game-master-turns';
import { type Metrics, createMetrics } from './metrics';
import type { ClosableSessionStore } from './persistent-server';
import type { ProductionConfig } from './production-config';
import { type ErrorReporter, noopReporter } from './reporting';
import { type SessionServer, type SessionServerError, startSessionServer } from './session-server';

/**
 * The deployed server.
 *
 *   one process, one port
 *     ├── WebSocket   /sessions/<sessionId>          players and hosts
 *     ├── GET         /healthz                       is the process alive
 *     ├── GET         /readyz                        can it serve
 *     └── /admin/…    with the admin token only      create, save, metrics
 *
 * This module is the multi-session server with the things only a deployment
 * needs put around it: health answers, a way for an operator to create a
 * session without a terminal, the eviction sweep on a timer, and a shutdown
 * that finishes or gives up within a known time. It adds no game rule, and the
 * path from a model's proposal to a game is exactly what it was.
 *
 * It answers plain HTTP only for the handful of paths above. Every answer is a
 * small JSON object with a fixed shape. No answer contains an error's own
 * text, a stack, a configuration value, a token it was not asked to issue, or
 * anything about a game beyond what an admin just created.
 */

export interface ProductionServerOptions {
  readonly config: ProductionConfig;
  /** Where snapshots are kept. Closed by `shutdown`. */
  readonly store: ClosableSessionStore;
  /** The Game Master, already built, if there is to be one. */
  readonly gameMaster?: GameMasterTurnsOptions;
  readonly logger?: Logger;
  readonly reporter?: ErrorReporter;
  readonly metrics?: Metrics;
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  /** How long one readiness check of the store may take. Default 2 seconds. */
  readonly readinessTimeoutMs?: number;
  /** For how long an answer about the store is reused. Default 5 seconds. */
  readonly readinessCacheMs?: number;
}

export type Readiness =
  | { readonly status: 'ready'; readonly checks: { readonly store: 'ok' } }
  | { readonly status: 'not_ready'; readonly checks: { readonly store: 'unavailable' } }
  | { readonly status: 'shutting_down' };

export interface ProductionShutdownResult {
  /** True when every session was saved, the store closed, and it all finished in time. */
  readonly ok: boolean;
  /** True when the time limit ran out before the shutdown finished. */
  readonly timedOut: boolean;
}

export interface ProductionServer {
  /** The port actually bound. */
  readonly port: number;
  readonly sessions: SessionServer;
  readonly metrics: Metrics;
  /** Whether the server can serve right now. The store is asked at most once per cache period. */
  readonly readiness: () => Promise<Readiness>;
  /**
   * Stops gracefully, within the configured time:
   *
   *   1. readiness turns to `shutting_down`, so a load balancer stops sending;
   *   2. the eviction sweep stops;
   *   3. the session server shuts down: new connections and new Game Master
   *      turns are refused, every room is closed, every session with unsaved
   *      changes is saved once, the store is closed, and the listener stops;
   *   4. what was reported to the error monitor is flushed.
   *
   * Calling it again returns the first call's result.
   */
  readonly shutdown: () => Promise<ProductionShutdownResult>;
}

/** A session id used only to ask the store whether it is there. It is never created. */
const READINESS_PROBE_ID = 'readiness-probe';
const MAX_ADMIN_BODY_BYTES = 1_024;

/** Resolves with the work's result, or with `'TIMED_OUT'` once the limit passes. */
async function within<T>(milliseconds: number, work: Promise<T>): Promise<T | 'TIMED_OUT'> {
  const limit = AbortSignal.timeout(milliseconds);
  const timedOut = new Promise<'TIMED_OUT'>((resolve) => {
    limit.addEventListener(
      'abort',
      () => {
        resolve('TIMED_OUT');
      },
      { once: true },
    );
  });
  work.catch(() => undefined);
  return Promise.race([work, timedOut]);
}

function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

/** The request's JSON body, or why it could not be used. Never more than a small fixed size. */
function readJson(
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; value: unknown } | { ok: false; status: number }): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ADMIN_BODY_BYTES) {
        finish({ ok: false, status: 413 });
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => {
      finish({ ok: false, status: 400 });
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return finish({ ok: true, value: {} });
      try {
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch {
        finish({ ok: false, status: 400 });
      }
    });
  });
}

export async function startProductionServer(
  options: ProductionServerOptions,
): Promise<Result<ProductionServer, SessionServerError>> {
  const { config, store, logger } = options;
  const clock = options.clock ?? systemClock;
  const reporter = options.reporter ?? noopReporter;
  const metrics = options.metrics ?? createMetrics();
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 2_000;
  const readinessCacheMs = options.readinessCacheMs ?? 5_000;
  let stopping: Promise<ProductionShutdownResult> | undefined;

  // ---- readiness ------------------------------------------------------------------------
  // The store is the one thing this server cannot serve without. The model
  // runtime is not asked: a game is played perfectly well with no Game Master.
  let lastCheck: { readonly at: number; readonly ok: boolean } | undefined;
  let checking: Promise<boolean> | undefined;
  const storeAnswers = (): Promise<boolean> => {
    if (lastCheck && clock.now() - lastCheck.at < readinessCacheMs) {
      return Promise.resolve(lastCheck.ok);
    }
    // One question at a time, however many are asking.
    // Asked through the persistence lifecycle, like every other read. A store
    // that answers "there is no such session" has answered.
    checking ??= within(readinessTimeoutMs, loadSession(store, READINESS_PROBE_ID))
      .then(
        (answer) =>
          answer !== 'TIMED_OUT' && (answer.ok || answer.error.code === 'SESSION_NOT_FOUND'),
      )
      .catch(() => false)
      .then((answered) => {
        lastCheck = { at: clock.now(), ok: answered };
        checking = undefined;
        return answered;
      });
    return checking;
  };
  const readiness = async (): Promise<Readiness> => {
    if (stopping) return { status: 'shutting_down' };
    return (await storeAnswers())
      ? { status: 'ready', checks: { store: 'ok' } }
      : { status: 'not_ready', checks: { store: 'unavailable' } };
  };

  // ---- plain HTTP -----------------------------------------------------------------------
  // Filled in once the session server is listening. Until then, and while
  // stopping, the admin paths say they are unavailable.
  const live: { sessions?: SessionServer } = {};

  const admin = async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> => {
    // With no admin token configured these paths do not exist at all.
    if (config.adminToken === undefined) return send(response, 404, { error: 'NOT_FOUND' });
    const presented = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!sameToken(presented, config.adminToken)) {
      response.setHeader('www-authenticate', 'Bearer');
      return send(response, 401, { error: 'UNAUTHORIZED' });
    }
    const sessions = live.sessions;
    if (!sessions || stopping) return send(response, 503, { error: 'UNAVAILABLE' });

    if (path === '/admin/metrics') {
      if (request.method !== 'GET') return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return send(response, 200, metrics.read());
    }

    if (path === '/admin/sessions') {
      if (request.method !== 'POST') return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const body = await readJson(request);
      if (!body.ok) return send(response, body.status, { error: 'BAD_REQUEST' });
      const gameId = (body.value as { gameId?: unknown } | null)?.gameId ?? 'tag';
      if (typeof gameId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(gameId)) {
        return send(response, 400, { error: 'BAD_REQUEST' });
      }
      const sessionId = createSessionId();
      const created = await sessions.registry.create(
        {
          type: 'CREATE_SESSION',
          sessionId,
          gameId,
          joinCode: createJoinCode(),
          randomSeed: seedFromString(sessionId),
        },
        contextAt(clock),
      );
      if (!created.ok) {
        // The code, and never the message: a message may say anything.
        const refused = created.error.code === 'SESSION_NOT_CREATED';
        return send(response, refused ? 400 : 503, { error: created.error.code });
      }
      // The one time the host token leaves the process, to the admin who asked.
      return send(response, 201, {
        sessionId,
        gameId: created.value.session.getState().gameId,
        joinCode: created.value.session.getState().joinCode,
        hostToken: created.value.hostToken,
        path: `/sessions/${sessionId}`,
      });
    }

    const save = /^\/admin\/sessions\/([^/]{1,200})\/save$/.exec(path);
    if (save) {
      if (request.method !== 'POST') return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(save[1] ?? '');
      } catch {
        return send(response, 400, { error: 'BAD_REQUEST' });
      }
      const handle = sessions.registry.get(sessionId);
      if (!handle) return send(response, 404, { error: 'SESSION_NOT_LOADED' });
      const saved = await handle.save();
      return saved.ok
        ? send(response, 200, { saved: true })
        : send(response, 503, { error: saved.error.code });
    }

    return send(response, 404, { error: 'NOT_FOUND' });
  };

  const http = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const reading = request.method === 'GET' || request.method === 'HEAD';

    if (path === '/healthz') {
      if (!reading) return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      // Alive is alive, even while shutting down: restarting it would not help.
      return send(response, 200, { status: 'ok' });
    }
    if (path === '/readyz') {
      if (!reading) return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      void readiness().then((state) => {
        send(response, state.status === 'ready' ? 200 : 503, state);
      });
      return;
    }
    if (path === '/admin' || path.startsWith('/admin/')) {
      void admin(request, response, path).catch((error: unknown) => {
        reporter.captureError(error, { area: 'server', stage: 'admin' });
        if (!response.headersSent) send(response, 500, { error: 'INTERNAL' });
        else response.end();
      });
      return;
    }
    send(response, 404, { error: 'NOT_FOUND' });
  };

  // ---- the session server ---------------------------------------------------------------
  const started = await startSessionServer({
    store,
    port: config.port,
    host: config.host,
    clock,
    idleMs: config.lifecycle.idleMs,
    finishedIdleMs: config.lifecycle.finishedIdleMs,
    heartbeatMs: config.heartbeatMs,
    http,
    ...(config.tokenKey ? { tokenKey: config.tokenKey } : {}),
    ...(options.gameMaster ? { gameMaster: options.gameMaster } : {}),
    observability: { metrics, reporter, ...(logger ? { logger } : {}) },
  });
  if (!started.ok) return started;
  live.sessions = started.value;
  const running = started.value;

  // The eviction sweep. It only asks the registry to look, and never keeps the
  // process alive by itself.
  const sweep = setInterval(() => {
    void running.registry.evictIdle().catch((error: unknown) => {
      reporter.captureError(error, { area: 'server', stage: 'sweep' });
    });
  }, config.lifecycle.sweepMs);
  sweep.unref();

  const stop = async (): Promise<ProductionShutdownResult> => {
    clearInterval(sweep);
    const finished = await within(config.shutdownTimeoutMs, running.shutdown());
    const timedOut = finished === 'TIMED_OUT';
    const saved = !timedOut && finished.ok;
    if (timedOut) {
      reporter.captureFailure('server shutdown timed out', {
        area: 'server',
        stage: 'shutdown',
        code: 'SHUTDOWN_TIMED_OUT',
      });
      logger?.error('shutdown timed out', { timeoutMs: config.shutdownTimeoutMs });
    }
    // Bounded by the reporter itself.
    await reporter.flush().catch(() => undefined);
    return { ok: saved, timedOut };
  };

  return {
    ok: true,
    value: {
      port: running.port,
      sessions: running,
      metrics,
      readiness,
      shutdown() {
        stopping ??= stop();
        return stopping;
      },
    },
  };
}
