import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Result, err } from '@touchgrass/shared';
import type { GameSessionSnapshot } from '@touchgrass/game-session';
import type * as Realtime from '@touchgrass/realtime';
import {
  InMemorySessionStore,
  type SessionStore,
  type SessionStoreError,
} from '@touchgrass/session-store';
import {
  type ClosableSessionStore,
  type PersistentServer,
  startPersistentServer,
} from './persistent-server';
import {
  ROUND_MS,
  START,
  at,
  codeOf,
  connection,
  createCommand,
  join,
  send,
  testClock,
  unwrap,
} from './test-support';

/**
 * What the realtime server's close does, under a test's control.
 *
 * The real realtime server is used and really closed. Its `close` is wrapped so
 * a test can see when it starts and ends, hold it open, or make it fail.
 */
const realtime = vi.hoisted(() => ({
  events: [] as string[],
  fail: false,
  /** While set, close waits for this before it finishes. */
  hold: undefined as Promise<void> | undefined,
}));

vi.mock('@touchgrass/realtime', async (importOriginal) => {
  const actual = await importOriginal<typeof Realtime>();
  return {
    ...actual,
    async createRealtimeServer(options: Realtime.RealtimeServerOptions) {
      const server = await actual.createRealtimeServer(options);
      return {
        ...server,
        async close() {
          realtime.events.push('realtime.close:start');
          await server.close();
          if (realtime.hold) await realtime.hold;
          realtime.events.push('realtime.close:end');
          if (realtime.fail) throw new Error('the realtime server would not stop');
        },
      };
    },
  };
});

const STORAGE_ERROR: SessionStoreError = {
  code: 'STORAGE_ERROR',
  message: 'The database is away.',
};

/** A real in-memory store that records what is asked of it, in the shared event list. */
function recordingStore(inner: SessionStore = new InMemorySessionStore()) {
  const saved: GameSessionSnapshot[] = [];
  const control = { failSave: false, failClose: false };
  const store: ClosableSessionStore = {
    save(snapshot): Promise<Result<void, SessionStoreError>> {
      realtime.events.push('store.save');
      if (control.failSave) return Promise.resolve(err(STORAGE_ERROR));
      saved.push(snapshot);
      return inner.save(snapshot);
    },
    load: (sessionId) => inner.load(sessionId),
    delete: (sessionId) => inner.delete(sessionId),
    close() {
      realtime.events.push('store.close');
      return control.failClose
        ? Promise.reject(new Error('the store would not close'))
        : Promise.resolve();
    },
  };
  return { store, inner, saved, control };
}

const count = (event: string): number => realtime.events.filter((entry) => entry === event).length;

let open: PersistentServer[] = [];

/** A new game on a recording store, with the events of its creation cleared. */
async function started(backing = recordingStore()) {
  const server = unwrap(
    await startPersistentServer({
      store: backing.store,
      port: 0,
      clock: testClock(),
      game: { create: createCommand() },
    }),
  );
  open.push(server);
  // Forget the save that creating the game made, so each test counts only its own.
  realtime.events.length = 0;
  backing.saved.length = 0;
  return { server, ...backing };
}

/** Makes the game dirty: one player joins. */
function change(server: PersistentServer, name = 'Ada'): void {
  join(server.room, connection(), name);
}

beforeEach(() => {
  realtime.events.length = 0;
  realtime.fail = false;
  realtime.hold = undefined;
});

afterEach(async () => {
  realtime.fail = false;
  realtime.hold = undefined;
  await Promise.all(open.map((server) => server.close().catch(() => undefined)));
  open = [];
});

describe('shutdown: a game with unsaved changes', () => {
  it('stops the realtime server, saves once, closes the store, and succeeds', async () => {
    const { server, inner, saved } = await started();
    change(server);
    expect(server.hasUnsavedChanges()).toBe(true);
    const live = structuredClone(server.session.getState());
    const { port } = server;

    const result = await server.shutdown();

    expect(result).toEqual({ ok: true, value: undefined });
    expect(realtime.events).toEqual([
      'realtime.close:start',
      'realtime.close:end',
      'store.save',
      'store.close',
    ]);
    // What is stored is the game as it was when shutdown was asked for.
    expect(saved).toHaveLength(1);
    expect(unwrap(await inner.load('g1'))?.state).toEqual(live);
    expect(unwrap(await inner.load('g1'))).toEqual(server.session.snapshot());
    expect(server.hasUnsavedChanges()).toBe(false);
    // The realtime server really stopped.
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

  it('saves the final state after many changes, including ones time made', async () => {
    const { server, inner } = await started();
    const players = [connection(), connection(), connection()];
    for (const [index, who] of players.entries()) join(server.room, who, `Player ${index}`);
    for (const who of players) {
      send(server.room, who, { type: 'action', intent: { type: 'PLAYER_READY' } }, START);
    }
    server.room.tick(at(START + ROUND_MS));
    expect(server.session.getState().currentRound).toBe(2);

    unwrap(await server.shutdown());

    expect(count('store.save')).toBe(1);
    expect(unwrap(await inner.load('g1'))?.state).toEqual(server.session.getState());
    expect(unwrap(await inner.load('g1'))?.state.currentRound).toBe(2);
  });

  it('does not begin the final save until the realtime server has finished stopping', async () => {
    const { server } = await started();
    change(server);
    let release = (): void => undefined;
    realtime.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stopping = server.shutdown();
    // Give the save every chance to start early, if it were going to.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(realtime.events).toEqual(['realtime.close:start']);
    expect(count('store.save')).toBe(0);
    expect(count('store.close')).toBe(0);

    release();
    unwrap(await stopping);
    expect(realtime.events).toEqual([
      'realtime.close:start',
      'realtime.close:end',
      'store.save',
      'store.close',
    ]);
  });

  it('saves what the game is once the realtime server has stopped, not what it was when asked', async () => {
    // A change that lands while the realtime server is still stopping is part
    // of the final state, and is saved.
    const { server, inner } = await started();
    change(server, 'Ada');
    let release = (): void => undefined;
    realtime.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stopping = server.shutdown();
    await Promise.resolve();
    unwrap(
      server.session.applyCommand(
        { type: 'ADD_PLAYER', playerId: 'late', displayName: 'Late' },
        at(0),
      ),
    );
    release();
    unwrap(await stopping);

    expect(
      unwrap(await inner.load('g1'))?.state.players.map((player) => player.displayName),
    ).toEqual(['Ada', 'Late']);
    expect(server.hasUnsavedChanges()).toBe(false);
  });
});

describe('shutdown: a game with nothing unsaved', () => {
  it('stops the realtime server and closes the store without saving', async () => {
    const { server, saved } = await started();
    expect(server.hasUnsavedChanges()).toBe(false);

    const result = await server.shutdown();

    expect(result).toEqual({ ok: true, value: undefined });
    expect(realtime.events).toEqual(['realtime.close:start', 'realtime.close:end', 'store.close']);
    expect(saved).toHaveLength(0);
  });

  it('does not save a game that was changed and then saved', async () => {
    const { server } = await started();
    change(server);
    unwrap(await server.save());
    realtime.events.length = 0;

    unwrap(await server.shutdown());

    expect(count('store.save')).toBe(0);
    expect(count('store.close')).toBe(1);
  });

  it('does not save because of refused operations or time that changed nothing', async () => {
    const { server } = await started();
    send(server.room, connection(), { type: 'action', intent: { type: 'PLAYER_READY' } });
    server.room.tick(at(60_000));
    expect(server.hasUnsavedChanges()).toBe(false);

    unwrap(await server.shutdown());
    expect(count('store.save')).toBe(0);
  });
});

describe('shutdown: the final save fails', () => {
  it('returns the persistence error, still closes the store, and leaves the game unsaved', async () => {
    const { server, inner, control } = await started();
    change(server);
    control.failSave = true;

    const result = await server.shutdown();

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'STORAGE_ERROR',
        message: 'The database is away.',
        cause: { code: 'STORAGE_ERROR', message: 'The database is away.' },
      },
    });
    // One attempt, after the realtime server stopped; then the store was closed anyway.
    expect(realtime.events).toEqual([
      'realtime.close:start',
      'realtime.close:end',
      'store.save',
      'store.close',
    ]);
    expect(server.hasUnsavedChanges()).toBe(true);
    // The store has the game as it was created, not as it ended.
    expect(unwrap(await inner.load('g1'))?.state.players).toEqual([]);
  });

  it('does not retry, then or later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { server, control } = await started();
      change(server);
      control.failSave = true;

      await server.shutdown();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(count('store.save')).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shutdown: something will not close', () => {
  it('still closes the store when the realtime server fails to stop, and throws that failure', async () => {
    const { server, inner } = await started();
    change(server);
    realtime.fail = true;

    await expect(server.shutdown()).rejects.toThrow('the realtime server would not stop');

    // The final save was still attempted and the store was still closed.
    expect(realtime.events).toEqual([
      'realtime.close:start',
      'realtime.close:end',
      'store.save',
      'store.close',
    ]);
    // Whether the game was kept is still answerable.
    expect(server.hasUnsavedChanges()).toBe(false);
    expect(unwrap(await inner.load('g1'))?.state.players).toHaveLength(1);
  });

  it('throws when the store fails to close, after the final save', async () => {
    const { server, inner, control } = await started();
    change(server);
    control.failClose = true;

    await expect(server.shutdown()).rejects.toThrow('the store would not close');

    expect(count('store.save')).toBe(1);
    expect(count('store.close')).toBe(1);
    expect(unwrap(await inner.load('g1'))?.state.players).toHaveLength(1);
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('throws the first failure when both fail', async () => {
    const { server, control } = await started();
    realtime.fail = true;
    control.failClose = true;
    await expect(server.shutdown()).rejects.toThrow('the realtime server would not stop');
    expect(count('store.close')).toBe(1);
  });
});

describe('close: unchanged, and no longer leaks the store', () => {
  it('does not save a game with unsaved changes', async () => {
    const { server, inner, saved } = await started();
    change(server);
    expect(server.hasUnsavedChanges()).toBe(true);

    await server.close();

    expect(realtime.events).toEqual(['realtime.close:start', 'realtime.close:end', 'store.close']);
    expect(saved).toHaveLength(0);
    // The change is discarded: the store still has the empty lobby.
    expect(unwrap(await inner.load('g1'))?.state.players).toEqual([]);
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('closes the store even when the realtime server fails to stop, and throws that failure', async () => {
    const { server } = await started();
    change(server);
    realtime.fail = true;

    await expect(server.close()).rejects.toThrow('the realtime server would not stop');

    expect(realtime.events).toEqual(['realtime.close:start', 'realtime.close:end', 'store.close']);
    expect(count('store.save')).toBe(0);
  });

  it('throws when the store fails to close', async () => {
    const { server, control } = await started();
    control.failClose = true;
    await expect(server.close()).rejects.toThrow('the store would not close');
    expect(count('store.save')).toBe(0);
  });
});

describe('shutdown and close together', () => {
  it('does nothing more when shutdown is called twice', async () => {
    const { server } = await started();
    change(server);

    const first = await server.shutdown();
    const second = await server.shutdown();

    expect(first).toEqual({ ok: true, value: undefined });
    expect(second).toEqual(first);
    expect(count('store.save')).toBe(1);
    expect(count('store.close')).toBe(1);
    expect(count('realtime.close:start')).toBe(1);
  });

  it('gives two overlapping shutdown calls the same single shutdown', async () => {
    const { server } = await started();
    change(server);
    const [a, b] = await Promise.all([server.shutdown(), server.shutdown()]);
    expect(a).toEqual(b);
    expect(count('store.save')).toBe(1);
    expect(count('store.close')).toBe(1);
  });

  it('reports the same failed save again, without trying again', async () => {
    const { server, control } = await started();
    change(server);
    control.failSave = true;

    const first = await server.shutdown();
    control.failSave = false;
    const second = await server.shutdown();

    expect(codeOf(first)).toBe('STORAGE_ERROR');
    expect(second).toEqual(first);
    expect(count('store.save')).toBe(1);
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('does nothing when shutdown follows close: nothing is saved and nothing is closed again', async () => {
    const { server, saved } = await started();
    change(server);
    await server.close();
    realtime.events.length = 0;

    const result = await server.shutdown();

    expect(result).toEqual({ ok: true, value: undefined });
    expect(realtime.events).toEqual([]);
    expect(saved).toHaveLength(0);
    // The game was closed without saving, and that is still visible.
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('does nothing when close follows shutdown', async () => {
    const { server } = await started();
    change(server);
    unwrap(await server.shutdown());
    realtime.events.length = 0;

    await expect(server.close()).resolves.toBeUndefined();
    await server.close();

    expect(realtime.events).toEqual([]);
  });

  it('leaves the store closed: an explicit save after shutdown reaches a closed store', async () => {
    const closed = { value: false };
    const inner = new InMemorySessionStore();
    const store: ClosableSessionStore = {
      save: (snapshot) =>
        closed.value
          ? Promise.resolve(err({ code: 'STORAGE_ERROR', message: 'The session store is closed.' }))
          : inner.save(snapshot),
      load: (sessionId) => inner.load(sessionId),
      delete: (sessionId) => inner.delete(sessionId),
      close() {
        closed.value = true;
        return Promise.resolve();
      },
    };
    const server = unwrap(
      await startPersistentServer({
        store,
        port: 0,
        clock: testClock(),
        game: { create: createCommand() },
      }),
    );
    open.push(server);
    unwrap(await server.shutdown());
    expect(codeOf(await server.save())).toBe('STORAGE_ERROR');
  });
});

describe('shutdown adds no policy beyond itself', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const strip = (name: string): string =>
    readFileSync(joinPath(directory, name), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('starts no timer and saves nothing until it is called', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { server } = await started();
      change(server);
      await vi.advanceTimersByTimeAsync(10 * ROUND_MS);
      expect(count('store.save')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      unwrap(await server.shutdown());
      expect(vi.getTimerCount()).toBe(0);
      expect(count('store.save')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no timer, retry or revision in the server source', () => {
    const code = strip('persistent-server.ts');
    // Saves are made one at a time by waiting on the previous one. That is a
    // promise to wait on, not a timer, a retry or a version check.
    expect(code).not.toMatch(/setTimeout|setInterval|setImmediate|retry|revision/i);
    // The final save is the existing save, called from one place.
    expect(code.match(/await save\(\)/g)).toHaveLength(1);
    expect(code.match(/sessions\.save\(/g)).toHaveLength(1);
    // close() asks for no final save.
    expect(code).toContain('await stop(false);');
    expect(code).toContain('shuttingDown = stop(true);');
  });

  it('is what the development server uses to stop, for both quit and Ctrl+C', () => {
    const dev = strip('dev.ts');
    expect(dev).toContain('await server.shutdown()');
    expect(dev).not.toMatch(/server\.close\(/);
    // One shutdown function, reached from the quit command and from SIGINT only.
    expect(dev.match(/void shutdown\(\)/g)).toHaveLength(2);
    expect(dev).toMatch(/command === 'quit'\) \{\s*void shutdown\(\);/);
    expect(dev).toMatch(/process\.once\('SIGINT', \(\) => \{\s*void shutdown\(\);/);
    expect(dev).not.toMatch(/SIGTERM|SIGHUP/);
    // A failed final save, or a shutdown that throws, exits non-zero; success exits zero.
    expect(dev).toMatch(/if \(!result\.ok\) \{\s*console\.error\([^;]*;\s*process\.exit\(1\);/);
    expect(dev).toMatch(/catch \{\s*console\.error\([^;]*;\s*process\.exit\(1\);/);
    expect(dev.match(/process\.exit\(0\)/g)).toHaveLength(1);
  });
});
