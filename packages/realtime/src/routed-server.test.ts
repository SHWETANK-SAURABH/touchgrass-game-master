import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { fixedClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from '@touchgrass/game-session';
import { MAX_MESSAGE_BYTES, type ServerMessage, serverMessageSchema } from './protocol';
import { type Room, createRoom } from './room';
import {
  type RouteError,
  type RoutedRealtimeServer,
  createRoutedRealtimeServer,
  sessionIdFromPath,
} from './routed-server';

/**
 * Real sockets against a real listener on a free local port, with rooms that
 * are made here and handed out by a `route` the test controls.
 */

const T0 = 1_700_000_000_000;
const CODE = 'GRASS7';
const clock = fixedClock(T0);

function newSession(sessionId: string): GameSession {
  const created = createGameSession(
    // The same join code everywhere: the address chooses the game, not the code.
    { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode: CODE, randomSeed: 7 },
    contextAt(clock),
  );
  if (!created.ok) throw new Error('fixture failed');
  return created.value;
}

/** A client that queues what it receives so a test can await the next message. */
class Client {
  private readonly queue: ServerMessage[] = [];
  private readonly waiting: ((message: ServerMessage) => void)[] = [];
  readonly closed: Promise<number>;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      const message = serverMessageSchema.parse(JSON.parse(data.toString('utf8')));
      const next = this.waiting.shift();
      if (next) next(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => {
      socket.once('close', (code) => {
        resolve(code);
      });
    });
    socket.on('error', () => undefined);
  }

  static open(port: number, path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const client = new Client(socket);
      socket.once('open', () => {
        resolve(client);
      });
      socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  pending(): number {
    return this.queue.length;
  }

  async join(displayName: string): Promise<{ playerId: string; sessionId: string }> {
    this.send({ type: 'join', joinCode: CODE, displayName });
    const message = await this.next();
    if (message.type !== 'joined') throw new Error(`expected joined, got ${message.type}`);
    return { playerId: message.playerId, sessionId: message.state.id };
  }
}

/** Waits until the server has processed everything this client has sent so far. */
async function settled(client: Client): Promise<void> {
  client.send('?');
  for (;;) {
    const message = await client.next();
    if (message.type === 'error' && message.code === 'BAD_MESSAGE') return;
  }
}

/** Waits, a turn of the event loop at a time, for something the server does on its own. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('the condition never became true');
}

let servers: RoutedRealtimeServer[] = [];

/** A listener over two rooms, `a` and `b`, with a record of what was asked for. */
async function start(
  route?: (sessionId: string, rooms: Record<string, Room>) => ReturnType<Route>,
): Promise<{
  server: RoutedRealtimeServer;
  rooms: { a: Room; b: Room };
  sessions: { a: GameSession; b: GameSession };
  asked: string[];
}> {
  const sessions = { a: newSession('a'), b: newSession('b') };
  const rooms = {
    a: createRoom({ session: sessions.a, hostToken: 'host-a' }),
    b: createRoom({ session: sessions.b, hostToken: 'host-b' }),
  };
  const asked: string[] = [];
  const table: Record<string, Room> = rooms;
  const server = await createRoutedRealtimeServer({
    port: 0,
    clock,
    route: (sessionId) => {
      asked.push(sessionId);
      return route ? route(sessionId, table) : (table[sessionId] ?? 'SESSION_NOT_FOUND');
    },
  });
  servers.push(server);
  return { server, rooms, sessions, asked };
}

type Route = (sessionId: string) => Promise<Room | RouteError> | Room | RouteError;

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

describe('sessionIdFromPath', () => {
  it('reads the session id from /sessions/<id>', () => {
    expect(sessionIdFromPath('/sessions/g1')).toBe('g1');
    expect(sessionIdFromPath('/sessions/ses_0b1e-4c')).toBe('ses_0b1e-4c');
    expect(sessionIdFromPath('/sessions/a%20b')).toBe('a b');
    expect(sessionIdFromPath('/sessions/a%2Fb')).toBe('a/b');
    // A query string is not part of the address.
    expect(sessionIdFromPath('/sessions/g1?token=x&sessionId=other')).toBe('g1');
  });

  it('refuses everything else', () => {
    for (const path of [
      undefined,
      '',
      '/',
      '/sessions',
      '/sessions/',
      '/sessions//',
      '/sessions/a/',
      '/sessions/a/b',
      '/session/a',
      '/Sessions/a',
      '/api/sessions/a',
      'sessions/a',
      '/sessions/%20',
      '/sessions/%E0%A4%A',
      '/sessions/?id=a',
      `/sessions/${'x'.repeat(201)}`,
    ]) {
      expect(sessionIdFromPath(path), String(path)).toBeNull();
    }
    expect(sessionIdFromPath(`/sessions/${'x'.repeat(200)}`)).toHaveLength(200);
  });
});

describe('one listener, many rooms', () => {
  it('gives each socket the room its address names', async () => {
    const { server, rooms, asked } = await start();
    const inA = await Client.open(server.port, '/sessions/a');
    const inB = await Client.open(server.port, '/sessions/b');

    expect((await inA.join('Ada')).sessionId).toBe('a');
    expect((await inB.join('Bo')).sessionId).toBe('b');
    expect(rooms.a.connectionCount()).toBe(1);
    expect(rooms.b.connectionCount()).toBe(1);
    expect(asked).toEqual(['a', 'b']);
    expect(server.socketCount()).toBe(2);
  });

  it('keeps every broadcast inside its room', async () => {
    const { server, sessions } = await start();
    const [a1, a2, b1] = await Promise.all([
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/b'),
    ]);
    await b1.join('Bo');
    await a1.join('Ada');
    const untouched = sessions.b.getState();

    // A second player joins A: the first hears of it, the player in B does not.
    await a2.join('Al');
    expect((await a1.next()).type).toBe('update');
    a1.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect((await a1.next()).type).toBe('update');
    expect((await a2.next()).type).toBe('update');

    await settled(b1);
    expect(b1.pending()).toBe(0);
    expect(sessions.b.getState()).toBe(untouched);
    expect(sessions.a.getState().players).toHaveLength(2);
  });

  it('keeps a host and its commands inside its room', async () => {
    const { server, rooms, sessions } = await start();
    const host = await Client.open(server.port, '/sessions/a');
    const inB = await Client.open(server.port, '/sessions/b');
    await inB.join('Bo');

    // The host token of B is nothing in A, and the other way round.
    host.send({ type: 'host_auth', token: 'host-b' });
    expect(await host.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });
    host.send({ type: 'host_auth', token: 'host-a' });
    expect((await host.next()).type).toBe('host_authorized');

    host.send({ type: 'host_command', command: { type: 'ABORT_SESSION', reason: 'rain' } });
    expect((await host.next()).type).toBe('update');
    expect(sessions.a.getState().status).toBe('aborted');
    expect(sessions.b.getState().status).toBe('lobby');
    await settled(inB);
    expect(inB.pending()).toBe(0);
    expect(rooms.b.isHost).toBeDefined();
  });

  it('lets no message choose another room', async () => {
    const { server, sessions } = await start();
    const client = await Client.open(server.port, '/sessions/a');
    // The envelopes are the single-room ones, and they are strict.
    client.send({ type: 'join', sessionId: 'b', joinCode: CODE, displayName: 'Ada' });
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    expect((await client.join('Ada')).sessionId).toBe('a');
    expect(sessions.b.getState().players).toEqual([]);
  });

  it('answers an invalid message and keeps the connection', async () => {
    const { server } = await start();
    const client = await Client.open(server.port, '/sessions/a');
    client.send('{"type":');
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    client.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect(await client.next()).toEqual({ type: 'error', code: 'NOT_JOINED' });
    expect((await client.join('Ada')).sessionId).toBe('a');
  });
});

describe('a socket that cannot be given a room', () => {
  it('is sent INVALID_SESSION_PATH and closed when its address names no session', async () => {
    const { server, asked } = await start();
    for (const path of ['', '/', '/sessions/', '/sessions/a/b', '/games/a', '/sessions/%E0%A4%A']) {
      const client = await Client.open(server.port, path);
      expect(await client.next(), path).toEqual({ type: 'error', code: 'INVALID_SESSION_PATH' });
      await client.closed;
      expect(client.pending()).toBe(0);
    }
    // Nobody was asked for a room.
    expect(asked).toEqual([]);
    await until(() => server.socketCount() === 0);
  });

  it('is sent SESSION_NOT_FOUND and closed when there is no such session', async () => {
    const { server, rooms, asked } = await start();
    const client = await Client.open(server.port, '/sessions/nothing');
    // Sent before the refusal arrives. It is never read.
    client.send({ type: 'join', joinCode: CODE, displayName: 'Ada' });
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_NOT_FOUND' });
    await client.closed;
    expect(client.pending()).toBe(0);
    expect(asked).toEqual(['nothing']);
    expect(rooms.a.connectionCount() + rooms.b.connectionCount()).toBe(0);
  });

  it('is refused with whatever reason the route gives', async () => {
    const reasons: RouteError[] = ['SESSION_UNAVAILABLE', 'SESSION_CLOSED', 'INVALID_SESSION_PATH'];
    const { server } = await start(() => reasons.shift() ?? 'SESSION_NOT_FOUND');
    for (const code of [...reasons]) {
      const client = await Client.open(server.port, '/sessions/a');
      expect(await client.next()).toEqual({ type: 'error', code });
      await client.closed;
    }
  });

  it('is refused as SESSION_UNAVAILABLE when the route fails, and says nothing of why', async () => {
    let calls = 0;
    const { server } = await start(() => {
      calls += 1;
      if (calls === 1) throw new Error('LEAK_MARKER thrown');
      return Promise.reject(new Error('LEAK_MARKER rejected'));
    });
    for (const _ of [1, 2]) {
      const client = await Client.open(server.port, '/sessions/a');
      const raw: string[] = [];
      client.socket.on('message', (data: Buffer) => raw.push(data.toString('utf8')));
      expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_UNAVAILABLE' });
      await client.closed;
      expect(raw.join('')).not.toContain('LEAK_MARKER');
    }
    expect(calls).toBe(2);
  });

  it('is refused when its room was closed before it could be attached', async () => {
    const { server, rooms } = await start();
    rooms.a.close();
    const client = await Client.open(server.port, '/sessions/a');
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_CLOSED' });
    await client.closed;
    // The other room is still served.
    const other = await Client.open(server.port, '/sessions/b');
    expect((await other.join('Bo')).sessionId).toBe('b');
  });
});

describe('while a room is being found', () => {
  /** A route that answers only when the test lets it. */
  function held() {
    const releases: (() => void)[] = [];
    const route = (sessionId: string, rooms: Record<string, Room>) =>
      new Promise<Room | RouteError>((resolve) => {
        releases.push(() => {
          resolve(rooms[sessionId] ?? 'SESSION_NOT_FOUND');
        });
      });
    return { route, releases };
  }

  it('reads nothing, then handles what was sent in the order it was sent', async () => {
    const { route, releases } = held();
    const { server, rooms, sessions } = await start(route);
    const client = await Client.open(server.port, '/sessions/a');
    client.send({ type: 'join', joinCode: CODE, displayName: 'Ada' });
    client.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    client.send({ type: 'leave' });

    await until(() => releases.length === 1);
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(client.pending()).toBe(0);
    expect(sessions.a.getState().players).toEqual([]);
    expect(rooms.a.connectionCount()).toBe(0);

    releases[0]?.();
    expect((await client.next()).type).toBe('joined');
    expect((await client.next()).type).toBe('update');
    expect((await client.next()).type).toBe('update');
    expect(sessions.a.getState().players.map((player) => player.status)).toEqual(['left']);
  });

  it('attaches nothing for a socket that went away in the meantime', async () => {
    const { route, releases } = held();
    const { server, rooms } = await start(route);
    const client = await Client.open(server.port, '/sessions/a');
    await until(() => releases.length === 1);
    client.socket.terminate();
    await client.closed;

    releases[0]?.();
    await until(() => server.socketCount() === 0);
    // The room was never told of it, so closing the room has nobody to tell.
    expect(rooms.a.connectionCount()).toBe(0);
    rooms.a.close();
  });

  it('does not hold up a socket for another room', async () => {
    const { route, releases } = held();
    const { server } = await start((sessionId, rooms) =>
      sessionId === 'a' ? route(sessionId, rooms) : (rooms[sessionId] ?? 'SESSION_NOT_FOUND'),
    );
    const slow = await Client.open(server.port, '/sessions/a');
    slow.send({ type: 'join', joinCode: CODE, displayName: 'Ada' });
    await until(() => releases.length === 1);

    const quick = await Client.open(server.port, '/sessions/b');
    expect((await quick.join('Bo')).sessionId).toBe('b');
    expect(slow.pending()).toBe(0);
    releases[0]?.();
    expect((await slow.next()).type).toBe('joined');
  });
});

describe('connections coming and going', () => {
  it('forgets a connection that closes, and leaves the others in its room alone', async () => {
    const { server, rooms } = await start();
    const [first, second, other] = await Promise.all([
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/b'),
    ]);
    await first.join('Ada');
    await second.join('Al');
    await first.next();
    await other.join('Bo');

    first.socket.close();
    await first.closed;
    await until(() => rooms.a.connectionCount() === 1);
    expect(rooms.b.connectionCount()).toBe(1);

    second.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect((await second.next()).type).toBe('update');
    await settled(other);
    expect(other.pending()).toBe(0);
  });

  it('forgets a connection that vanishes without closing', async () => {
    const { server, rooms } = await start();
    const first = await Client.open(server.port, '/sessions/a');
    const second = await Client.open(server.port, '/sessions/a');
    await first.join('Ada');
    await second.join('Al');
    await first.next();

    first.socket.terminate();
    await until(() => rooms.a.connectionCount() === 1);
    await until(() => server.socketCount() === 1);
    second.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect((await second.next()).type).toBe('update');
  });

  it('closes only the socket that sends a frame that is too large', async () => {
    const { server, rooms } = await start();
    const loud = await Client.open(server.port, '/sessions/a');
    const quiet = await Client.open(server.port, '/sessions/a');
    await loud.join('Ada');
    await quiet.join('Al');
    await loud.next();

    loud.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(await loud.closed).toBe(1009);
    await until(() => rooms.a.connectionCount() === 1);
    quiet.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect((await quiet.next()).type).toBe('update');
  });

  it('closes every connection of a room that is closed, and of no other', async () => {
    const { server, rooms } = await start();
    const [player, silent, other] = await Promise.all([
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/b'),
    ]);
    await player.join('Ada');
    await other.join('Bo');
    // `silent` has sent nothing. It was attached when it connected.
    await settled(player);

    rooms.a.close();
    for (const client of [player, silent]) {
      expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_CLOSED' });
      await client.closed;
    }
    await until(() => server.socketCount() === 1);
    other.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect((await other.next()).type).toBe('update');
    expect(rooms.b.connectionCount()).toBe(1);
  });

  it('closes every socket and frees the port when the listener is closed', async () => {
    const { server, rooms } = await start();
    const clients = await Promise.all([
      Client.open(server.port, '/sessions/a'),
      Client.open(server.port, '/sessions/b'),
    ]);
    await clients[0]?.join('Ada');
    await server.close();
    servers = [];
    await Promise.all(clients.map((client) => client.closed));
    expect(server.socketCount()).toBe(0);
    expect(rooms.a.connectionCount()).toBe(0);
    await expect(Client.open(server.port, '/sessions/a')).rejects.toBeDefined();
  });
});

describe('being told what happens at the listener', () => {
  async function observed(route?: Route) {
    const session = newSession('a');
    const room = createRoom({ session });
    const events: { type: string; code?: string }[] = [];
    const errors: unknown[] = [];
    const server = await createRoutedRealtimeServer({
      port: 0,
      clock,
      route: route ?? ((sessionId) => (sessionId === 'a' ? room : 'SESSION_NOT_FOUND')),
      onSocket: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });
    servers.push(server);
    return { server, room, events, errors };
  }

  it('says when a socket opens, is given its room, and closes', async () => {
    const { server, events } = await observed();
    const client = await Client.open(server.port, '/sessions/a');
    await client.join('Ada');
    expect(events).toEqual([{ type: 'opened' }, { type: 'attached' }]);
    client.socket.close();
    await client.closed;
    await until(() => events.length === 3);
    expect(events.at(-1)).toEqual({ type: 'closed' });
  });

  it('says when a socket is refused, and with which code', async () => {
    const { server, events } = await observed();
    for (const path of ['/sessions/nothing', '/not-a-session']) {
      const client = await Client.open(server.port, path);
      await client.next();
      await client.closed;
    }
    await until(() => events.filter((event) => event.type === 'closed').length === 2);
    expect(events.filter((event) => event.type === 'refused')).toEqual([
      { type: 'refused', code: 'SESSION_NOT_FOUND' },
      { type: 'refused', code: 'INVALID_SESSION_PATH' },
    ]);
    expect(events.filter((event) => event.type === 'attached')).toEqual([]);
    // What it is told names no address and no session.
    expect(JSON.stringify(events)).not.toMatch(/nothing|not-a-session|127\.0\.0\.1/);
  });

  it('hands over what a failing route threw, and tells the client nothing of it', async () => {
    const { server, errors, events } = await observed(() => {
      throw new Error('LEAK_MARKER the store is away');
    });
    const client = await Client.open(server.port, '/sessions/a');
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_UNAVAILABLE' });
    await client.closed;
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'LEAK_MARKER the store is away',
    ]);
    expect(events.filter((event) => event.type === 'refused')).toEqual([
      { type: 'refused', code: 'SESSION_UNAVAILABLE' },
    ]);
  });

  it('carries on when the listeners throw', async () => {
    const session = newSession('a');
    const room = createRoom({ session });
    const server = await createRoutedRealtimeServer({
      port: 0,
      clock,
      route: () => room,
      onSocket: () => {
        throw new Error('the listener broke');
      },
      onError: () => {
        throw new Error('the listener broke');
      },
    });
    servers.push(server);
    const client = await Client.open(server.port, '/sessions/a');
    expect((await client.join('Ada')).sessionId).toBe('a');
  });
});

describe('plain HTTP on the same port', () => {
  it('answers 426 when nobody handles it, as a WebSocket-only server does', async () => {
    const { server } = await start();
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/sessions/a`);
    expect(response.status).toBe(426);
  });

  it('hands a request that is not an upgrade to the handler, and still takes sockets', async () => {
    const session = newSession('a');
    const room = createRoom({ session });
    const seen: string[] = [];
    const server = await createRoutedRealtimeServer({
      port: 0,
      clock,
      route: () => room,
      http: (request, response) => {
        seen.push(`${String(request.method)} ${String(request.url)}`);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      },
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(seen).toEqual(['GET /healthz']);

    const client = await Client.open(server.port, '/sessions/a');
    expect((await client.join('Ada')).sessionId).toBe('a');
    // An upgrade never reaches the handler.
    expect(seen).toEqual(['GET /healthz']);
  });

  it('answers 500 with no detail when the handler throws, and tells whoever monitors errors', async () => {
    const session = newSession('a');
    const errors: unknown[] = [];
    const server = await createRoutedRealtimeServer({
      port: 0,
      clock,
      route: () => createRoom({ session }),
      onError: (error) => errors.push(error),
      http: () => {
        throw new Error('LEAK_MARKER the handler broke');
      },
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/anything`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"INTERNAL"}');
    expect(errors).toHaveLength(1);
  });

  it('frees the port when it is closed, even with an HTTP connection kept open', async () => {
    const session = newSession('a');
    const server = await createRoutedRealtimeServer({
      port: 0,
      clock,
      route: () => createRoom({ session }),
      http: (_request, response) => {
        response.writeHead(200).end('ok');
      },
    });
    // A keep-alive request leaves its connection open.
    await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
    await server.close();
    await expect(fetch(`http://127.0.0.1:${String(server.port)}/healthz`)).rejects.toBeDefined();
  });
});

describe('the heartbeat', () => {
  async function beating(heartbeatMs: number | undefined) {
    const session = newSession('a');
    const room = createRoom({ session });
    const server = await createRoutedRealtimeServer({
      port: 0,
      clock,
      route: () => room,
      ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    });
    servers.push(server);
    return { server, room };
  }

  /** A socket that connects and joins, and answers pings only if told to. */
  function open(port: number, autoPong: boolean): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/sessions/a`, { autoPong });
      socket.on('error', () => undefined);
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'join', joinCode: CODE, displayName: 'Ada' }));
        resolve(socket);
      });
      socket.once('error', reject);
    });
  }

  it('closes a socket that stops answering, so it does not stay in its room for ever', async () => {
    const { server, room } = await beating(25);
    const silent = await open(server.port, false);
    await until(() => room.connectionCount() === 1);
    const closed = new Promise<void>((resolve) => {
      silent.once('close', () => {
        resolve();
      });
    });
    await closed;
    await until(() => room.connectionCount() === 0);
    await until(() => server.socketCount() === 0);
  });

  it('leaves a socket that answers alone', async () => {
    const { server, room } = await beating(20);
    const lively = await open(server.port, true);
    let pings = 0;
    lively.on('ping', () => {
      pings += 1;
    });
    await until(() => room.connectionCount() === 1);
    // Several beats go by.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(lively.readyState).toBe(WebSocket.OPEN);
    expect(room.connectionCount()).toBe(1);
  });

  it('sends no ping unless it is asked to', async () => {
    const { server, room } = await beating(undefined);
    const socket = await open(server.port, false);
    let pings = 0;
    socket.on('ping', () => {
      pings += 1;
    });
    await until(() => room.connectionCount() === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(pings).toBe(0);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('the routed adapter stays an adapter', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(joinPath(directory, 'routed-server.ts'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    '',
  );

  it('holds no table of rooms and no game logic', () => {
    expect(code).not.toMatch(/new Map|new Set|new WeakMap/);
    expect(code).not.toMatch(/getState|applyCommand|submitAction|advanceTime|createRoom/);
    expect(code).not.toMatch(/parseClientMessage|joinCode|hostToken/);
    expect(code).not.toMatch(/setTimeout|retry/i);
    // One timer per attached socket, for the heartbeat, cleared when the socket closes.
    expect(code.match(/setInterval/g)).toHaveLength(1);
    expect(code.match(/clearInterval/g)).toHaveLength(1);
  });

  it('knows nothing of persistence or of who supplies the rooms', () => {
    expect(code).not.toMatch(/\bstore\b|persistence|registry|mongodb/i);
  });

  it('reaches a room only through attach, receive and disconnect', () => {
    expect(code.match(/room\??\.\w+|found\.\w+/g)?.sort()).toEqual([
      'found.attach',
      'room?.disconnect',
      'room?.receive',
    ]);
  });
});
