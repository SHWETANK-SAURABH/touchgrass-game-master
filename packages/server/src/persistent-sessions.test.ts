import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore, type SessionStore } from '@touchgrass/session-store';
import { createPersistentSessions } from './persistent-sessions';
import {
  ROUND_MS,
  START,
  at,
  codeOf,
  countingStore,
  createCommand,
  failingStore,
  playTag,
  start,
  unwrap,
} from './test-support';

describe('create', () => {
  it('creates a game and saves its first snapshot', async () => {
    const { store, calls, saved } = countingStore();
    const sessions = createPersistentSessions(store);

    const session = unwrap(await sessions.create(createCommand(), at(0)));

    expect(session.id).toBe('g1');
    expect(session.getState()).toMatchObject({ status: 'lobby', gameId: 'tag', players: [] });
    // Saved exactly once, and what was saved is the session's own snapshot.
    expect(calls.save).toBe(1);
    expect(saved[0]).toEqual(session.snapshot());
  });

  it('can be loaded straight back: same id, state and history', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    const created = unwrap(await sessions.create(createCommand(), at(0)));
    const loaded = unwrap(await sessions.load('g1'));

    expect(loaded.id).toBe(created.id);
    expect(loaded.getState()).toEqual(created.getState());
    expect(loaded.getState().history).toEqual(created.getState().history);
    expect(loaded).not.toBe(created);
  });

  it('reports the failure when the first save fails, and returns no session', async () => {
    const { store, calls } = failingStore();
    const sessions = createPersistentSessions(store);

    const result = await sessions.create(createCommand(), at(0));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The database is away.' },
    });
    expect(Object.keys(result)).not.toContain('value');
    // One attempt to save. No retry, then or later.
    expect(calls.save).toBe(1);
    await Promise.resolve();
    expect(calls.save).toBe(1);
  });

  it('keeps no trace of a session whose save failed', async () => {
    vi.useFakeTimers();
    try {
      const { store, calls } = failingStore();
      const sessions = createPersistentSessions(store);
      await sessions.create(createCommand(), at(0));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(vi.getTimerCount()).toBe(0);
      expect(calls.save).toBe(1);
      // Nothing remembers it: asking again goes to the store, which has nothing.
      expect(codeOf(await sessions.load('g1'))).toBe('SESSION_NOT_FOUND');
      expect(Object.keys(sessions).sort()).toEqual(['create', 'delete', 'load', 'save']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a store that cannot be read, without trying to save', async () => {
    const { store, calls } = failingStore({ load: 'fail' });
    const result = await createPersistentSessions(store).create(createCommand(), at(0));
    expect(codeOf(result)).toBe('STORAGE_ERROR');
    expect(calls.save).toBe(0);
  });

  it('refuses a game that cannot be created, and touches the store for nothing', async () => {
    const { store, calls } = countingStore();
    const sessions = createPersistentSessions(store);

    for (const command of [
      createCommand('g1', 'quidditch'),
      { ...createCommand(), sessionId: '' },
      { ...createCommand(), state: { status: 'active' } },
      { type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Ada' },
      null,
    ]) {
      const result = await sessions.create(command, at(0));
      expect(codeOf(result)).toBe('SESSION_NOT_CREATED');
      if (!result.ok && result.error.code === 'SESSION_NOT_CREATED') {
        expect(result.error.cause.code).toBe('INVALID_GAME_CONFIGURATION');
      }
    }
    expect(calls).toMatchObject({ save: 0, load: 0, delete: 0 });
  });

  it('refuses an id that is already stored, and leaves the stored game as it is', async () => {
    const { store, calls } = countingStore();
    const sessions = createPersistentSessions(store);
    const first = unwrap(await sessions.create(createCommand(), at(0)));
    start(first);
    await sessions.save(first);
    calls.save = 0;

    const second = await sessions.create(createCommand(), at(5_000));

    expect(second).toEqual({
      ok: false,
      error: { code: 'SESSION_ALREADY_EXISTS', message: 'A session "g1" is already stored.' },
    });
    expect(calls.save).toBe(0);
    expect(unwrap(await sessions.load('g1')).getState()).toEqual(first.getState());
  });

  it('does not overwrite a stored snapshot it cannot read, either', async () => {
    const inner = new InMemorySessionStore();
    await inner.save({ version: 1, sessionId: 'g1', state: { broken: true } } as never);
    const { store, calls } = countingStore(inner);

    const result = await createPersistentSessions(store).create(createCommand(), at(0));

    expect(codeOf(result)).toBe('SESSION_ALREADY_EXISTS');
    expect(calls.save).toBe(0);
  });
});

describe('load', () => {
  it('gives a live session that carries on playing', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    const created = unwrap(await sessions.create(createCommand(), at(0)));
    start(created);
    await sessions.save(created);

    const loaded = unwrap(await sessions.load('g1'));
    playTag(loaded, START + 5_000);
    unwrap(loaded.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(START + 6_000)));
    unwrap(loaded.applyCommand({ type: 'RESUME_SESSION' }, at(START + 7_000)));
    unwrap(loaded.advanceTime(at(START + 3 * ROUND_MS + 1_000)));

    expect(loaded.getState().status).toBe('completed');
    expect(created.getState().status).toBe('active');
  });

  it('restores the game exactly as saved: nothing is advanced, paused or reset', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    const created = unwrap(await sessions.create(createCommand(), at(0)));
    start(created);
    playTag(created, START + 5_000);
    await sessions.save(created);
    const saved = structuredClone(created.getState());

    // Loaded as if much later. Loading takes no clock, so it cannot know.
    const loaded = unwrap(await sessions.load('g1'));

    expect(loaded.getState()).toEqual(saved);
    expect(loaded.getState()).toMatchObject({ status: 'active', currentRound: 1 });
    expect(loaded.getState().timer).toEqual(saved.timer);
    expect(loaded.getState().players.map((player) => [player.roleId, player.score])).toEqual(
      saved.players.map((player) => [player.roleId, player.score]),
    );
    expect(sessions.load.length).toBe(1);
  });

  it('reports a session that is not stored, and creates nothing', async () => {
    const { store, calls } = countingStore();
    const result = await createPersistentSessions(store).load('nobody');
    expect(result).toEqual({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'No saved session "nobody".' },
    });
    expect(Object.keys(result)).not.toContain('value');
    expect(calls).toMatchObject({ save: 0, load: 1 });
  });

  it('reports a stored snapshot that cannot be restored, and leaves it in the store', async () => {
    const inner = new InMemorySessionStore();
    const good = unwrap(await createPersistentSessions(inner).create(createCommand(), at(0)));
    const damaged = JSON.parse(JSON.stringify(good.snapshot())) as { state: { status: string } };
    damaged.state.status = 'frozen';
    await inner.save(damaged as never);
    const before = JSON.stringify(unwrap(await inner.load('g1')));
    const { store, calls } = countingStore(inner);

    const result = await createPersistentSessions(store).load('g1');

    expect(codeOf(result)).toBe('INVALID_SNAPSHOT');
    expect(!result.ok && result.error.cause?.code).toBe('INVALID_GAME_STATE');
    expect(Object.keys(result)).not.toContain('value');
    expect(calls).toMatchObject({ save: 0, load: 1, delete: 0 });
    expect(JSON.stringify(unwrap(await inner.load('g1')))).toBe(before);
  });

  it('reports an invalid id and a store failure as themselves', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    expect(codeOf(await sessions.load(''))).toBe('INVALID_SESSION_ID');
    expect(
      codeOf(await createPersistentSessions(failingStore({ load: 'fail' }).store).load('g1')),
    ).toBe('STORAGE_ERROR');
  });
});

describe('save', () => {
  it('saves the game as it is when asked, and not before', async () => {
    const { store, calls } = countingStore();
    const sessions = createPersistentSessions(store);
    const session = unwrap(await sessions.create(createCommand(), at(0)));
    calls.save = 0;

    start(session);
    playTag(session, START + 5_000);
    expect(calls.save).toBe(0);
    expect(unwrap(await sessions.load('g1')).getState().status).toBe('lobby');

    expect(await sessions.save(session)).toEqual({ ok: true, value: undefined });
    const atSave = structuredClone(session.getState());
    expect(calls.save).toBe(1);

    playTag(session, START + 6_000);
    expect(unwrap(await sessions.load('g1')).getState()).toEqual(atSave);
    expect(calls.save).toBe(1);
  });

  it('reports a failed save, and leaves the running game changed and usable', async () => {
    const good = new InMemorySessionStore();
    const session = unwrap(await createPersistentSessions(good).create(createCommand(), at(0)));
    start(session);
    const before = session.getState();
    const { store, calls } = failingStore();

    const result = await createPersistentSessions(store).save(session);

    expect(codeOf(result)).toBe('STORAGE_ERROR');
    expect(calls.save).toBe(1);
    expect(session.getState()).toBe(before);
    playTag(session, START + 5_000);
    expect(session.getState().status).toBe('active');
    expect(calls.save).toBe(1);
    // The store still has the game as it was first saved.
    expect(unwrap(await createPersistentSessions(good).load('g1')).getState().status).toBe('lobby');
  });

  it('takes a session, not a state', async () => {
    const { store, calls } = countingStore();
    const sessions = createPersistentSessions(store);
    const session = unwrap(await sessions.create(createCommand(), at(0)));
    calls.save = 0;
    expect(codeOf(await sessions.save(session.getState() as never))).toBe('INVALID_SNAPSHOT');
    expect(codeOf(await sessions.save(session.snapshot() as never))).toBe('INVALID_SNAPSHOT');
    expect(calls.save).toBe(0);
  });
});

describe('delete', () => {
  it('removes the stored game and leaves a running one alone', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    const session = unwrap(await sessions.create(createCommand(), at(0)));
    start(session);
    await sessions.save(session);
    const before = session.getState();

    expect(await sessions.delete('g1')).toEqual({ ok: true, value: undefined });

    expect(codeOf(await sessions.load('g1'))).toBe('SESSION_NOT_FOUND');
    expect(session.getState()).toBe(before);
    expect(session.getState().status).toBe('active');
    playTag(session, START + 5_000);
    // It can be saved again, and created again under the same id.
    await sessions.save(session);
    expect(unwrap(await sessions.load('g1')).getState()).toEqual(session.getState());
  });

  it('succeeds for a session that is not stored', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    expect((await sessions.delete('nobody')).ok).toBe(true);
    expect(codeOf(await sessions.delete(''))).toBe('INVALID_SESSION_ID');
  });
});

describe('the application layer keeps no module-level state and no storage of its own', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = joinPath(directory, '..', '..');
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('test'))
    .map((name) => [name, readFileSync(joinPath(directory, name), 'utf-8')] as const);
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('gives two loads of one id two separate sessions', async () => {
    const sessions = createPersistentSessions(new InMemorySessionStore());
    const created = unwrap(await sessions.create(createCommand(), at(0)));
    start(created);
    await sessions.save(created);
    const first = unwrap(await sessions.load('g1'));
    const second = unwrap(await sessions.load('g1'));
    expect(first).not.toBe(second);
    playTag(first, START + 5_000);
    expect(second.getState()).not.toEqual(first.getState());
  });

  it('holds only the store it was given: each service is independent', async () => {
    const one = createPersistentSessions(new InMemorySessionStore());
    const two = createPersistentSessions(new InMemorySessionStore());
    await one.create(createCommand(), at(0));
    expect(codeOf(await two.load('g1'))).toBe('SESSION_NOT_FOUND');
  });

  it('has no map of sessions, rooms or stores, no singleton and no timer', () => {
    expect(sources.map(([name]) => name).sort()).toEqual([
      'config.ts',
      'dev-sessions.ts',
      'dev.ts',
      'index.ts',
      'persistent-server.ts',
      'persistent-sessions.ts',
      'player-tokens.ts',
      'session-handle.ts',
      'session-registry.ts',
      'session-server.ts',
    ]);
    for (const [name, source] of sources) {
      const code = strip(source);
      expect(code, name).not.toMatch(/new Set|new WeakMap|\bclass\b|setTimeout/);
      // One timer exists: the multi-session development server's sweep, which
      // only asks the registry to look. Nothing in the library has a timer.
      expect(code.match(/setInterval/g) ?? [], name).toHaveLength(
        name === 'dev-sessions.ts' ? 1 : 0,
      );
      // One table exists: the registry's own, made inside each registry.
      const tables = code.split('\n').filter((line) => line.includes('new Map'));
      expect(tables, name).toEqual(
        name === 'session-registry.ts' ? ['  const entries = new Map<string, Entry>();'] : [],
      );
      expect(code, name).not.toMatch(/retry|redis|jsonwebtoken|\bjwt\b|autosave/i);
      if (name === 'dev.ts' || name === 'dev-sessions.ts') continue;
      // Outside the development entry point there is no module-level state at all.
      const topLevel = code
        .split('\n')
        .filter(
          (line) =>
            /^(export )?(let|var)\s/.test(line) ||
            /^(export )?const \w+ = (new |create)/.test(line),
        );
      expect(topLevel, name).toEqual([]);
    }
  });

  it('reaches the database only through the store and the lifecycle functions', () => {
    for (const [name, source] of sources) {
      const code = strip(source);
      expect(code, name).not.toMatch(/from 'mongodb'|MongoClient|replaceOne|findOne|deleteOne/);
      expect(code, name).not.toMatch(
        /\.snapshot\(\)|restoreGameSession|store\.(save|load|delete)\(/,
      );
    }
    // Only the development entry point makes a MongoDB store, from configuration.
    const makers = sources.filter(([, source]) => /createMongoSessionStore/.test(source));
    expect(makers.map(([name]) => name)).toEqual(['dev-sessions.ts', 'dev.ts']);
  });

  it('is the only package that puts the store, the lifecycle and the transport together', () => {
    for (const other of readdirSync(root).filter((name) => name !== 'server')) {
      const manifest = readFileSync(joinPath(root, other, 'package.json'), 'utf-8');
      expect(manifest, other).not.toContain('@touchgrass/server');
    }
    // The transport and the session still know nothing of persistence.
    for (const other of ['realtime', 'game-session', 'game-engine']) {
      const manifest = readFileSync(joinPath(root, other, 'package.json'), 'utf-8');
      expect(manifest, other).not.toMatch(/session-store|session-persistence|mongodb/);
      const folder = joinPath(root, other, 'src');
      for (const name of readdirSync(folder).filter((file) => file.endsWith('.ts'))) {
        expect(readFileSync(joinPath(folder, name), 'utf-8'), `${other}/${name}`).not.toMatch(
          /SessionStore|saveSession|loadSession|session-persistence/,
        );
      }
    }
  });

  it('works with any store through the interface', async () => {
    const store: SessionStore = new InMemorySessionStore();
    const sessions = createPersistentSessions(store);
    expect((await sessions.create(createCommand(), at(0))).ok).toBe(true);
  });
});
