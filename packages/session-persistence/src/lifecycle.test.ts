import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type Result, err, ok } from '@touchgrass/shared';
import {
  type GameSession,
  type GameSessionSnapshot,
  createGameSession,
} from '@touchgrass/game-session';
import {
  InMemorySessionStore,
  type SessionStore,
  type SessionStoreError,
} from '@touchgrass/session-store';
import {
  SESSION_PERSISTENCE_ERROR_CODES,
  deleteSession,
  loadSession,
  saveSession,
} from './lifecycle';

const T0 = 1_700_000_000_000;
const at = (ms: number) => ({
  now: T0 + ms,
  nextEntryId: (sequence: number) => `entry-${sequence}`,
});
const START = 1_000;
const ROUND_MS = 180_000;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

const codeOf = (result: { ok: true } | { ok: false; error: { code: string } }): string =>
  result.ok ? 'ok' : result.error.code;

/** A three-player Tag game with round 1 running. */
function running(sessionId = 'g1'): GameSession {
  const session = unwrap(
    createGameSession(
      { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
      at(0),
    ),
  );
  for (const index of [0, 1, 2]) {
    unwrap(
      session.applyCommand(
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  for (const index of [0, 1, 2]) {
    unwrap(session.submitAction(`p${index}`, { type: 'PLAYER_READY' }, at(START)));
  }
  return session;
}

/** Makes the tagger tag a runner, at `ms`. */
function playTag(session: GameSession, ms: number): void {
  const players = session.getState().players;
  const tagger = players.find((player) => player.roleId === 'tagger');
  const runner = players.find((player) => player.roleId === 'runner');
  if (!tagger || !runner) throw new Error('fixture failed');
  unwrap(
    session.submitAction(tagger.id, { type: 'PLAYER_TAGGED', targetPlayerId: runner.id }, at(ms)),
  );
}

/** Counts every call a store receives, and passes each on to a real one. */
function counting(inner: SessionStore = new InMemorySessionStore()) {
  const calls = { save: 0, load: 0, delete: 0 };
  const saved: GameSessionSnapshot[] = [];
  const store: SessionStore = {
    save(snapshot) {
      calls.save += 1;
      saved.push(snapshot);
      return inner.save(snapshot);
    },
    load(sessionId) {
      calls.load += 1;
      return inner.load(sessionId);
    },
    delete(sessionId) {
      calls.delete += 1;
      return inner.delete(sessionId);
    },
  };
  return { store, calls, saved };
}

/** A stored snapshot as writable data, for tests that damage one. */
interface Editable {
  version: number;
  hostToken?: string;
  state: {
    status: string;
    gameId: string;
    players?: unknown[];
    history: unknown[];
    timer: { endsAt: number | null };
  };
}

const STORAGE_ERROR: SessionStoreError = { code: 'STORAGE_ERROR', message: 'The disk is on fire.' };

/** A store whose every operation reports a storage failure. */
function failing() {
  const calls = { save: 0, load: 0, delete: 0 };
  const fail = <T>(key: keyof typeof calls): Promise<Result<T, SessionStoreError>> => {
    calls[key] += 1;
    return Promise.resolve(err(STORAGE_ERROR));
  };
  const store: SessionStore = {
    save: () => fail('save'),
    load: () => fail('load'),
    delete: () => fail('delete'),
  };
  return { store, calls };
}

/** A store that hands back whatever it was built with, whether or not it is a snapshot. */
function holding(value: unknown): SessionStore {
  return {
    save: () => Promise.resolve(ok(undefined)),
    load: () => Promise.resolve(ok(value as GameSessionSnapshot | null)),
    delete: () => Promise.resolve(ok(undefined)),
  };
}

describe('saveSession and loadSession', () => {
  it('saves a session and loads it back as a session', async () => {
    const store = new InMemorySessionStore();
    const original = running();
    playTag(original, START + 5_000);

    expect(await saveSession(store, original)).toEqual({ ok: true, value: undefined });
    const loaded = unwrap(await loadSession(store, 'g1'));

    expect(loaded.id).toBe('g1');
    expect(loaded.getState()).toEqual(original.getState());
    expect(loaded.getState().history).toEqual(original.getState().history);
    expect(loaded).not.toBe(original);
    // What comes back is a session, with a session's operations, not a state.
    expect(Object.keys(loaded).sort()).toEqual([
      'advanceTime',
      'applyCommand',
      'applyEvent',
      'getState',
      'id',
      'snapshot',
      'submitAction',
    ]);
  });

  it('gives a session that carries on playing', async () => {
    const store = new InMemorySessionStore();
    const original = running();
    await saveSession(store, original);
    const loaded = unwrap(await loadSession(store, 'g1'));

    playTag(loaded, START + 5_000);
    unwrap(loaded.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(START + 6_000)));
    unwrap(loaded.applyCommand({ type: 'RESUME_SESSION' }, at(START + 7_000)));
    unwrap(loaded.advanceTime(at(START + 3 * ROUND_MS + 1_000)));

    expect(loaded.getState().status).toBe('completed');
    // The session it was loaded from is a separate object and did not move.
    expect(original.getState().status).toBe('active');
  });

  it('saves the session as it was at that moment, and nothing later', async () => {
    const store = new InMemorySessionStore();
    const session = running();
    await saveSession(store, session);
    const atSave = structuredClone(session.getState());

    playTag(session, START + 5_000);

    expect(unwrap(await loadSession(store, 'g1')).getState()).toEqual(atSave);
    expect(session.getState()).not.toEqual(atSave);

    // An explicit second save is what moves the stored copy forward.
    await saveSession(store, session);
    expect(unwrap(await loadSession(store, 'g1')).getState()).toEqual(session.getState());
  });

  it('takes the snapshot from the session itself, once, and gives the store exactly that', async () => {
    const { store, calls, saved } = counting();
    const session = running();
    const snapshot = vi.spyOn(session, 'snapshot');

    await saveSession(store, session);

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(calls).toEqual({ save: 1, load: 0, delete: 0 });
    expect(saved[0]).toEqual(session.snapshot());
    expect(Object.keys(saved[0] ?? {}).sort()).toEqual(['sessionId', 'state', 'version']);
    // It reads the session through snapshot() only.
    expect(saveSession.length).toBe(2);
  });

  it('accepts a session, not a state or a snapshot', async () => {
    const { store, calls } = counting();
    const session = running();
    for (const value of [
      session.getState(),
      session.snapshot(),
      { id: 'g1', getState: () => session.getState() },
      null,
      undefined,
      'g1',
    ]) {
      const result = await saveSession(store, value as never);
      expect(codeOf(result)).toBe('INVALID_SNAPSHOT');
    }
    expect(calls.save).toBe(0);
  });

  it('keeps each session under its own id', async () => {
    const store = new InMemorySessionStore();
    const a = running('a');
    const b = running('b');
    playTag(b, START + 5_000);
    await saveSession(store, a);
    await saveSession(store, b);

    expect(unwrap(await loadSession(store, 'a')).getState()).toEqual(a.getState());
    expect(unwrap(await loadSession(store, 'b')).getState()).toEqual(b.getState());
  });
});

describe('loadSession: nothing saved', () => {
  it('reports SESSION_NOT_FOUND, and creates nothing', async () => {
    const { store, calls } = counting();
    const result = await loadSession(store, 'g1');

    expect(result).toEqual({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'No saved session "g1".' },
    });
    expect(Object.keys(result)).not.toContain('value');
    // It looked once, and did not save a new game in its place.
    expect(calls).toEqual({ save: 0, load: 1, delete: 0 });
    expect(codeOf(await loadSession(store, 'g1'))).toBe('SESSION_NOT_FOUND');
  });

  it('is a different outcome from a store that failed', async () => {
    const missing = await loadSession(new InMemorySessionStore(), 'g1');
    const broken = await loadSession(failing().store, 'g1');
    expect(codeOf(missing)).toBe('SESSION_NOT_FOUND');
    expect(codeOf(broken)).toBe('STORAGE_ERROR');
  });
});

describe('loadSession: a snapshot that cannot be restored', () => {
  /** A real store holding a snapshot that was edited after it was saved. */
  async function storeWith(damage: (snapshot: Editable) => void) {
    const inner = new InMemorySessionStore();
    const snapshot = JSON.parse(JSON.stringify(running().snapshot())) as Editable;
    damage(snapshot);
    unwrap(await inner.save(snapshot as never));
    return counting(inner);
  }

  it.each([
    [
      'a status the game does not have',
      (s: Editable) => (s.state.status = 'frozen'),
      'INVALID_GAME_STATE',
    ],
    ['a missing field', (s: Editable) => delete s.state.players, 'INVALID_GAME_STATE'],
    ['a wrong version', (s: Editable) => (s.version = 2), 'INVALID_GAME_STATE'],
    ['an extra field', (s: Editable) => (s.hostToken = 'secret'), 'INVALID_GAME_STATE'],
    ['a gap in its history', (s: Editable) => s.state.history.splice(2, 1), 'INVALID_GAME_STATE'],
    [
      'a round that had already run out',
      (s: Editable) => (s.state.timer.endsAt = T0),
      'INVALID_GAME_STATE',
    ],
    [
      'a game nobody has defined',
      (s: Editable) => (s.state.gameId = 'quidditch'),
      'INVALID_GAME_CONFIGURATION',
    ],
  ])('refuses %s, says why, and returns no session', async (_label, damage, reason) => {
    const { store, calls } = await storeWith(damage);
    const before = JSON.stringify(unwrap(await store.load('g1')));
    calls.load = 0;

    const result = await loadSession(store, 'g1');

    expect(codeOf(result)).toBe('INVALID_SNAPSHOT');
    expect(Object.keys(result)).not.toContain('value');
    if (!result.ok) {
      expect(result.error.message).toBe('The saved session could not be restored.');
      // The session boundary's own reason is passed on, not swallowed.
      expect(result.error.cause?.code).toBe(reason);
      expect(result.error.cause?.message.length).toBeGreaterThan(10);
    }
    // The store was read once and not written: the bad snapshot is still there.
    expect(calls).toEqual({ save: 0, load: 1, delete: 0 });
    expect(JSON.stringify(unwrap(await store.load('g1')))).toBe(before);
  });

  it.each([
    ['a string', 'snapshot'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}],
    ['a bare game state', running().getState()],
  ])('refuses %s handed back by a store', async (_label, value) => {
    const result = await loadSession(holding(value), 'g1');
    expect(codeOf(result)).toBe('INVALID_SNAPSHOT');
  });

  it('refuses a valid snapshot of a different session', async () => {
    const other = running('other').snapshot();
    const result = await loadSession(holding(other), 'g1');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INVALID_SNAPSHOT',
        message: 'The store returned a snapshot of a different session.',
      },
    });
  });
});

describe('saveSession: the store fails', () => {
  it('reports the failure, and leaves the session exactly as it was and usable', async () => {
    const { store, calls } = failing();
    const session = running();
    playTag(session, START + 5_000);
    const before = session.getState();

    const result = await saveSession(store, session);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'STORAGE_ERROR',
        message: 'The disk is on fire.',
        cause: { code: 'STORAGE_ERROR', message: 'The disk is on fire.' },
      },
    });
    // The very same state object: nothing was rolled back or touched.
    expect(session.getState()).toBe(before);
    // One attempt. No retry, then or later.
    expect(calls.save).toBe(1);
    await Promise.resolve();
    expect(calls.save).toBe(1);

    // The game goes on.
    playTag(session, START + 6_000);
    unwrap(session.advanceTime(at(START + ROUND_MS)));
    expect(session.getState().currentRound).toBe(2);
    expect(calls.save).toBe(1);
  });

  it('leaves the live game ahead of what is stored: there is no transaction', async () => {
    const good = new InMemorySessionStore();
    const session = running();
    await saveSession(good, session);
    const stored = structuredClone(session.getState());

    // An action is accepted, and then the save that follows it fails.
    playTag(session, START + 5_000);
    const failed = await saveSession(failing().store, session);

    expect(codeOf(failed)).toBe('STORAGE_ERROR');
    // The action stands in the live session...
    expect(session.getState().history.length).toBe(stored.history.length + 2);
    // ...and the store still has the older snapshot.
    expect(unwrap(await loadSession(good, 'g1')).getState()).toEqual(stored);
  });

  it('starts no timer and schedules nothing after a failure', async () => {
    vi.useFakeTimers();
    try {
      const { store, calls } = failing();
      await saveSession(store, running());
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.save).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a store that throws or rejects the same way, without throwing itself', async () => {
    const session = running();
    const throwing: SessionStore = {
      save: () => {
        throw new Error('driver exploded');
      },
      load: () => Promise.reject(new Error('socket hang up')),
      delete: () => Promise.reject(new Error('socket hang up')),
    };
    const expected = {
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The store failed without reporting an error.' },
    };
    expect(await saveSession(throwing, session)).toEqual(expected);
    expect(await loadSession(throwing, 'g1')).toEqual(expected);
    expect(await deleteSession(throwing, 'g1')).toEqual(expected);
    // Nothing of the driver's own error crosses the boundary.
    expect(JSON.stringify(await loadSession(throwing, 'g1'))).not.toMatch(/socket|driver|stack/);
  });
});

describe('deleteSession', () => {
  it('removes the saved session, which can then no longer be loaded', async () => {
    const store = new InMemorySessionStore();
    await saveSession(store, running());

    expect(await deleteSession(store, 'g1')).toEqual({ ok: true, value: undefined });
    expect(codeOf(await loadSession(store, 'g1'))).toBe('SESSION_NOT_FOUND');
  });

  it('does not touch a session that is still running', async () => {
    const store = new InMemorySessionStore();
    const session = running();
    playTag(session, START + 5_000);
    await saveSession(store, session);
    const before = session.getState();

    await deleteSession(store, 'g1');

    expect(session.getState()).toBe(before);
    expect(session.getState().status).toBe('active');
    // It can keep playing, and be saved again.
    playTag(session, START + 6_000);
    await saveSession(store, session);
    expect(unwrap(await loadSession(store, 'g1')).getState()).toEqual(session.getState());
  });

  it('succeeds for a session that was never saved, and does not create one', async () => {
    const { store, calls } = counting();
    expect(await deleteSession(store, 'g1')).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual({ save: 0, load: 0, delete: 1 });
    expect(codeOf(await loadSession(store, 'g1'))).toBe('SESSION_NOT_FOUND');
  });

  it('affects only the session named', async () => {
    const store = new InMemorySessionStore();
    await saveSession(store, running('a'));
    await saveSession(store, running('b'));
    await deleteSession(store, 'a');
    expect(codeOf(await loadSession(store, 'a'))).toBe('SESSION_NOT_FOUND');
    expect(unwrap(await loadSession(store, 'b')).id).toBe('b');
  });

  it('reports a store failure', async () => {
    const { store, calls } = failing();
    expect(codeOf(await deleteSession(store, 'g1'))).toBe('STORAGE_ERROR');
    expect(calls.delete).toBe(1);
  });
});

describe('outcomes are distinct', () => {
  it('has four error codes', () => {
    expect([...SESSION_PERSISTENCE_ERROR_CODES]).toEqual([
      'INVALID_SESSION_ID',
      'SESSION_NOT_FOUND',
      'STORAGE_ERROR',
      'INVALID_SNAPSHOT',
    ]);
  });

  it('tells an invalid id, a missing session, a store failure and a bad snapshot apart', async () => {
    const good = new InMemorySessionStore();
    await saveSession(good, running());

    const outcomes = {
      invalidId: codeOf(await loadSession(good, '')),
      missing: codeOf(await loadSession(good, 'nobody')),
      storage: codeOf(await loadSession(failing().store, 'g1')),
      badSnapshot: codeOf(await loadSession(holding({ version: 1 }), 'g1')),
      loaded: codeOf(await loadSession(good, 'g1')),
      saved: codeOf(await saveSession(good, running('g2'))),
      deleted: codeOf(await deleteSession(good, 'g1')),
    };
    expect(outcomes).toEqual({
      invalidId: 'INVALID_SESSION_ID',
      missing: 'SESSION_NOT_FOUND',
      storage: 'STORAGE_ERROR',
      badSnapshot: 'INVALID_SNAPSHOT',
      loaded: 'ok',
      saved: 'ok',
      deleted: 'ok',
    });
    expect(new Set(Object.values(outcomes)).size).toBe(5);
  });

  it.each([
    ['an empty id', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an object', { id: 'g1' }],
  ])('refuses %s as a session id without asking the store', async (_label, id) => {
    const { store, calls } = counting();
    expect(codeOf(await loadSession(store, id as never))).toBe('INVALID_SESSION_ID');
    expect(codeOf(await deleteSession(store, id as never))).toBe('INVALID_SESSION_ID');
    expect(calls).toEqual({ save: 0, load: 0, delete: 0 });
  });

  it('returns errors that are plain data', async () => {
    const errors = [
      await loadSession(new InMemorySessionStore(), ''),
      await loadSession(new InMemorySessionStore(), 'g1'),
      await loadSession(failing().store, 'g1'),
      await loadSession(holding({}), 'g1'),
    ];
    for (const result of errors) {
      if (result.ok) throw new Error('expected a failure');
      expect(JSON.parse(JSON.stringify(result.error))).toEqual(result.error);
      expect(result.error).not.toBeInstanceOf(Error);
      expect(
        Object.keys(result.error).every((key) => ['code', 'message', 'cause'].includes(key)),
      ).toBe(true);
    }
  });

  it('never rejects', async () => {
    const store = new InMemorySessionStore();
    await expect(loadSession(store, null as never)).resolves.toMatchObject({ ok: false });
    await expect(saveSession(store, null as never)).resolves.toMatchObject({ ok: false });
    await expect(deleteSession(store, null as never)).resolves.toMatchObject({ ok: false });
    await expect(loadSession(null as never, 'g1')).resolves.toMatchObject({ ok: false });
  });
});

describe('nothing is saved unless a caller asks', () => {
  it('playing a session calls no store: a session has none', async () => {
    const { store, calls } = counting();
    const session = running();
    await saveSession(store, session);
    calls.save = 0;

    playTag(session, START + 5_000);
    unwrap(session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(START + 6_000)));
    unwrap(session.applyCommand({ type: 'RESUME_SESSION' }, at(START + 7_000)));
    unwrap(session.advanceTime(at(START + ROUND_MS + 7_000)));
    session.snapshot();
    await Promise.resolve();

    expect(calls).toEqual({ save: 0, load: 0, delete: 0 });
    // The store still has the game as it was when it was saved.
    expect(unwrap(await loadSession(store, 'g1')).getState().currentRound).toBe(1);
    expect(session.getState().currentRound).toBe(2);
  });

  it('playing a loaded session calls no store either', async () => {
    const { store, calls } = counting();
    await saveSession(store, running());
    const loaded = unwrap(await loadSession(store, 'g1'));
    calls.save = 0;
    calls.load = 0;

    playTag(loaded, START + 5_000);
    unwrap(loaded.advanceTime(at(START + ROUND_MS)));
    await Promise.resolve();

    expect(calls).toEqual({ save: 0, load: 0, delete: 0 });
  });

  it('loading does not save, and saving does not load', async () => {
    const { store, calls } = counting();
    await saveSession(store, running());
    expect(calls).toEqual({ save: 1, load: 0, delete: 0 });
    await loadSession(store, 'g1');
    expect(calls).toEqual({ save: 1, load: 1, delete: 0 });
  });
});

describe('the coordinator keeps nothing', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = join(directory, '..', '..');
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
    .map((name) => [name, readFileSync(join(directory, name), 'utf-8')] as const);
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('has no registry, singleton store, class or module-level state', () => {
    expect(sources.map(([name]) => name).sort()).toEqual(['index.ts', 'lifecycle.ts']);
    for (const [name, source] of sources) {
      const code = strip(source);
      expect(code, name).not.toMatch(
        /new Map|new Set|new WeakMap|\bclass\b|\blet\b|\bvar\b|InMemorySessionStore/,
      );
      expect(code, name).not.toMatch(
        /setTimeout|setInterval|setImmediate|queueMicrotask|node:fs|fetch\(|mongo|redis|retry|process\.env/i,
      );
    }
  });

  it('gives every loaded session to its caller and remembers none of them', async () => {
    const store = new InMemorySessionStore();
    await saveSession(store, running());
    const first = unwrap(await loadSession(store, 'g1'));
    const second = unwrap(await loadSession(store, 'g1'));

    // Two loads are two independent sessions, not one shared object.
    expect(first).not.toBe(second);
    playTag(first, START + 5_000);
    expect(second.getState()).not.toEqual(first.getState());
  });

  it('takes the store as an argument every time', () => {
    expect(loadSession.length).toBe(2);
    expect(saveSession.length).toBe(2);
    expect(deleteSession.length).toBe(2);
  });

  it('depends on the session, the store interface and shared helpers only', () => {
    const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@touchgrass/game-session',
      '@touchgrass/session-store',
      '@touchgrass/shared',
    ]);
    expect(manifest.devDependencies).toBeUndefined();
    for (const [name, source] of sources) {
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const imported = match[1] ?? '';
        expect(
          imported.startsWith('./') || Object.keys(manifest.dependencies).includes(imported),
          `${name} imports ${imported}`,
        ).toBe(true);
      }
    }
  });

  it('is not known to the engine, the session, the store, the transport, the AI or safety', () => {
    // The server package is the application layer that calls these functions.
    // No other package depends on this one.
    const callers = readdirSync(root).filter((name) =>
      readFileSync(join(root, name, 'package.json'), 'utf-8').includes(
        '"@touchgrass/session-persistence": ',
      ),
    );
    expect(callers).toEqual(['server']);
    // Neither the session nor the realtime layer mentions a store at all.
    for (const other of ['game-session', 'realtime', 'game-engine']) {
      const manifest = readFileSync(join(root, other, 'package.json'), 'utf-8');
      expect(manifest, other).not.toMatch(/session-store|session-persistence/);
      const directoryOf = join(root, other, 'src');
      for (const name of readdirSync(directoryOf).filter((file) => file.endsWith('.ts'))) {
        const source = readFileSync(join(directoryOf, name), 'utf-8');
        expect(source, `${other}/${name}`).not.toMatch(
          /session-store|session-persistence|SessionStore|saveSession|loadSession/,
        );
      }
    }
  });
});
