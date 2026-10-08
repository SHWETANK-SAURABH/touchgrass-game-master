import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameStateSchema } from '@touchgrass/game-engine';
import type { GameSessionSnapshot } from '@touchgrass/game-session';
import { InMemorySessionStore, type SessionStore } from '@touchgrass/session-store';
import {
  MongoSessionStore,
  type SessionCollection,
  type SessionDocument,
} from '@touchgrass/session-store/mongodb';
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

describe('hasUnsavedChanges', () => {
  const TAG_IN_LOBBY = {
    type: 'action',
    intent: { type: 'PLAYER_TAGGED', targetPlayerId: 'nobody' },
  };
  const pause = { type: 'host_command', command: { type: 'PAUSE_SESSION', reason: 'water' } };
  const resume = { type: 'host_command', command: { type: 'RESUME_SESSION' } };

  /**
   * A store whose saves wait until they are released, so a test can change the
   * game while a save is in flight. Everything else goes to a real store.
   */
  function gatedStore() {
    const inner = new InMemorySessionStore();
    const received: GameSessionSnapshot[] = [];
    const releases: (() => void)[] = [];
    let gated = false;
    const store: SessionStore = {
      save(snapshot) {
        received.push(snapshot);
        if (!gated) return inner.save(snapshot);
        return new Promise((resolve) => {
          releases.push(() => {
            void inner.save(snapshot).then(resolve);
          });
        });
      },
      load: (sessionId) => inner.load(sessionId),
      delete: (sessionId) => inner.delete(sessionId),
    };
    return {
      store,
      inner,
      received,
      /** From now on, saves wait. */
      hold(): void {
        gated = true;
      },
      /** Lets the oldest waiting save finish. */
      release(): void {
        releases.shift()?.();
      },
    };
  }

  it('is false for a newly created game: its first snapshot was just saved', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    expect(server.hasUnsavedChanges()).toBe(false);
    expect(unwrap(await store.load('g1'))).toEqual(server.session.snapshot());
  });

  it('becomes true when the game really changes', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });

    join(server.room, connection(), 'Ada');

    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('stays false when an operation is refused', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    const stranger = connection();
    const host = connection();

    // Refused by the transport, by the engine, and by the host command boundary.
    send(server.room, stranger, READY);
    send(server.room, stranger, { type: 'join', joinCode: 'WRONG1', displayName: 'X' });
    send(server.room, stranger, { type: 'nonsense' });
    send(server.room, host, { type: 'host_auth', token: server.hostToken });
    send(server.room, host, resume);
    expect(
      server.session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'ghost' }, at(0)).ok,
    ).toBe(false);
    expect(server.session.submitAction('ghost', { type: 'PLAYER_READY' }, at(0)).ok).toBe(false);

    expect(server.hasUnsavedChanges()).toBe(false);

    // A refused action from a real player changes nothing either, once that
    // player's own joining has been saved.
    const player = connection();
    join(server.room, player, 'Ada');
    unwrap(await server.save());
    send(server.room, player, TAG_IN_LOBBY);
    expect(player.take().at(-1)?.type).toBe('rejected');
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('stays false when time advances and nothing is due', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    fill(server.room);
    unwrap(await server.save());

    for (const ms of [START, START + 5_000, START + ROUND_MS - 1]) {
      expect(server.room.tick(at(ms)).ok).toBe(true);
      expect(server.hasUnsavedChanges()).toBe(false);
    }
  });

  it('becomes true when time alone changes the game', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    fill(server.room);
    unwrap(await server.save());
    expect(server.hasUnsavedChanges()).toBe(false);

    // The round runs out. Nobody sent anything.
    server.room.tick(at(START + ROUND_MS));

    expect(server.session.getState().currentRound).toBe(2);
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('becomes false after a successful save, however many changes came before it', async () => {
    const { store, calls } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });

    fill(server.room); // three joins, three ready actions, the game starts
    const host = connection();
    send(server.room, host, { type: 'host_auth', token: server.hostToken });
    send(server.room, host, pause, START + 5_000);
    send(server.room, host, resume, START + 6_000);
    expect(server.hasUnsavedChanges()).toBe(true);
    // Being asked changed nothing and saved nothing.
    expect(calls.save).toBe(1);

    unwrap(await server.save());

    expect(calls.save).toBe(2);
    expect(server.hasUnsavedChanges()).toBe(false);
    expect(unwrap(await store.load('g1'))).toEqual(server.session.snapshot());
  });

  it('becomes true again with the next change after a save', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    join(server.room, connection(), 'Ada');
    unwrap(await server.save());
    expect(server.hasUnsavedChanges()).toBe(false);

    join(server.room, connection(), 'Grace');
    expect(server.hasUnsavedChanges()).toBe(true);

    unwrap(await server.save());
    expect(server.hasUnsavedChanges()).toBe(false);
    // Saving again with nothing changed is allowed and leaves it false.
    unwrap(await server.save());
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('stays true after a failed save', async () => {
    const backing = countingStore();
    const server = await startServer({
      store: backing.store,
      port: 0,
      game: { create: createCommand() },
    });
    join(server.room, connection(), 'Ada');
    expect(server.hasUnsavedChanges()).toBe(true);

    backing.inner.save = () =>
      Promise.resolve({ ok: false, error: { code: 'STORAGE_ERROR', message: 'gone' } });
    const failed = await server.save();

    expect(codeOf(failed)).toBe('STORAGE_ERROR');
    expect(server.hasUnsavedChanges()).toBe(true);
    // One attempt; the failure was not retried and nothing was marked as saved.
    expect(backing.calls.save).toBe(2);
    expect(unwrap(await backing.store.load('g1'))?.state.players).toEqual([]);

    // And it does not turn a clean game dirty, or a dirty game clean, to fail twice.
    await server.save();
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('does not let a failed save hide that an earlier state is the one stored', async () => {
    const backing = countingStore();
    const good = backing.inner.save.bind(backing.inner);
    const server = await startServer({
      store: backing.store,
      port: 0,
      game: { create: createCommand() },
    });

    backing.inner.save = () =>
      Promise.resolve({ ok: false, error: { code: 'STORAGE_ERROR', message: 'gone' } });
    // Nothing has changed since creation; a failed save of the same state leaves it clean.
    expect(codeOf(await server.save())).toBe('STORAGE_ERROR');
    expect(server.hasUnsavedChanges()).toBe(false);

    join(server.room, connection(), 'Ada');
    expect(codeOf(await server.save())).toBe('STORAGE_ERROR');
    expect(server.hasUnsavedChanges()).toBe(true);

    backing.inner.save = good;
    unwrap(await server.save());
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('stays true when the game changes while a save is in flight', async () => {
    const gate = gatedStore();
    const server = await startServer({
      store: gate.store,
      port: 0,
      game: { create: createCommand() },
    });
    const stateA = server.session.getState();
    expect(server.hasUnsavedChanges()).toBe(false);

    // A → B
    join(server.room, connection(), 'Ada');
    const stateB = server.session.getState();
    expect(stateB).not.toBe(stateA);

    // The save of B starts and does not finish.
    gate.hold();
    const saving = server.save();
    expect(gate.received.at(-1)?.state).toBe(stateB);

    // B → C, while the store is still working on B.
    join(server.room, connection(), 'Grace');
    const stateC = server.session.getState();
    expect(stateC).not.toBe(stateB);
    expect(server.hasUnsavedChanges()).toBe(true);

    // The save of B succeeds.
    gate.release();
    expect(await saving).toEqual({ ok: true, value: undefined });

    // What was saved is B. C has not been saved, so there are unsaved changes.
    expect(server.session.getState()).toBe(stateC);
    expect(server.hasUnsavedChanges()).toBe(true);
    expect(gate.received).toHaveLength(2); // creation, then B
    expect(gate.received[1]?.state.players.map((player) => player.displayName)).toEqual(['Ada']);
    expect(
      unwrap(await gate.inner.load('g1'))?.state.players.map((player) => player.displayName),
    ).toEqual(['Ada']);

    // Saving C is what clears it.
    const second = server.save();
    gate.release();
    unwrap(await second);
    expect(server.hasUnsavedChanges()).toBe(false);
    expect(unwrap(await gate.inner.load('g1'))?.state.players).toHaveLength(2);
  });

  it('does not report clean during a save that has not finished', async () => {
    const gate = gatedStore();
    const server = await startServer({
      store: gate.store,
      port: 0,
      game: { create: createCommand() },
    });
    join(server.room, connection(), 'Ada');

    gate.hold();
    const saving = server.save();
    // Sent to the store, not yet confirmed: still unsaved.
    expect(server.hasUnsavedChanges()).toBe(true);

    gate.release();
    await saving;
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('is false for a loaded game, and tracks it from there', async () => {
    const inner = new InMemorySessionStore();
    const first = await startServer({
      store: countingStore(inner).store,
      port: 0,
      game: { create: createCommand() },
    });
    fill(first.room);
    unwrap(await first.save());
    await first.close();

    const { store, calls } = countingStore(inner);
    const server = await startServer({ store, port: 0, game: { load: 'g1' } });

    expect(server.hasUnsavedChanges()).toBe(false);
    expect(calls.save).toBe(0);

    // Nothing due yet: still what is stored.
    server.room.tick(at(START + 5_000));
    expect(server.hasUnsavedChanges()).toBe(false);

    server.room.tick(at(START + ROUND_MS));
    expect(server.hasUnsavedChanges()).toBe(true);
    unwrap(await server.save());
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('sees a change made directly to the session, not through the room', async () => {
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    unwrap(
      server.session.applyCommand(
        { type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Ada' },
        at(0),
      ),
    );
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('never saves, whatever it answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { store, calls } = countingStore();
      const server = await startServer({ store, port: 0, game: { create: createCommand() } });
      fill(server.room);

      for (let asked = 0; asked < 50; asked += 1) expect(server.hasUnsavedChanges()).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * ROUND_MS);

      expect(calls).toMatchObject({ save: 1, load: 1, delete: 0 });
      expect(vi.getTimerCount()).toBe(0);
      expect(server.hasUnsavedChanges()).toBe(true);
      // It takes no argument and returns a plain boolean, not a promise.
      expect(server.hasUnsavedChanges.length).toBe(0);
      expect(typeof server.hasUnsavedChanges()).toBe('boolean');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is kept by each server on its own', async () => {
    const inner = new InMemorySessionStore();
    const one = await startServer({
      store: countingStore(inner).store,
      port: 0,
      game: { create: createCommand('a') },
    });
    const two = await startServer({
      store: countingStore(inner).store,
      port: 0,
      game: { create: createCommand('b') },
    });
    join(one.room, connection(), 'Ada');
    expect(one.hasUnsavedChanges()).toBe(true);
    expect(two.hasUnsavedChanges()).toBe(false);
  });

  it('speaks only for this server: it cannot see the store being changed by something else', async () => {
    // There is no revision check. If another process deletes or replaces the
    // stored snapshot, this server still believes its last save is what is there.
    const { store } = countingStore();
    const server = await startServer({ store, port: 0, game: { create: createCommand() } });
    await store.delete('g1');
    expect(unwrap(await store.load('g1'))).toBeNull();
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  describe('is not part of the game or of anything stored', () => {
    const TRACE = /unsaved|dirty|lastSaved|hasUnsavedChanges|stateBeingSaved/i;

    it('adds nothing to the state, the history, the snapshot or what the store holds', async () => {
      const { store } = countingStore();
      const server = await startServer({ store, port: 0, game: { create: createCommand() } });
      fill(server.room);
      expect(server.hasUnsavedChanges()).toBe(true);
      unwrap(await server.save());
      server.room.tick(at(START + ROUND_MS));
      expect(server.hasUnsavedChanges()).toBe(true);

      const state = server.session.getState();
      expect(Object.keys(state).sort()).toEqual(Object.keys(gameStateSchema.shape).sort());
      expect(gameStateSchema.safeParse(state).success).toBe(true);
      expect(JSON.stringify(state)).not.toMatch(TRACE);
      expect(JSON.stringify(state.history)).not.toMatch(TRACE);

      const snapshot = server.session.snapshot();
      expect(Object.keys(snapshot).sort()).toEqual(['sessionId', 'state', 'version']);
      expect(JSON.stringify(snapshot)).not.toMatch(TRACE);

      const stored = unwrap(await store.load('g1'));
      expect(Object.keys(stored ?? {}).sort()).toEqual(['sessionId', 'state', 'version']);
      expect(JSON.stringify(stored)).not.toMatch(TRACE);
    });

    it('adds nothing to the MongoDB document', async () => {
      const documents: SessionDocument[] = [];
      const collection: SessionCollection = {
        replace(document) {
          documents.push(document);
          return Promise.resolve();
        },
        find: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const server = await startServer({
        store: new MongoSessionStore(() => collection),
        port: 0,
        game: { create: createCommand() },
      });
      join(server.room, connection(), 'Ada');
      expect(server.hasUnsavedChanges()).toBe(true);
      unwrap(await server.save());
      expect(server.hasUnsavedChanges()).toBe(false);

      expect(documents).toHaveLength(2);
      for (const document of documents) {
        expect(Object.keys(document).sort()).toEqual(['_id', 'state', 'version']);
        expect(JSON.stringify(document)).not.toMatch(TRACE);
      }
    });

    it('adds nothing to what a client is sent', async () => {
      const { store } = countingStore();
      const server = await startServer({ store, port: 0, game: { create: createCommand() } });
      const { players } = fill(server.room);
      const who = players[0] as TestConnection;
      unwrap(await server.save());
      server.room.tick(at(START + ROUND_MS));
      expect(who.raw.length).toBeGreaterThan(0);
      expect(who.raw.join('')).not.toMatch(TRACE);
    });

    it('lives in the server handle only: no lower layer knows of it', () => {
      const directory = dirname(fileURLToPath(import.meta.url));
      const root = joinPath(directory, '..', '..');
      for (const other of [
        'game-engine',
        'game-session',
        'realtime',
        'session-store',
        'session-persistence',
      ]) {
        const folder = joinPath(root, other, 'src');
        for (const name of readdirSync(folder).filter(
          (file) => file.endsWith('.ts') && !file.includes('test'),
        )) {
          expect(readFileSync(joinPath(folder, name), 'utf-8'), `${other}/${name}`).not.toMatch(
            TRACE,
          );
        }
      }
      const source = readFileSync(joinPath(directory, 'persistent-server.ts'), 'utf-8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      );
      // The marker is assigned where it is declared and in one other place: after a successful save.
      expect(source.match(/lastSavedState = /g)).toHaveLength(1);
      expect(source).toContain('if (saved.ok) lastSavedState = stateBeingSaved;');
      expect(source).not.toMatch(/revision|setInterval|setTimeout|addListener|subscribe|\.on\(/);
    });
  });
});
