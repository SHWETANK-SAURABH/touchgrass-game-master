import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type GameSession,
  type GameSessionSnapshot,
  createGameSession,
  restoreGameSession,
} from '@touchgrass/game-session';
import { InMemorySessionStore } from './in-memory';
import {
  SESSION_STORE_ERROR_CODES,
  type SessionStore,
  parseSessionId,
  sessionStoreError,
} from './store';

const T0 = 1_700_000_000_000;
/** The time context a session expects, built by hand: this package does not use the engine. */
const at = (ms: number) => ({
  now: T0 + ms,
  nextEntryId: (sequence: number) => `entry-${sequence}`,
});

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

/** A lobby with two players, or more of a game if `ready` is set. */
function session(
  sessionId: string,
  options: { ready?: boolean; gameId?: string } = {},
): GameSession {
  const created = unwrap(
    createGameSession(
      {
        type: 'CREATE_SESSION',
        sessionId,
        gameId: options.gameId ?? 'tag',
        joinCode: 'GRASS7',
        randomSeed: 7,
      },
      at(0),
    ),
  );
  for (const index of [0, 1]) {
    unwrap(
      created.applyCommand(
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  if (options.ready) {
    for (const index of [0, 1]) {
      unwrap(created.submitAction(`p${index}`, { type: 'PLAYER_READY' }, at(1_000)));
    }
  }
  return created;
}

const snapshotOf = (sessionId: string, options?: { ready?: boolean; gameId?: string }) =>
  session(sessionId, options).snapshot();

/** A plain, writable copy of a snapshot, as a caller might build or hold one. */
const writable = (snapshot: GameSessionSnapshot) =>
  JSON.parse(JSON.stringify(snapshot)) as {
    version: number;
    sessionId: string;
    state: {
      status: string;
      players: { score: number; displayName: string }[];
      history: unknown[];
    };
  };

describe('save and load', () => {
  it('returns what was saved', async () => {
    const store = new InMemorySessionStore();
    const snapshot = snapshotOf('g1', { ready: true });

    expect(await store.save(snapshot)).toEqual({ ok: true, value: undefined });
    const loaded = unwrap(await store.load('g1'));

    expect(loaded).toEqual(snapshot);
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(snapshot));
    expect(loaded?.sessionId).toBe('g1');
    expect(loaded?.version).toBe(1);
  });

  it('returns null for a session that was never saved', async () => {
    const store = new InMemorySessionStore();
    expect(await store.load('g1')).toEqual({ ok: true, value: null });
    await store.save(snapshotOf('g1'));
    expect(await store.load('g2')).toEqual({ ok: true, value: null });
  });

  it('is asynchronous: every operation returns a promise', () => {
    const store = new InMemorySessionStore();
    expect(store.save(snapshotOf('g1'))).toBeInstanceOf(Promise);
    expect(store.load('g1')).toBeInstanceOf(Promise);
    expect(store.delete('g1')).toBeInstanceOf(Promise);
  });

  it('never rejects: a failure is a value', async () => {
    const store = new InMemorySessionStore();
    await expect(store.load('')).resolves.toMatchObject({ ok: false });
    await expect(store.delete(7 as never)).resolves.toMatchObject({ ok: false });
    await expect(store.save(null as never)).resolves.toMatchObject({ ok: false });
  });
});

describe('overwrite', () => {
  it('replaces the snapshot stored for the same session id', async () => {
    const store = new InMemorySessionStore();
    const game = session('g1');
    const before = game.snapshot();
    await store.save(before);

    unwrap(game.submitAction('p0', { type: 'PLAYER_READY' }, at(1_000)));
    unwrap(game.submitAction('p1', { type: 'PLAYER_READY' }, at(1_000)));
    const after = game.snapshot();
    await store.save(after);

    const loaded = unwrap(await store.load('g1'));
    expect(loaded).toEqual(after);
    expect(loaded).not.toEqual(before);
    expect(loaded?.state.status).toBe('active');
  });

  it('keeps one snapshot per session, not a list of them', async () => {
    const store = new InMemorySessionStore();
    const game = session('g1');
    await store.save(game.snapshot());
    await store.save(game.snapshot());
    await store.delete('g1');
    expect(await store.load('g1')).toEqual({ ok: true, value: null });
  });
});

describe('delete', () => {
  it('removes a stored snapshot', async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotOf('g1'));
    expect(await store.delete('g1')).toEqual({ ok: true, value: undefined });
    expect(await store.load('g1')).toEqual({ ok: true, value: null });
  });

  it('succeeds for a session that is not there, every time, and touches nothing else', async () => {
    const store = new InMemorySessionStore();
    const kept = snapshotOf('kept');
    await store.save(kept);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await store.delete('missing')).toEqual({ ok: true, value: undefined });
    }
    expect(unwrap(await store.load('kept'))).toEqual(kept);
  });

  it('lets the same id be saved again afterwards', async () => {
    const store = new InMemorySessionStore();
    const snapshot = snapshotOf('g1');
    await store.save(snapshot);
    await store.delete('g1');
    await store.save(snapshot);
    expect(unwrap(await store.load('g1'))).toEqual(snapshot);
  });
});

describe('several sessions', () => {
  it('keeps each under its own id', async () => {
    const store = new InMemorySessionStore();
    const a = snapshotOf('a');
    const b = snapshotOf('b', { ready: true, gameId: 'hide-and-seek' });
    await store.save(a);
    await store.save(b);

    expect(unwrap(await store.load('a'))).toEqual(a);
    expect(unwrap(await store.load('b'))).toEqual(b);
    expect(unwrap(await store.load('a'))?.state.gameId).toBe('tag');
    expect(unwrap(await store.load('b'))?.state.gameId).toBe('hide-and-seek');

    await store.delete('a');
    expect(await store.load('a')).toEqual({ ok: true, value: null });
    expect(unwrap(await store.load('b'))).toEqual(b);
  });

  it('treats ids as exact text: no trimming, folding or prefix matching', async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotOf('Game'));
    for (const other of ['game', 'Game ', ' Game', 'Gam', 'Game2', '__proto__', 'constructor']) {
      expect(await store.load(other)).toEqual({ ok: true, value: null });
    }
    await store.delete('game');
    expect(unwrap(await store.load('Game'))?.sessionId).toBe('Game');
  });

  it('keeps everything in the instance: two stores share nothing', async () => {
    const one = new InMemorySessionStore();
    const two = new InMemorySessionStore();
    await one.save(snapshotOf('g1'));
    expect(await two.load('g1')).toEqual({ ok: true, value: null });
    await two.delete('g1');
    expect(unwrap(await one.load('g1'))?.sessionId).toBe('g1');
  });
});

describe('copies', () => {
  it('keeps its own copy: changing the saved object afterwards changes nothing stored', async () => {
    const store = new InMemorySessionStore();
    const original = snapshotOf('g1', { ready: true });
    const mine = writable(original);
    await store.save(mine as never);

    mine.version = 99;
    mine.state.status = 'aborted';
    (mine.state.players[0] as { score: number }).score = 999;
    mine.state.players.length = 0;
    mine.state.history.length = 0;

    expect(unwrap(await store.load('g1'))).toEqual(original);
  });

  it('does not hold the frozen snapshot a session handed out, either', async () => {
    const store = new InMemorySessionStore();
    const snapshot = snapshotOf('g1');
    await store.save(snapshot);
    const loaded = unwrap(await store.load('g1'));
    expect(loaded).not.toBe(snapshot);
    expect(loaded?.state).not.toBe(snapshot.state);
  });

  it('returns a separate copy on every load', async () => {
    const store = new InMemorySessionStore();
    const original = snapshotOf('g1', { ready: true });
    await store.save(original);

    const first = unwrap(await store.load('g1'));
    const second = unwrap(await store.load('g1'));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.state).not.toBe(second?.state);
    expect(first?.state.players).not.toBe(second?.state.players);
    expect(first?.state.history[0]).not.toBe(second?.state.history[0]);
  });

  it('returns frozen snapshots, like a session does: writing to one throws', async () => {
    const store = new InMemorySessionStore();
    const original = snapshotOf('g1', { ready: true });
    await store.save(original);
    const loaded = unwrap(await store.load('g1')) as unknown as ReturnType<typeof writable>;

    const writes: (() => void)[] = [
      () => {
        loaded.version = 2;
      },
      () => {
        loaded.sessionId = 'other';
      },
      () => {
        loaded.state.status = 'completed';
      },
      () => {
        (loaded.state.players[0] as { score: number }).score = 999;
      },
      () => {
        loaded.state.players.pop();
      },
      () => {
        loaded.state.history.length = 0;
      },
    ];
    for (const write of writes) expect(write).toThrow(TypeError);

    // Neither that copy nor the next one changed.
    expect(loaded).toEqual(original);
    expect(unwrap(await store.load('g1'))).toEqual(original);
  });

  it('is not changed by a writable copy of a loaded snapshot being changed', async () => {
    const store = new InMemorySessionStore();
    const original = snapshotOf('g1');
    await store.save(original);
    const copy = writable(unwrap(await store.load('g1')) as GameSessionSnapshot);
    copy.state.players.length = 0;
    copy.sessionId = 'other';
    expect(unwrap(await store.load('g1'))).toEqual(original);
  });
});

describe('session ids', () => {
  const VALID = [
    'g1',
    'ses_0b0e7c1e-7d0f-4c59-8f1e-2f1d3a4b5c6d',
    'a',
    ' ',
    'game one',
    '0',
    'ünï',
  ];
  const INVALID: unknown[] = ['', undefined, null, 0, 7, true, {}, [], ['g1'], { id: 'g1' }];

  it('accepts exactly what a session accepts as its id: any non-empty string', async () => {
    const store = new InMemorySessionStore();
    for (const id of VALID) {
      // The rule being matched: the engine creates a session with this id.
      const created = createGameSession(
        { type: 'CREATE_SESSION', sessionId: id, gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
        at(0),
      );
      expect(created.ok, id).toBe(true);
      expect(parseSessionId(id)).toEqual({ ok: true, value: id });

      await store.save(unwrap(created).snapshot());
      expect(unwrap(await store.load(id))?.sessionId).toBe(id);
      expect((await store.delete(id)).ok).toBe(true);
    }
  });

  it('refuses what a session refuses, and reads or writes nothing', async () => {
    const store = new InMemorySessionStore();
    const kept = snapshotOf('kept');
    await store.save(kept);

    for (const id of INVALID) {
      const created = createGameSession(
        { type: 'CREATE_SESSION', sessionId: id, gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
        at(0),
      );
      expect(created.ok).toBe(false);

      const expected = {
        ok: false,
        error: { code: 'INVALID_SESSION_ID', message: 'A session id is a non-empty string.' },
      };
      expect(parseSessionId(id)).toEqual(expected);
      expect(await store.load(id as never)).toEqual(expected);
      expect(await store.delete(id as never)).toEqual(expected);
      expect(await store.save({ ...writable(kept), sessionId: id } as never)).toEqual(expected);
    }
    expect(unwrap(await store.load('kept'))).toEqual(kept);
  });

  it('refuses to save something that has no session id at all', async () => {
    const store = new InMemorySessionStore();
    for (const value of [null, undefined, 'g1', 7, [], {}, { state: snapshotOf('g1').state }]) {
      expect(await store.save(value as never)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_SESSION_ID' },
      });
    }
    expect(await store.load('g1')).toEqual({ ok: true, value: null });
  });

  it('stores under the id in the snapshot, with no separate key to disagree with it', async () => {
    const store = new InMemorySessionStore();
    expect(store.save.length).toBe(1);
    await store.save(snapshotOf('g1'));
    expect(unwrap(await store.load('g1'))?.sessionId).toBe('g1');
  });
});

describe('errors', () => {
  it('has a vocabulary of two codes', () => {
    expect([...SESSION_STORE_ERROR_CODES]).toEqual(['INVALID_SESSION_ID', 'STORAGE_ERROR']);
  });

  it('is plain data: a code and a message, nothing of a database', () => {
    const error = sessionStoreError('STORAGE_ERROR', 'The snapshot could not be serialised.');
    expect(Object.keys(error).sort()).toEqual(['code', 'message']);
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
    expect(error).not.toBeInstanceOf(Error);
  });

  it('reports a snapshot that cannot be serialised as STORAGE_ERROR, and stores nothing', async () => {
    const store = new InMemorySessionStore();
    const previous = snapshotOf('g1');
    await store.save(previous);

    const circular: Record<string, unknown> = { ...writable(previous) };
    circular.self = circular;
    const withBigInt = { ...writable(previous), extra: 10n };

    for (const bad of [circular, withBigInt]) {
      expect(await store.save(bad as never)).toEqual({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'The snapshot could not be serialised.' },
      });
    }
    // What was there before is still there.
    expect(unwrap(await store.load('g1'))).toEqual(previous);
  });
});

describe('the boundary', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = join(directory, '..', '..');
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
    .map((name) => [name, readFileSync(join(directory, name), 'utf-8')] as const);
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('stores a snapshot and nothing else: version, session id and game state', async () => {
    const store = new InMemorySessionStore();
    await store.save(snapshotOf('g1', { ready: true }));
    const loaded = unwrap(await store.load('g1'));

    expect(Object.keys(loaded ?? {}).sort()).toEqual(['sessionId', 'state', 'version']);
    const text = JSON.stringify(loaded);
    expect(text).not.toMatch(/token|hostToken|host_auth|socket|connection|room|password|secret/i);
  });

  it('does not check that a snapshot is a valid game: that is restore’s job', async () => {
    const store = new InMemorySessionStore();
    const edited = writable(snapshotOf('g1'));
    edited.state.status = 'not-a-status';
    expect((await store.save(edited as never)).ok).toBe(true);

    const loaded = unwrap(await store.load('g1'));
    expect(loaded?.state.status).toBe('not-a-status');
    // The store kept it faithfully, and the session boundary refuses it.
    expect(restoreGameSession(loaded).ok).toBe(false);
  });

  it('hands back a snapshot a session can be restored from, which then carries on', async () => {
    const store = new InMemorySessionStore();
    const original = session('g1', { ready: true });
    await store.save(original.snapshot());

    const restored = unwrap(restoreGameSession(unwrap(await store.load('g1'))));
    expect(restored.id).toBe('g1');
    expect(restored.getState()).toEqual(original.getState());

    unwrap(restored.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(5_000)));
    expect(restored.getState().status).toBe('paused');
    // Saving is not automatic: the store still has the snapshot it was given.
    expect(unwrap(await store.load('g1'))?.state.status).toBe('active');
    expect(original.getState().status).toBe('active');
  });

  it('can be used through the interface alone', async () => {
    const store: SessionStore = new InMemorySessionStore();
    const snapshot = snapshotOf('g1');
    await store.save(snapshot);
    expect(unwrap(await store.load('g1'))).toEqual(snapshot);
    await store.delete('g1');
    expect(Object.getOwnPropertyNames(InMemorySessionStore.prototype).sort()).toEqual([
      'constructor',
      'delete',
      'load',
      'save',
    ]);
  });

  it('has no file, network, database, timer or module-level state', () => {
    expect(sources.map(([name]) => name).sort()).toEqual(['in-memory.ts', 'index.ts', 'store.ts']);
    for (const [name, source] of sources) {
      const code = strip(source);
      expect(code, name).not.toMatch(
        /node:fs|node:net|node:http|fetch\(|mongo|redis|setTimeout|setInterval|setImmediate|process\.env|Date\.now|Math\.random/i,
      );
      const topLevel = code
        .split('\n')
        .filter(
          (line) => /^(export )?(let|var)\s/.test(line) || /^(export )?const \w+ = new /.test(line),
        );
      expect(topLevel, name).toEqual([]);
    }
  });

  it('starts no timer and does no background work', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemorySessionStore();
      const pending = store.save(snapshotOf('g1'));
      expect(vi.getTimerCount()).toBe(0);
      await pending;
      await store.load('g1');
      await store.delete('g1');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('depends on the session package and shared helpers only', () => {
    const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@touchgrass/game-session',
      '@touchgrass/shared',
    ]);
    expect(manifest.devDependencies).toBeUndefined();

    for (const [name, source] of sources) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
      for (const imported of imports) {
        expect(
          imported.startsWith('./') ||
            imported === '@touchgrass/shared' ||
            imported === '@touchgrass/game-session',
          `${name} imports ${imported}`,
        ).toBe(true);
      }
    }
    // The session package is used for its snapshot type only.
    for (const [name, source] of sources) {
      const lines = source.split('\n').filter((line) => line.includes('@touchgrass/game-session'));
      for (const line of lines) expect(line, name).toMatch(/^import type /);
    }
  });

  it('is not known to the session or the realtime layer', () => {
    for (const other of ['game-session', 'realtime', 'game-engine']) {
      const manifest = readFileSync(join(root, other, 'package.json'), 'utf-8');
      expect(manifest, other).not.toContain('session-store');
      const directoryOf = join(root, other, 'src');
      for (const name of readdirSync(directoryOf).filter((file) => file.endsWith('.ts'))) {
        const source = readFileSync(join(directoryOf, name), 'utf-8');
        expect(source, `${other}/${name}`).not.toMatch(/session-store|SessionStore/);
      }
    }
  });
});

describe('a session without a store', () => {
  it('is created, played, snapshotted and restored with no store anywhere', () => {
    const game = session('g1', { ready: true });
    expect(game.getState().status).toBe('active');
    unwrap(game.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(5_000)));
    unwrap(game.applyCommand({ type: 'RESUME_SESSION' }, at(6_000)));
    unwrap(game.advanceTime(at(7_000)));

    const restored = unwrap(restoreGameSession(game.snapshot()));
    expect(restored.getState()).toEqual(game.getState());

    // No operation of a session takes a store.
    expect(createGameSession.length).toBe(2);
    expect(restoreGameSession.length).toBe(1);
    expect(game.snapshot.length).toBe(0);
    expect(Object.keys(game).sort()).toEqual([
      'advanceTime',
      'applyCommand',
      'getState',
      'id',
      'snapshot',
      'submitAction',
    ]);
  });
});
