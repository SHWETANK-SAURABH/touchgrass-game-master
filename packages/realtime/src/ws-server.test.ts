import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Clock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from '@touchgrass/game-session';
import { MAX_MESSAGE_BYTES, type ServerMessage, serverMessageSchema } from './protocol';
import { type RealtimeServer, createRealtimeServer } from './ws-server';

/**
 * Real sockets against a real server on a free local port. The clock is a test
 * clock that only moves when a test moves it.
 */

const T0 = 1_700_000_000_000;
const CODE = 'GRASS7';
const ROUND_MS = 180_000;

function testClock(): Clock & { set(ms: number): void } {
  let now = T0;
  return {
    now: () => now,
    set: (ms) => {
      now = T0 + ms;
    },
  };
}

function newSession(clock: Clock, sessionId = 'g1', joinCode = CODE): GameSession {
  const created = createGameSession(
    { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode, randomSeed: 7 },
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

  static open(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
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

  /** Everything received so far that no test has read. */
  pending(): number {
    return this.queue.length;
  }

  async join(displayName: string): Promise<string> {
    this.send({ type: 'join', joinCode: CODE, displayName });
    const message = await this.next();
    if (message.type !== 'joined') throw new Error(`expected joined, got ${message.type}`);
    return message.playerId;
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

let servers: RealtimeServer[] = [];

async function start(
  options: Partial<Parameters<typeof createRealtimeServer>[0]> = {},
): Promise<{ server: RealtimeServer; session: GameSession; clock: ReturnType<typeof testClock> }> {
  const clock = testClock();
  const session = options.session ?? newSession(clock);
  const server = await createRealtimeServer({ session, port: 0, clock, ...options });
  servers.push(server);
  return { server, session, clock };
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

describe('createRealtimeServer', () => {
  it('listens on a free port and reports it', async () => {
    const { server } = await start();
    expect(server.port).toBeGreaterThan(0);
    const client = await Client.open(server.port);
    expect(server.socketCount()).toBe(1);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('plays a round of Tag between three real connections', async () => {
    const { server, session, clock } = await start();
    const clients = await Promise.all([1, 2, 3].map(() => Client.open(server.port)));
    const [a, b, c] = clients as [Client, Client, Client];

    // Each joins and is given an id the server made.
    const ids: string[] = [];
    for (const [index, client] of clients.entries()) {
      ids.push(await client.join(`Player ${index}`));
      // Everyone already in the room hears about the new player.
      for (const earlier of clients.slice(0, index)) {
        expect((await earlier.next()).type).toBe('update');
      }
    }
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^plr_[0-9a-f-]{36}$/);
    expect(session.getState().players.map((player) => player.id)).toEqual(ids);

    // Everyone reports ready; the last one starts the game.
    clock.set(1_000);
    let last: ServerMessage | undefined;
    for (const client of clients) {
      client.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
      for (const listener of clients) last = await listener.next();
    }
    if (last?.type !== 'update') throw new Error('expected an update');
    expect(last.state.status).toBe('active');
    expect(last.state).toEqual(session.getState());

    const tagger = last.state.players.find((player) => player.roleId === 'tagger');
    const runner = last.state.players.find((player) => player.roleId === 'runner');
    if (!tagger || !runner) throw new Error('fixture failed');
    const taggerClient = clients[ids.indexOf(tagger.id)] as Client;
    const runnerClient = clients[ids.indexOf(runner.id)] as Client;

    // A runner tries to tag: only that connection hears the refusal.
    clock.set(6_000);
    runnerClient.send({
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: tagger.id },
    });
    expect(await runnerClient.next()).toMatchObject({
      type: 'rejected',
      error: { code: 'INVALID_ROLE' },
    });

    // The tagger tags: every connection gets the same authoritative update.
    taggerClient.send({
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: runner.id },
    });
    const updates = await Promise.all([a.next(), b.next(), c.next()]);
    for (const update of updates) {
      if (update.type !== 'update') throw new Error('expected an update');
      expect(update.state).toEqual(session.getState());
      expect(update.entries[0]?.record).toEqual({
        kind: 'ACTION',
        action: { type: 'PLAYER_TAGGED', playerId: tagger.id, targetPlayerId: runner.id },
      });
      expect(update.entries[0]?.at).toBe(T0 + 6_000);
    }
    expect(session.getState().players.find((player) => player.id === runner.id)?.roleId).toBe(
      'tagger',
    );
    // Nobody but the runner heard the refusal: no stray messages are waiting.
    for (const client of clients) expect(client.pending()).toBe(0);

    // A trusted tick from the server side ends the round for everyone.
    clock.set(1_000 + ROUND_MS);
    expect(server.room.tick(contextAt(clock)).ok).toBe(true);
    for (const client of clients) {
      const update = await client.next();
      expect(update.type === 'update' && update.state.currentRound).toBe(2);
    }
  });

  it('refuses a client that tries to name its own player, session or state', async () => {
    const { server, session } = await start();
    const client = await Client.open(server.port);
    const before = session.getState();

    for (const message of [
      { type: 'join', joinCode: CODE, displayName: 'Mallory', playerId: 'admin' },
      { type: 'join', joinCode: CODE, displayName: 'Mallory', sessionId: 'g2' },
      { type: 'action', intent: { type: 'PLAYER_READY' }, playerId: 'p0' },
      { type: 'action', intent: { type: 'PLAYER_READY' }, state: { status: 'completed' } },
      { type: 'command', command: { type: 'ABORT_SESSION', reason: 'x' } },
      'not json',
    ]) {
      client.send(message);
      expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    }
    client.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
    expect(await client.next()).toEqual({ type: 'error', code: 'NOT_JOINED' });
    client.send({ type: 'join', joinCode: 'WRONG1', displayName: 'Mallory' });
    expect(await client.next()).toEqual({ type: 'error', code: 'WRONG_JOIN_CODE' });

    expect(session.getState()).toBe(before);
    expect(server.room.connectionCount()).toBe(0);
  });

  it('refuses a binary frame', async () => {
    const { server, session } = await start();
    const client = await Client.open(server.port);
    client.socket.send(
      Buffer.from(JSON.stringify({ type: 'join', joinCode: CODE, displayName: 'B' })),
    );
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    expect(session.getState().players).toEqual([]);
  });

  it('closes a socket that sends a frame over the size limit', async () => {
    const { server, session } = await start();
    const client = await Client.open(server.port);
    await client.join('Ada');

    client.send({ type: 'action', intent: { pad: 'x'.repeat(MAX_MESSAGE_BYTES) } });
    // 1009: message too big.
    expect(await client.closed).toBe(1009);

    // The connection is forgotten; the player it joined as is still in the game.
    const other = await Client.open(server.port);
    await settled(other);
    expect(server.room.connectionCount()).toBe(0);
    expect(session.getState().players).toHaveLength(1);
  });

  it('honours a configured size limit', async () => {
    const { server } = await start({ maxMessageBytes: 64 });
    const client = await Client.open(server.port);
    client.send({ type: 'join', joinCode: CODE, displayName: 'x'.repeat(80) });
    expect(await client.closed).toBe(1009);
  });

  it('does not remove a player whose connection drops', async () => {
    const { server, session } = await start();
    const [a, b] = [await Client.open(server.port), await Client.open(server.port)];
    const first = await a.join('Ada');
    await b.join('Grace');
    await a.next();

    b.socket.close();
    await b.closed;
    await settled(a);

    expect(server.room.connectionCount()).toBe(1);
    expect(session.getState().players.map((player) => player.status)).toEqual(['active', 'active']);
    expect(session.getState().players[0]?.id).toBe(first);
  });

  it('serves exactly the session it was given: two servers, two games', async () => {
    const one = await start();
    const two = await start({ session: newSession(testClock(), 'g2', CODE) });
    const [a, b] = [await Client.open(one.server.port), await Client.open(two.server.port)];
    await a.join('Ada');
    await b.join('Grace');
    await settled(a);
    await settled(b);

    expect(one.session.getState().players.map((player) => player.displayName)).toEqual(['Ada']);
    expect(two.session.getState().players.map((player) => player.displayName)).toEqual(['Grace']);
    expect(one.session.getState().id).toBe('g1');
    expect(two.session.getState().id).toBe('g2');
    // Neither heard about the other's join.
    expect(a.pending()).toBe(0);
    expect(b.pending()).toBe(0);
  });

  it('ignores the path and query a client connects with', async () => {
    const { server, session } = await start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/sessions/g2?sessionId=g2&playerId=admin`,
    );
    await new Promise((resolve) => socket.once('open', resolve));
    const reply = new Promise<ServerMessage>((resolve) => {
      socket.once('message', (data: Buffer) => {
        resolve(serverMessageSchema.parse(JSON.parse(data.toString('utf8'))));
      });
    });
    socket.send(JSON.stringify({ type: 'join', joinCode: CODE, displayName: 'Ada' }));
    const joined = await reply;
    expect(joined.type === 'joined' && joined.state.id).toBe('g1');
    expect(joined.type === 'joined' && joined.playerId).not.toBe('admin');
    expect(session.getState().players).toHaveLength(1);
  });

  it('stamps frames with the injected clock, never the system clock', async () => {
    const { server, session, clock } = await start();
    const client = await Client.open(server.port);
    clock.set(42);
    await client.join('Ada');
    expect(session.getState().history.at(-1)?.at).toBe(T0 + 42);
  });
});

describe('shutdown', () => {
  it('closes every socket and frees the port', async () => {
    const clock = testClock();
    const server = await createRealtimeServer({ session: newSession(clock), port: 0, clock });
    const clients = [await Client.open(server.port), await Client.open(server.port)];
    await clients[0]?.join('Ada');
    const { port } = server;

    await server.close();

    for (const client of clients) expect(await client.closed).toBeGreaterThan(0);
    expect(server.socketCount()).toBe(0);
    await expect(Client.open(port)).rejects.toBeDefined();

    // The port can be bound again straight away.
    const again = await createRealtimeServer({ session: newSession(clock, 'g2'), port, clock });
    expect(again.port).toBe(port);
    await again.close();
  });

  it('rejects instead of hanging when the port is taken', async () => {
    const { server, clock } = await start();
    await expect(
      createRealtimeServer({ session: newSession(clock, 'g2'), port: server.port, clock }),
    ).rejects.toBeDefined();
  });
});

describe('the adapter is thin', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(join(directory, 'ws-server.ts'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    '',
  );

  it('holds no table of games and starts no timer', () => {
    expect(code).not.toMatch(/new Map|new Set|setTimeout|setInterval|Date\.now|new Date/);
    expect(code).not.toMatch(
      /createGameSession|submitAction|applyCommand|advanceTime|\.url\b|searchParams/,
    );
  });

  it('is the only module that imports ws', () => {
    for (const file of ['room.ts', 'protocol.ts', 'index.ts']) {
      expect(readFileSync(join(directory, file), 'utf-8')).not.toMatch(/from 'ws'/);
    }
  });
});
