import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@touchgrass/shared';
import type { GameMaster } from '@touchgrass/ai/game-master';
import {
  DEFAULT_MONGODB_TIMEOUT_MS,
  DEFAULT_SERVER_HOST,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_WS_HEARTBEAT_MS,
  type ProductionConfig,
  parseProductionConfig,
  summarizeProductionConfig,
} from './production-config';
import { type ProductionServer, startProductionServer } from './production-server';
import type { ErrorReporter } from './reporting';
import { Client, READY, heldStore, until } from './socket-test-support';
import { codeOf, unwrap } from './test-support';

/**
 * The deployed server, started in this process on a free port with an in-memory
 * store, and spoken to the way a load balancer, an operator and players would:
 * over HTTP and WebSocket.
 */

const ADMIN_TOKEN = 'admin-token-for-tests-only-0123456789abcdef';
const URI = 'mongodb://LEAK_MARKER_USER:LEAK_MARKER_VALUE@example-host.invalid:27017';
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');

function config(more: Record<string, string> = {}): ProductionConfig {
  return unwrap(
    parseProductionConfig({
      MONGODB_URI: URI,
      SERVER_PORT: '0',
      ADMIN_TOKEN,
      SESSION_TOKEN_KEY: TOKEN_KEY,
      WS_HEARTBEAT_MS: '0',
      ...more,
    }),
  );
}

let running: ProductionServer[] = [];

/** Joins a session an admin created, with the join code the admin was given. */
async function joinAs(
  client: Client,
  session: Record<string, string>,
  displayName: string,
): Promise<{ playerId: string; token: string; sessionId: string }> {
  client.send({ type: 'join', joinCode: session.joinCode, displayName });
  const message = await client.next();
  if (message.type !== 'joined' || !message.playerId || !message.token || !message.state) {
    throw new Error(`expected joined, got ${message.type}`);
  }
  return { playerId: message.playerId, token: message.token, sessionId: message.state.id };
}

/** Waits, a few milliseconds at a time, for something the server does on a timer. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the condition never became true');
}

async function start(
  options: {
    env?: Record<string, string>;
    backing?: ReturnType<typeof heldStore>;
    gameMaster?: Pick<GameMaster, 'propose' | 'provider' | 'model'>;
    readinessCacheMs?: number;
    readinessTimeoutMs?: number;
  } = {},
) {
  const backing = options.backing ?? heldStore();
  const lines: Record<string, unknown>[] = [];
  const reports: { kind: string; name?: string; tags?: unknown }[] = [];
  const reporter: ErrorReporter = {
    captureError: (_error, tags) => reports.push({ kind: 'error', tags }),
    captureFailure: (name, tags) => reports.push({ kind: 'failure', name, tags }),
    flush: () => {
      reports.push({ kind: 'flush' });
      return Promise.resolve();
    },
  };
  const server = unwrap(
    await startProductionServer({
      config: config(options.env),
      store: backing.store,
      reporter,
      logger: createLogger({
        level: 'debug',
        sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
      readinessCacheMs: options.readinessCacheMs ?? 0,
      ...(options.readinessTimeoutMs === undefined
        ? {}
        : { readinessTimeoutMs: options.readinessTimeoutMs }),
      ...(options.gameMaster ? { gameMaster: { gameMaster: options.gameMaster } } : {}),
    }),
  );
  running.push(server);
  const base = `http://127.0.0.1:${String(server.port)}`;
  const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const adminHeaders = {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'content-type': 'application/json',
  };
  const createSession = async (gameId = 'tag') => {
    const response = await get('/admin/sessions', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ gameId }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  };
  return { ...backing, server, base, get, adminHeaders, createSession, lines, reports };
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.shutdown()));
  running = [];
});

describe('health', () => {
  it('says it is alive, and ready when the store answers', async () => {
    const { get } = await start();
    const alive = await get('/healthz');
    expect(alive.status).toBe(200);
    expect(await alive.json()).toEqual({ status: 'ok' });
    expect(alive.headers.get('cache-control')).toBe('no-store');

    const ready = await get('/readyz');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', checks: { store: 'ok' } });
    expect((await get('/healthz', { method: 'HEAD' })).status).toBe(200);
  });

  it('is alive but not ready while the store is away, and ready again when it is back', async () => {
    const { get, failing, storeCalls } = await withStoreCalls();
    failing.load.add('readiness-probe');
    const away = await get('/readyz');
    expect(away.status).toBe(503);
    expect(await away.json()).toEqual({ status: 'not_ready', checks: { store: 'unavailable' } });
    // The process is still alive: restarting it would not bring the store back.
    expect((await get('/healthz')).status).toBe(200);

    failing.load.clear();
    expect((await get('/readyz')).status).toBe(200);
    // The check reads one document by id and writes nothing.
    expect(storeCalls.save).toBe(0);
    expect(storeCalls.delete).toBe(0);
  });

  it('gives up on a store that does not answer, within the time allowed', async () => {
    const backing = heldStore();
    const { get } = await start({ backing, readinessTimeoutMs: 40 });
    backing.hold('load');
    const stuck = await get('/readyz');
    expect(stuck.status).toBe(503);
    expect(await stuck.json()).toEqual({ status: 'not_ready', checks: { store: 'unavailable' } });
    backing.release('load');
    for (const call of [...backing.held]) call.finish();
  });

  it('asks the store once however many are asking, and reuses the answer for a while', async () => {
    const backing = heldStore();
    const { get } = await start({ backing, readinessCacheMs: 60_000 });
    const answers = await Promise.all(Array.from({ length: 8 }, () => get('/readyz')));
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    await get('/readyz');
    expect(backing.calls.load).toBe(1);
  });

  it('does not depend on the model runtime', async () => {
    const { get } = await start({
      gameMaster: {
        provider: 'ollama',
        model: 'gemma3:4b',
        propose: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
      },
    });
    expect((await get('/readyz')).status).toBe(200);
  });

  it('answers nothing else, and never with a detail', async () => {
    const { get } = await start();
    for (const path of [
      '/',
      '/health',
      '/metrics',
      '/sessions/abc',
      '/admin',
      '/.env',
      '/readyz/x',
    ]) {
      const response = await get(path);
      expect([401, 404], path).toContain(response.status);
      const text = await response.text();
      expect(text).toMatch(/^\{"error":"(NOT_FOUND|UNAUTHORIZED)"\}$/);
    }
    expect((await get('/healthz', { method: 'POST' })).status).toBe(405);
    expect((await get('/readyz', { method: 'DELETE' })).status).toBe(405);
  });

  it('says nothing of how it is configured', async () => {
    const { get } = await start();
    const everything = await Promise.all(
      ['/healthz', '/readyz', '/nope', '/admin/metrics'].map(async (path) => {
        const response = await get(path);
        return `${JSON.stringify([...response.headers])}${await response.text()}`;
      }),
    );
    expect(everything.join('')).not.toMatch(
      /LEAK_MARKER|example-host\.invalid|mongodb|admin-token|touchgrass|x-powered-by|stack|at \w+ \(/i,
    );
  });
});

describe('the admin endpoints', () => {
  it('create a session an operator can hand out, with the token in the header', async () => {
    const { createSession, server, inner } = await start();
    const { status, body } = await createSession();
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual([
      'gameId',
      'hostToken',
      'joinCode',
      'path',
      'sessionId',
    ]);
    expect(body.gameId).toBe('tag');
    expect(body.path).toBe(`/sessions/${String(body.sessionId)}`);
    expect(server.sessions.registry.get(String(body.sessionId))?.hostToken).toBe(body.hostToken);
    // It is saved when it is created, like every session.
    expect(unwrap(await inner.load(String(body.sessionId)))).not.toBeNull();
  });

  it('refuse anyone without the token, and say the same thing however they got it wrong', async () => {
    const { get, server } = await start();
    for (const authorization of [
      undefined,
      '',
      'Bearer',
      'Bearer wrong',
      `Bearer ${ADMIN_TOKEN}x`,
      `Bearer ${ADMIN_TOKEN.slice(0, -1)}`,
      `Basic ${ADMIN_TOKEN}`,
      ADMIN_TOKEN,
    ]) {
      for (const [path, method] of [
        ['/admin/sessions', 'POST'],
        ['/admin/metrics', 'GET'],
        ['/admin/sessions/x/save', 'POST'],
      ] as const) {
        const response = await get(path, {
          method,
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
        expect(response.status, `${path} ${String(authorization)}`).toBe(401);
        expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
      }
    }
    expect(server.sessions.registry.sessions()).toEqual([]);
  });

  it('do not exist at all when no admin token is configured', async () => {
    const backing = heldStore();
    const server = unwrap(
      await startProductionServer({
        config: unwrap(parseProductionConfig({ MONGODB_URI: URI, SERVER_PORT: '0' })),
        store: backing.store,
      }),
    );
    running.push(server);
    for (const authorization of [undefined, `Bearer ${ADMIN_TOKEN}`, 'Bearer ']) {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/admin/sessions`, {
        method: 'POST',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });
      expect(response.status).toBe(404);
    }
  });

  it('refuse a request they cannot use, by a code and nothing more', async () => {
    const { get, adminHeaders, createSession } = await start();
    const post = (body: string) =>
      get('/admin/sessions', { method: 'POST', headers: adminHeaders, body });
    expect((await post('{"gameId":')).status).toBe(400);
    expect((await post(JSON.stringify({ gameId: 42 }))).status).toBe(400);
    expect((await post(JSON.stringify({ gameId: '../etc/passwd' }))).status).toBe(400);
    expect((await post(JSON.stringify({ gameId: 'x'.repeat(5_000) }))).status).toBe(413);

    const unknown = await createSession('no-such-game');
    expect(unknown).toEqual({ status: 400, body: { error: 'SESSION_NOT_CREATED' } });
    expect((await get('/admin/sessions', { headers: adminHeaders })).status).toBe(405);
    expect((await get('/admin/nothing', { headers: adminHeaders })).status).toBe(404);
    // With no body at all, the default game is created.
    expect((await get('/admin/sessions', { method: 'POST', headers: adminHeaders })).status).toBe(
      201,
    );
  });

  it('save a loaded session on request, and say so when the store cannot', async () => {
    const { get, adminHeaders, createSession, failing, server } = await start();
    const { body } = await createSession();
    const id = String(body.sessionId);
    const client = await Client.open(server.port, id);
    await joinAs(client, body, 'Ada');
    const handle = server.sessions.registry.get(id);
    expect(handle?.hasUnsavedChanges()).toBe(true);

    const saved = await get(`/admin/sessions/${id}/save`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ saved: true });
    expect(handle?.hasUnsavedChanges()).toBe(false);

    client.send(READY);
    await client.next();
    failing.save.add(id);
    const refused = await get(`/admin/sessions/${id}/save`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'STORAGE_ERROR' });
    // The game is as it was, and still knows it is unsaved.
    expect(handle?.hasUnsavedChanges()).toBe(true);
    failing.save.clear();

    const missing = await get('/admin/sessions/not-loaded/save', {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(missing.status).toBe(404);
  });

  it('give the counters, with no session in them', async () => {
    const { get, adminHeaders, createSession } = await start();
    const { body } = await createSession();
    const response = await get('/admin/metrics', { headers: adminHeaders });
    const metrics = (await response.json()) as { counters: Record<string, number> };
    expect(response.status).toBe(200);
    expect(metrics.counters.session_creates).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain(String(body.sessionId));
  });
});

describe('serving players', () => {
  it('takes WebSocket connections on the same port as the health checks', async () => {
    const { createSession, server, get } = await start();
    const { body } = await createSession();
    const client = await Client.open(server.port, String(body.sessionId));
    expect((await joinAs(client, body, 'Ada')).sessionId).toBe(body.sessionId);
    expect((await get('/healthz')).status).toBe(200);

    // The token leaves the process once, in the reply to its own join.
    const unknown = await Client.open(server.port, 'no-such-session');
    expect(await unknown.next()).toEqual({ type: 'error', code: 'SESSION_NOT_FOUND' });
  });

  it('lets a player drop and resume, and keeps the token across a restart with the same key', async () => {
    const backing = heldStore();
    const first = await start({ backing });
    const { body } = await first.createSession();
    const id = String(body.sessionId);
    const client = await Client.open(first.server.port, id);
    const ada = await joinAs(client, body, 'Ada');
    client.socket.close();
    await client.closed;

    const back = await Client.open(first.server.port, id);
    back.send({ type: 'resume', token: ada.token });
    expect((await back.next()).playerId).toBe(ada.playerId);

    // The process stops and another starts, over the same store, with the same key.
    expect(await first.server.shutdown()).toEqual({ ok: true, timedOut: false });
    const second = await start({ backing: heldStore(backing.inner) });
    const again = await Client.open(second.server.port, id);
    again.send({ type: 'resume', token: ada.token });
    const resumed = await again.next();
    expect([resumed.type, resumed.playerId]).toEqual(['joined', ada.playerId]);
    expect(resumed.state?.players.map((player) => player.displayName)).toEqual(['Ada']);
  });

  it('evicts unused sessions on its own schedule, and loads them again when someone returns', async () => {
    const { createSession, server } = await start({
      env: { SESSION_IDLE_MS: '0', SESSION_SWEEP_MS: '100' },
    });
    const { body } = await createSession();
    const id = String(body.sessionId);
    await eventually(() => server.sessions.registry.get(id) === undefined);
    expect(server.metrics.read().counters.session_evictions).toBeGreaterThanOrEqual(1);

    const client = await Client.open(server.port, id);
    expect((await joinAs(client, body, 'Ada')).sessionId).toBe(id);
  });
});

describe('shutting down', () => {
  it('saves what is unsaved, closes every connection and the store, and frees the port', async () => {
    const { createSession, server, inner, storeCalls, get, lines, reports } =
      await withStoreCalls();
    const { body } = await createSession();
    const id = String(body.sessionId);
    const client = await Client.open(server.port, id);
    await joinAs(client, body, 'Ada');

    expect(await server.shutdown()).toEqual({ ok: true, timedOut: false });
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_CLOSED' });
    await client.closed;
    const stored = unwrap(await inner.load(id));
    expect(stored?.state.players.map((player) => player.displayName)).toEqual(['Ada']);
    expect(storeCalls.close).toBe(1);
    await expect(get('/healthz')).rejects.toBeDefined();
    // What was reported is flushed last, and nothing was wrong enough to report.
    expect(reports).toEqual([{ kind: 'flush' }]);
    expect(lines.some((line) => line.msg === 'session' && line.type === 'unloaded')).toBe(true);
  });

  it('says it is shutting down, and refuses new work, from the moment it begins', async () => {
    const backing = heldStore();
    const { createSession, server, get, adminHeaders } = await start({ backing });
    const { body } = await createSession();
    const client = await Client.open(server.port, String(body.sessionId));
    await joinAs(client, body, 'Ada');
    backing.hold('save');
    const stopping = server.shutdown();
    await until(() => backing.held.length === 1);

    const ready = await get('/readyz');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'shutting_down' });
    expect((await get('/healthz')).status).toBe(200);
    const refused = await get('/admin/sessions', { method: 'POST', headers: adminHeaders });
    expect(refused.status).toBe(503);
    const late = await Client.open(server.port, String(body.sessionId));
    expect(await late.next()).toEqual({ type: 'error', code: 'SESSION_CLOSED' });

    backing.release('save');
    backing.held[0]?.finish();
    expect(await stopping).toEqual({ ok: true, timedOut: false });
  });

  it('reports a session it could not save, and still stops', async () => {
    const { createSession, server, failing, storeCalls, reports } = await withStoreCalls();
    const { body } = await createSession();
    const client = await Client.open(server.port, String(body.sessionId));
    await joinAs(client, body, 'Ada');
    failing.save.add(String(body.sessionId));

    expect(await server.shutdown()).toEqual({ ok: false, timedOut: false });
    expect(storeCalls.close).toBe(1);
    expect(reports.filter((report) => report.kind === 'failure')).toEqual([
      {
        kind: 'failure',
        name: 'server shutdown incomplete',
        tags: { area: 'persistence', stage: 'shutdown', code: 'SESSIONS_NOT_SAVED' },
      },
    ]);
  });

  it('gives up after the time allowed when a save never finishes', async () => {
    const backing = heldStore();
    const { createSession, server, reports } = await start({
      backing,
      env: { SHUTDOWN_TIMEOUT_MS: '1000' },
    });
    const { body } = await createSession();
    const client = await Client.open(server.port, String(body.sessionId));
    await joinAs(client, body, 'Ada');
    backing.hold('save');

    const startedAt = Date.now();
    expect(await server.shutdown()).toEqual({ ok: false, timedOut: true });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(reports.some((report) => report.name === 'server shutdown timed out')).toBe(true);
    // Let the abandoned shutdown finish so nothing is left hanging after the test.
    backing.release('save');
    for (const call of [...backing.held]) call.finish();
    running = running.filter((entry) => entry !== server);
  });

  it('is done once however often it is asked', async () => {
    const { server, storeCalls } = await withStoreCalls();
    const first = server.shutdown();
    expect(server.shutdown()).toBe(first);
    await first;
    expect(storeCalls.close).toBe(1);
  });

  it('starts no new Game Master turn once it has begun', async () => {
    let asked = 0;
    const { createSession, server } = await start({
      gameMaster: {
        provider: 'fake',
        model: 'fake-model',
        propose: () => {
          asked += 1;
          return Promise.reject(new Error('never reached'));
        },
      },
    });
    const { body } = await createSession();
    const stopping = server.shutdown();
    expect(await server.sessions.runGameMaster(String(body.sessionId))).toMatchObject({
      outcome: 'SKIPPED',
      code: 'SERVER_STOPPING',
    });
    await stopping;
    expect(asked).toBe(0);
  });
});

describe('starting', () => {
  it('reports a port that is taken and leaves the store open', async () => {
    const { server, storeCalls, store } = await withStoreCalls();
    const second = await startProductionServer({
      config: config({ SERVER_PORT: String(server.port) }),
      store,
    });
    expect(codeOf(second)).toBe('SERVER_NOT_STARTED');
    expect(storeCalls.close).toBe(0);
  });

  it('starts when the store is away, and says it is not ready', async () => {
    const backing = heldStore();
    backing.failing.load.add('readiness-probe');
    const { get } = await start({ backing });
    expect((await get('/healthz')).status).toBe(200);
    expect((await get('/readyz')).status).toBe(503);
  });
});

describe('the production configuration', () => {
  it('needs only a database, and is cautious about everything else', () => {
    const parsed = unwrap(parseProductionConfig({ MONGODB_URI: URI }));
    expect(parsed).toMatchObject({
      host: DEFAULT_SERVER_HOST,
      port: 3001,
      gameMaster: { enabled: false, tools: [] },
      reporting: { enabled: false },
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      heartbeatMs: DEFAULT_WS_HEARTBEAT_MS,
    });
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.mongo.serverSelectionTimeoutMs).toBe(DEFAULT_MONGODB_TIMEOUT_MS);
    expect(parsed.adminToken).toBeUndefined();
    expect(parsed.tokenKey).toBeUndefined();
  });

  it('reads every setting from one place', () => {
    const parsed = unwrap(
      parseProductionConfig({
        MONGODB_URI: URI,
        MONGODB_DATABASE: 'games',
        SERVER_HOST: '0.0.0.0',
        SERVER_PORT: '8080',
        ADMIN_TOKEN,
        SESSION_TOKEN_KEY: TOKEN_KEY,
        SESSION_IDLE_MS: '60000',
        GAME_MASTER_ENABLED: 'true',
        GAME_MASTER_TOOLS: 'game_rules',
        SENTRY_ENABLED: 'true',
        SENTRY_DSN: 'https://key@example.invalid/1',
        SENTRY_ENVIRONMENT: 'production',
        SHUTDOWN_TIMEOUT_MS: '10000',
        WS_HEARTBEAT_MS: '15000',
        MONGODB_TIMEOUT_MS: '3000',
      }),
    );
    expect(parsed).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      mongo: { databaseName: 'games', serverSelectionTimeoutMs: 3_000 },
      lifecycle: { idleMs: 60_000 },
      gameMaster: { enabled: true, tools: ['game_rules'] },
      reporting: { enabled: true, environment: 'production' },
      adminToken: ADMIN_TOKEN,
      shutdownTimeoutMs: 10_000,
      heartbeatMs: 15_000,
    });
    expect([...(parsed.tokenKey ?? [])]).toEqual(Array.from({ length: 32 }, () => 7));
  });

  it('refuses what makes no sense, names every problem at once, and repeats no value', () => {
    const parsed = parseProductionConfig({
      MONGODB_URI: '   ',
      SERVER_HOST: 'not a host!',
      SERVER_PORT: '99999',
      ADMIN_TOKEN: 'too-short',
      SESSION_TOKEN_KEY: Buffer.alloc(8, 1).toString('base64'),
      SESSION_IDLE_MS: 'soon',
      GAME_MASTER_ENABLED: 'perhaps',
      SENTRY_ENABLED: 'true',
      SHUTDOWN_TIMEOUT_MS: '5',
      WS_HEARTBEAT_MS: '-1',
      MONGODB_TIMEOUT_MS: 'never',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const told = parsed.error.issues.join('\n');
    for (const name of [
      'MONGODB_URI',
      'SERVER_HOST',
      'SERVER_PORT',
      'ADMIN_TOKEN',
      'SESSION_TOKEN_KEY',
      'SESSION_IDLE_MS',
      'GAME_MASTER_ENABLED',
      'SENTRY_DSN',
      'SHUTDOWN_TIMEOUT_MS',
      'WS_HEARTBEAT_MS',
      'MONGODB_TIMEOUT_MS',
    ]) {
      expect(told, name).toContain(name);
    }
    expect(told).not.toMatch(/too-short|not a host|perhaps|soon/);
  });

  it('never repeats a connection string, a key or a token, even a valid one', () => {
    const bad = parseProductionConfig({
      MONGODB_URI: URI,
      ADMIN_TOKEN,
      SESSION_TOKEN_KEY: TOKEN_KEY,
      SERVER_PORT: 'x',
    });
    expect(JSON.stringify(bad)).not.toMatch(
      /LEAK_MARKER|example-host|admin-token-for-tests|BwcHBwc/,
    );

    const summary = summarizeProductionConfig(config({ SERVER_PORT: '3001' }));
    expect(summary).toMatchObject({
      adminEndpoints: true,
      tokenKeyConfigured: true,
      gameMaster: false,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /LEAK_MARKER|example-host\.invalid|admin-token|BwcHBwc/,
    );
    expect(Object.keys(summary)).not.toContain('adminToken');
  });

  it('turns the heartbeat off when asked', () => {
    expect(
      unwrap(parseProductionConfig({ MONGODB_URI: URI, WS_HEARTBEAT_MS: '0' })).heartbeatMs,
    ).toBe(0);
  });
});

describe('the production entry point', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(joinPath(directory, 'main.ts'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    '',
  );

  it('reads the configuration once, in one place, and stops if it is wrong', () => {
    expect(main.match(/parseProductionConfig\(process\.env\)/g)).toHaveLength(1);
    expect(main).toMatch(/if \(!parsed\.ok\) \{[\s\S]*?process\.exit\(1\);/);
    // The only other reader is the model code, and only when the Game Master is on.
    expect(main.match(/process\.env/g)).toHaveLength(2);
    expect(main).toMatch(
      /if \(config\.gameMaster\.enabled\) \{[\s\S]*?parseServerEnv\(process\.env\)/,
    );
  });

  it('stops on SIGTERM and SIGINT, exits by what happened, and does not wait twice', () => {
    expect(main).toMatch(/process\.on\('SIGTERM', \(\) => \{\s*stop\('SIGTERM'\);/);
    expect(main).toMatch(/process\.on\('SIGINT', \(\) => \{\s*stop\('SIGINT'\);/);
    expect(main).toContain('process.exit(result.ok && !failed ? 0 : 1);');
    expect(main).toMatch(/if \(stopping\) \{[\s\S]*?process\.exit\(1\);/);
    expect(main).toContain("process.on('uncaughtException'");
    expect(main).toContain("process.on('unhandledRejection'");
  });

  it('makes one store, loads the model and Sentry code only when they are on, and prints no token', () => {
    expect(main.match(/createMongoSessionStore\(/g)).toHaveLength(1);
    expect(main).toMatch(/config\.reporting\.enabled\s*\?\s*\(await import\('\.\/sentry'\)\)/);
    expect(main).toMatch(/await import\('@touchgrass\/ai\/game-master'\)/);
    expect(main).not.toMatch(/from '@touchgrass\/ai|from '\.\/sentry'/);
    expect(main).not.toMatch(/hostToken|adminToken|tokenKey\b(?!\))|console\./);
    expect(main).not.toMatch(/createInterface|readline|stdin/);
  });
});

/** The same server, with the store's call counts named apart from everything else. */
async function withStoreCalls() {
  const backing = heldStore();
  const made = await start({ backing });
  return { ...made, storeCalls: backing.calls };
}
