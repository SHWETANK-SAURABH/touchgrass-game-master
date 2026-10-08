import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore } from '@touchgrass/session-store';
import { type PersistentServer, hostSession, startPersistentServer } from './persistent-server';
import { createPersistentSessions } from './persistent-sessions';
import {
  CODE,
  ROUND_MS,
  START,
  type TestConnection,
  at,
  codeOf,
  connection,
  countingStore,
  createCommand,
  failingStore,
  join,
  send,
  testClock,
  unwrap,
} from './test-support';

let running: PersistentServer[] = [];

type Options = Parameters<typeof startPersistentServer>[0];

/** Starts on a clock that only moves when a test moves it, unless one is given. */
const begin = (options: Options) => startPersistentServer({ clock: testClock(), ...options });

async function startServer(options: Options) {
  const started = unwrap(await begin(options));
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.close()));
  running = [];
});

const READY = { type: 'action', intent: { type: 'PLAYER_READY' } };

/** Three connections join a room and report ready, so round 1 is running. */
function fill(room: PersistentServer['room']) {
  const players = [connection(), connection(), connection()];
  const joined = players.map((who, index) => join(room, who, `Player ${index}`));
  for (const who of players) send(room, who, READY, START);
  for (const who of players) who.take();
  return { players, joined };
}

describe('startPersistentServer: a new game', () => {
  it('creates the game, saves it once, and serves it', async () => {
    const { store, calls, saved } = countingStore();
    const server = await startServer({
      store,
      port: 0,
      clock: testClock(),
      game: { create: createCommand() },
    });

    expect(server.port).toBeGreaterThan(0);
    expect(server.session.id).toBe('g1');
    expect(server.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls.save).toBe(1);
    expect(saved[0]).toEqual(server.session.snapshot());
  });

  it('starts nothing when the first save fails', async () => {
    const { store, calls } = failingStore();
    const result = await begin({
      store,
      port: 0,
      game: { create: createCommand() },
    });

    expect(codeOf(result)).toBe('STORAGE_ERROR');
    expect(Object.keys(result)).not.toContain('value');
    expect(calls.save).toBe(1);
  });

  it('starts nothing for a game that cannot be created, or an id already stored', async () => {
    const { store, calls } = countingStore();
    expect(
      codeOf(
        await begin({
          store,
          port: 0,
          game: { create: createCommand('g1', 'quidditch') },
        }),
      ),
    ).toBe('SESSION_NOT_CREATED');
    expect(calls.save).toBe(0);

    await startServer({ store, port: 0, game: { create: createCommand() } });
    expect(codeOf(await begin({ store, port: 0, game: { create: createCommand() } }))).toBe(
      'SESSION_ALREADY_EXISTS',
    );
    expect(calls.save).toBe(1);
  });

  it('reports a port it cannot bind, after which nothing is left listening', async () => {
    const { store } = countingStore();
    const first = await startServer({ store, port: 0, game: { create: createCommand('a') } });
    const result = await begin({
      store,
      port: first.port,
      game: { create: createCommand('b') },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'SERVER_NOT_STARTED', message: 'The server could not start listening.' },
    });
  });
});

describe('the room and the game', () => {
  it('plays over the room as before', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    const { players, joined } = fill(server.room);

    const state = server.session.getState();
    expect(state.status).toBe('active');
    const tagger = state.players.find((player) => player.roleId === 'tagger');
    const runner = state.players.find((player) => player.roleId === 'runner');
    const index = joined.findIndex((entry) => entry.playerId === tagger?.id);

    send(
      server.room,
      players[index] as TestConnection,
      { type: 'action', intent: { type: 'PLAYER_TAGGED', targetPlayerId: runner?.id } },
      START + 5_000,
    );

    for (const who of players)
      expect(who.take().map((message) => message.type)).toEqual(['update']);
    expect(
      server.session.getState().players.find((player) => player.id === runner?.id)?.roleId,
    ).toBe('tagger');
  });

  it('builds the room around the very session it created or loaded', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    const who = connection();
    join(server.room, who, 'Ada');
    // The room changed the same session object the server holds: there is one.
    expect(server.session.getState().players.map((player) => player.displayName)).toEqual(['Ada']);

    const session = unwrap(
      await createPersistentSessions(new InMemorySessionStore()).create(createCommand('g2'), at(0)),
    );
    const hosted = hostSession(session);
    expect(hosted.session).toBe(session);
    join(hosted.room, connection(), 'Grace');
    expect(session.getState().players).toHaveLength(1);
  });

  it('accepts a real WebSocket connection', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const reply = new Promise<{ type: string; playerId?: string }>((resolve, reject) => {
      socket.onmessage = (event) => {
        resolve(JSON.parse(String(event.data)) as { type: string });
      };
      socket.onerror = () => {
        reject(new Error('socket error'));
      };
    });
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        resolve();
      };
    });
    socket.send(JSON.stringify({ type: 'join', joinCode: CODE, displayName: 'Ada' }));
    expect((await reply).type).toBe('joined');
    expect(server.session.getState().players).toHaveLength(1);
    socket.close();
  });
});

describe('nothing is saved unless asked', () => {
  it('saves nothing on a join, an action, a host command, a tick, a resume, a leave or a disconnect', async () => {
    const { store, calls } = countingStore();
    const clock = testClock();
    const server = await startServer({ store, port: 0, clock, game: { create: createCommand() } });
    expect(calls.save).toBe(1);
    const { room } = server;

    // A join and a lobby leave.
    const leaver = connection();
    join(room, leaver, 'Leaver');
    send(room, leaver, { type: 'leave' });

    // Joins, ready actions, and the game starts.
    const { players, joined } = fill(room);

    // A host authorises and commands.
    const host = connection();
    send(room, host, { type: 'host_auth', token: server.hostToken });
    send(
      room,
      host,
      { type: 'host_command', command: { type: 'PAUSE_SESSION', reason: 'water' } },
      START + 5_000,
    );
    send(room, host, { type: 'host_command', command: { type: 'RESUME_SESSION' } }, START + 6_000);

    // A disconnect and a resume.
    room.disconnect(players[0] as TestConnection);
    send(room, connection(), { type: 'resume', token: joined[0]?.token }, START + 7_000);

    // A tick that ends a round.
    room.tick(at(START + ROUND_MS + 10_000));
    await Promise.resolve();

    expect(server.session.getState().currentRound).toBe(2);
    // Still only the one save from creation, and nothing was read or deleted since.
    expect(calls).toMatchObject({ save: 1, delete: 0 });
    expect(unwrap(await store.load('g1'))?.state.status).toBe('lobby');
  });

  it('starts no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { store, calls } = countingStore();
      const server = await startServer({ store, port: 0, game: { create: createCommand() } });
      fill(server.room);
      await vi.advanceTimersByTimeAsync(10 * ROUND_MS);
      expect(calls.save).toBe(1);
      expect(server.session.getState().currentRound).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('save', () => {
  it('saves the running game when called, as it is at that moment', async () => {
    const { store, calls } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    fill(server.room);

    expect(await server.save()).toEqual({ ok: true, value: undefined });

    expect(calls.save).toBe(2);
    expect(unwrap(await store.load('g1'))).toEqual(server.session.snapshot());
    expect(unwrap(await store.load('g1'))?.state.status).toBe('active');
  });

  it('reports a failed save and leaves the game running and unchanged', async () => {
    const backing = countingStore();
    const server = await startServer({
      store: backing.store,
      port: 0,
      game: { create: createCommand() },
    });
    const { players } = fill(server.room);
    const before = server.session.getState();

    // The database goes away after the game was created.
    backing.inner.save = () =>
      Promise.resolve({ ok: false, error: { code: 'STORAGE_ERROR', message: 'gone' } });
    const result = await server.save();

    expect(codeOf(result)).toBe('STORAGE_ERROR');
    expect(backing.calls.save).toBe(2);
    expect(server.session.getState()).toBe(before);
    // Play goes on, and nothing tries to save again.
    server.room.tick(at(START + ROUND_MS));
    expect(server.session.getState().currentRound).toBe(2);
    expect(players[0]?.take().at(-1)?.type).toBe('update');
    expect(backing.calls.save).toBe(2);
  });
});

describe('loading a stored game', () => {
  /** A game created, played into round 1 and saved, on a server that is then shut down. */
  async function stored() {
    const inner = new InMemorySessionStore();
    const first = await startServer({
      store: countingStore(inner).store,
      port: 0,
      game: { create: createCommand() },
    });
    const { joined } = fill(first.room);
    unwrap(await first.save());
    const saved = structuredClone(first.session.getState());
    const oldHostToken = first.hostToken;
    await first.close();
    return { inner, joined, saved, oldHostToken };
  }

  it('serves the game exactly as it was saved', async () => {
    const { inner, saved } = await stored();
    const { store, calls } = countingStore(inner);

    const server = await startServer({ store, port: 0, game: { load: 'g1' } });

    expect(server.session.id).toBe('g1');
    expect(server.session.getState()).toEqual(saved);
    expect(server.session.getState()).toMatchObject({ status: 'active', currentRound: 1 });
    // Loading reads; it does not save.
    expect(calls).toMatchObject({ load: 1, save: 0 });
  });

  it('does not advance, pause or reset a game because time has passed', async () => {
    const { inner, saved } = await stored();
    const clock = testClock();
    // The server comes back long after round 1 would have ended.
    clock.set(START + 10 * ROUND_MS);

    const server = await startServer({
      store: countingStore(inner).store,
      port: 0,
      clock,
      game: { load: 'g1' },
    });

    expect(server.session.getState()).toEqual(saved);
    expect(server.session.getState().timer).toEqual(saved.timer);
    expect(server.session.getState().currentRound).toBe(1);
  });

  it('gives a new room: old player tokens and the old host token do not work', async () => {
    const { inner, joined, oldHostToken } = await stored();
    const server = await startServer({
      store: countingStore(inner).store,
      port: 0,
      game: { load: 'g1' },
    });
    const { room } = server;

    expect(room.connectionCount()).toBe(0);
    expect(server.hostToken).not.toBe(oldHostToken);

    const returning = connection();
    for (const { token } of joined) send(room, returning, { type: 'resume', token }, START + 9_000);
    send(room, returning, { type: 'host_auth', token: oldHostToken }, START + 9_000);
    expect(returning.take()).toEqual(
      Array.from({ length: 4 }, () => ({ type: 'error', code: 'INVALID_TOKEN' })),
    );
    expect(room.connectionCount()).toBe(0);
    expect(room.isHost(returning)).toBe(false);

    // The players are all still in the game. Nobody is connected as them.
    expect(server.session.getState().players.map((player) => player.status)).toEqual([
      'active',
      'active',
      'active',
    ]);
    send(room, returning, READY, START + 9_000);
    expect(returning.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);

    // The new host token works, and the restored game can be controlled and saved.
    const host = connection();
    send(room, host, { type: 'host_auth', token: server.hostToken }, START + 9_000);
    send(
      room,
      host,
      { type: 'host_command', command: { type: 'PAUSE_SESSION', reason: 'water' } },
      START + 9_500,
    );
    expect(server.session.getState().status).toBe('paused');
    expect((await server.save()).ok).toBe(true);
  });

  it('stores nothing of the room: no token, host token or connection in what was saved', async () => {
    const { inner, joined, oldHostToken } = await stored();
    const text = JSON.stringify(unwrap(await inner.load('g1')));
    for (const secret of [oldHostToken, ...joined.map((entry) => entry.token)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/token|socket|connection/i);
  });

  it('reports a game that is not stored, and starts nothing', async () => {
    const { store, calls } = countingStore();
    const result = await begin({ store, port: 0, game: { load: 'nobody' } });
    expect(codeOf(result)).toBe('SESSION_NOT_FOUND');
    expect(Object.keys(result)).not.toContain('value');
    expect(calls.save).toBe(0);
  });

  it('reports a stored game that cannot be restored, and starts nothing', async () => {
    const inner = new InMemorySessionStore();
    await inner.save({ version: 1, sessionId: 'g1', state: { status: 'frozen' } } as never);
    const result = await begin({ store: inner, port: 0, game: { load: 'g1' } });
    expect(codeOf(result)).toBe('INVALID_SNAPSHOT');
  });
});

describe('close', () => {
  it('stops the server, then closes the store, and does not save', async () => {
    const { store, calls } = countingStore();
    const server = unwrap(await begin({ store, port: 0, game: { create: createCommand() } }));
    fill(server.room);
    const { port } = server;

    await server.close();

    expect(calls.close).toBe(1);
    // Shutting down is not a save: the store has the game as it was created.
    expect(calls.save).toBe(1);
    // The port is free again.
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.onopen = () => {
          reject(new Error('still listening'));
        };
        socket.onerror = () => {
          resolve('refused');
        };
      }),
    ).resolves.toBe('refused');
  });

  it('closes the store once, however often it is called', async () => {
    const { store, calls } = countingStore();
    const server = unwrap(await begin({ store, port: 0, game: { create: createCommand() } }));
    await server.close();
    await server.close();
    expect(calls.close).toBe(1);
  });

  it('leaves the store unusable: a save after shutdown fails and is not retried', async () => {
    const { store, calls } = countingStore();
    const server = unwrap(await begin({ store, port: 0, game: { create: createCommand() } }));
    await server.close();

    const result = await server.save();
    expect(codeOf(result)).toBe('STORAGE_ERROR');
    expect(calls.save).toBe(2);
    expect(unwrap(await new InMemorySessionStore().load('g1'))).toBeNull();
  });

  it('works with a store that has nothing to close', async () => {
    const server = unwrap(
      await begin({
        store: new InMemorySessionStore(),
        port: 0,
        game: { create: createCommand() },
      }),
    );
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('does not close a store when the server never started', async () => {
    const { store, calls } = countingStore();
    await begin({ store, port: 0, game: { load: 'nobody' } });
    expect(calls.close).toBe(0);
  });
});
