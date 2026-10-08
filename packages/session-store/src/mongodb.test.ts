import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_COLLECTION,
  MongoSessionStore,
  type SessionCollection,
  createMongoSessionStore,
} from './mongodb';
import type { SessionStore } from './store';
import {
  AWKWARD_PLAYER_IDS,
  awkwardSnapshot,
  bsonCollection,
  session,
  snapshotOf,
  unwrap,
  writable,
} from './test-support';

/** A store over a BSON-backed collection, with the collection exposed for inspection. */
function fixture() {
  const backing = bsonCollection();
  let opened = 0;
  const store = new MongoSessionStore(() => {
    opened += 1;
    return backing.collection;
  });
  return { store, backing, opened: () => opened };
}

describe('the document', () => {
  it('is one document per session, keyed by the session id', async () => {
    const { store, backing } = fixture();
    const snapshot = snapshotOf('g1', { ready: true });
    await store.save(snapshot);

    const [document] = backing.stored();
    expect(backing.stored()).toHaveLength(1);
    expect(Object.keys(document ?? {}).sort()).toEqual(['_id', 'state', 'version']);
    expect(document?._id).toBe('g1');
    expect(document?.version).toBe(1);
    expect(document?.state).toEqual(snapshot.state);
    // The id is stored once, as the key. There is no second copy beside it.
    expect(document).not.toHaveProperty('sessionId');
  });

  it('stays one document when the same session is saved again', async () => {
    const { store, backing } = fixture();
    const game = session('g1');
    await store.save(game.snapshot());
    unwrap(
      game.submitAction(
        'p0',
        { type: 'PLAYER_READY' },
        { now: 1_700_000_001_000, nextEntryId: (n) => `entry-${n}` },
      ),
    );
    await store.save(game.snapshot());
    await store.save(game.snapshot());

    expect(backing.stored()).toHaveLength(1);
    expect(backing.calls.replace).toBe(3);
    expect(backing.stored()[0]?.state).toEqual(game.getState());
  });

  it('keeps separate sessions in separate documents', async () => {
    const { store, backing } = fixture();
    await store.save(snapshotOf('a'));
    await store.save(snapshotOf('b'));
    expect(
      backing
        .stored()
        .map((document) => document._id)
        .sort(),
    ).toEqual(['a', 'b']);
    await store.delete('a');
    expect(backing.stored().map((document) => document._id)).toEqual(['b']);
  });

  it('stores keys with dots and dollar signs verbatim, without escaping them', async () => {
    const { store, backing } = fixture();
    const snapshot = awkwardSnapshot();
    await store.save(snapshot);

    const [document] = backing.stored() as { _id: string; state: typeof snapshot.state }[];
    expect(document?._id).toBe('game.one$');
    const roles = document?.state.history.find((entry) => entry.record.kind === 'ROLES_ASSIGNED');
    expect(
      roles?.record.kind === 'ROLES_ASSIGNED' && Object.keys(roles.record.roles).sort(),
    ).toEqual([...AWKWARD_PLAYER_IDS].sort());
    expect(document?.state).toEqual(snapshot.state);
    // The adapter's source has no code that rewrites a key.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'mongodb.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(
      /\.replace\(\/|replaceAll|escape|encodeURIComponent|sanitis|sanitiz/i,
    );
  });

  it('turns the document back into a snapshot: sessionId returns and _id does not', async () => {
    const { store } = fixture();
    const snapshot = snapshotOf('g1', { ready: true });
    await store.save(snapshot);
    const loaded = unwrap(await store.load('g1'));

    expect(Object.keys(loaded ?? {}).sort()).toEqual(['sessionId', 'state', 'version']);
    expect(loaded).not.toHaveProperty('_id');
    expect(loaded?.sessionId).toBe('g1');
    expect(loaded).toEqual(snapshot);
  });

  it('stores only the snapshot: nothing of a transport, and no extra fields of the caller', async () => {
    const { store, backing } = fixture();
    const snapshot = {
      ...writable(snapshotOf('g1', { ready: true })),
      hostToken: 'secret-host',
      tokens: { p0: 'secret-player' },
    };
    await store.save(snapshot as never);

    const text = JSON.stringify(backing.stored());
    expect(text).not.toMatch(/secret|token|socket|connection|room/i);
    expect(Object.keys(backing.stored()[0] ?? {}).sort()).toEqual(['_id', 'state', 'version']);
    expect(Object.keys(unwrap(await store.load('g1')) ?? {}).sort()).toEqual([
      'sessionId',
      'state',
      'version',
    ]);
  });

  it('does not write `undefined` into the database as null', async () => {
    // A snapshot from a session has no undefined values. If a caller's object
    // does, it is dropped, as JSON drops it, rather than stored as null and
    // read back as a field that was never there.
    const { store, backing } = fixture();
    const snapshot = writable(snapshotOf('g1')) as unknown as { state: Record<string, unknown> };
    snapshot.state.extra = undefined;
    await store.save(snapshot as never);
    expect(backing.stored()[0]?.state).not.toHaveProperty('extra');
    expect(unwrap(await store.load('g1'))?.state).not.toHaveProperty('extra');
  });

  it('reads back plain data even from a document it did not write', async () => {
    const { store, backing } = fixture();
    const snapshot = snapshotOf('g1');
    backing.put({ _id: 'g1', version: 1, state: snapshot.state, writtenBy: 'someone else' });
    const loaded = unwrap(await store.load('g1'));
    expect(loaded).toEqual(snapshot);
    expect(Object.isFrozen(loaded)).toBe(true);
  });
});

describe('errors', () => {
  class FakeDriverError extends Error {
    override name = 'MongoServerSelectionError';
    code = 11000;
    errorLabels = ['RetryableWriteError'];
    connectionString = 'mongodb://example-host.invalid:27017/?appName=LEAK_MARKER';
  }
  const driverError = () =>
    new FakeDriverError('connect ECONNREFUSED example-host.invalid:27017 (appName=LEAK_MARKER)');

  it('turns a driver failure into STORAGE_ERROR with a fixed message, for each operation', async () => {
    const { store, backing } = fixture();
    await store.save(snapshotOf('g1'));
    backing.failWith(driverError());

    expect(await store.save(snapshotOf('g1'))).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be saved.' },
    });
    expect(await store.load('g1')).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be loaded.' },
    });
    expect(await store.delete('g1')).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be deleted.' },
    });
  });

  it('lets nothing of the driver error out: no name, stack, host or credentials', async () => {
    const { store, backing } = fixture();
    backing.failWith(driverError());
    for (const result of [
      await store.save(snapshotOf('g1')),
      await store.load('g1'),
      await store.delete('g1'),
    ]) {
      if (result.ok) throw new Error('expected a failure');
      expect(Object.keys(result.error).sort()).toEqual(['code', 'message']);
      expect(result.error).not.toBeInstanceOf(Error);
      expect(JSON.stringify(result.error)).not.toMatch(
        /mongo|ECONNREFUSED|LEAK_MARKER|example-host|27017|stack|11000|Retryable/i,
      );
    }
  });

  it.each([
    ['a thrown string', 'boom'],
    ['a thrown object', { code: 'ESOCKET' }],
    ['null', null],
    ['a TypeError', new TypeError('x is not a function')],
  ])('never rejects, whatever is thrown underneath: %s', async (_label, thrown) => {
    const { store, backing } = fixture();
    backing.failWith(thrown ?? new Error('null cannot be thrown usefully'));
    await expect(store.save(snapshotOf('g1'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR' },
    });
    await expect(store.load('g1')).resolves.toMatchObject({ ok: false });
    await expect(store.delete('g1')).resolves.toMatchObject({ ok: false });
  });

  it('attempts an operation once: no retry, then or later', async () => {
    vi.useFakeTimers();
    try {
      const { store, backing } = fixture();
      backing.failWith(driverError());
      await store.save(snapshotOf('g1'));
      await store.load('g1');
      await store.delete('g1');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(backing.calls).toMatchObject({ replace: 1, find: 1, remove: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails with STORAGE_ERROR, changing nothing, if the database refuses a document', async () => {
    // A server that does not accept such field names rejects the write. The
    // adapter must report that, not rename the keys to get the write through.
    const backing = bsonCollection();
    const refusing: SessionCollection = {
      ...backing.collection,
      replace(document) {
        if (/"\$player"|"player\.one"/.test(JSON.stringify(document))) {
          return Promise.reject(new Error("FieldPath field names may not start with '$'."));
        }
        return backing.collection.replace(document);
      },
    };
    const store = new MongoSessionStore(() => refusing);
    const earlier = snapshotOf('game.one$');
    await store.save(earlier);

    const result = await store.save(awkwardSnapshot('game.one$'));

    expect(result).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be saved.' },
    });
    // Nothing was written in its place, altered or otherwise.
    expect(backing.stored()).toHaveLength(1);
    expect(unwrap(await store.load('game.one$'))).toEqual(earlier);
  });

  it('works again once the database does, with what was stored before still there', async () => {
    const { store, backing } = fixture();
    const snapshot = snapshotOf('g1');
    await store.save(snapshot);
    backing.failWith(driverError());
    expect((await store.save(snapshotOf('g1', { ready: true }))).ok).toBe(false);
    backing.recover();
    expect(unwrap(await store.load('g1'))).toEqual(snapshot);
  });

  it('does not ask the database about an invalid session id', async () => {
    const { store, backing, opened } = fixture();
    await store.load('');
    await store.delete(null as never);
    await store.save({ sessionId: '' } as never);
    expect(backing.calls).toMatchObject({ replace: 0, find: 0, remove: 0 });
    expect(opened()).toBe(0);
  });

  it('reports a collection that cannot be opened as STORAGE_ERROR', async () => {
    const store = new MongoSessionStore(() => {
      throw new Error('Invalid scheme, expected connection string to start with "mongodb://"');
    });
    expect(await store.load('g1')).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be loaded.' },
    });
  });
});

describe('connection lifecycle', () => {
  it('opens nothing until the first operation, and then only once', async () => {
    const { store, opened } = fixture();
    expect(opened()).toBe(0);
    await store.load('g1');
    await store.save(snapshotOf('g1'));
    await store.delete('g1');
    await store.load('g1');
    expect(opened()).toBe(1);
  });

  it('closes its collection, once', async () => {
    const { store, backing } = fixture();
    await store.load('g1');
    await store.close();
    await store.close();
    expect(backing.calls.close).toBe(1);
  });

  it('refuses every operation after it is closed, and does not reopen', async () => {
    const { store, backing, opened } = fixture();
    await store.save(snapshotOf('g1'));
    await store.close();

    const closed = {
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session store is closed.' },
    };
    expect(await store.save(snapshotOf('g1'))).toEqual(closed);
    expect(await store.load('g1')).toEqual(closed);
    expect(await store.delete('g1')).toEqual(closed);
    expect(opened()).toBe(1);
    expect(backing.calls).toMatchObject({ replace: 1, find: 0, remove: 0 });
  });

  it('can be closed without ever having connected', async () => {
    const { store, backing, opened } = fixture();
    await expect(store.close()).resolves.toBeUndefined();
    expect(opened()).toBe(0);
    expect(backing.calls.close).toBe(0);
  });

  it('does not throw if closing the connection fails', async () => {
    const collection: SessionCollection = {
      replace: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
      close: () => Promise.reject(new Error('socket already destroyed')),
    };
    const store = new MongoSessionStore(() => collection);
    await store.load('g1');
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('gives each store its own collection: two stores share nothing', async () => {
    const one = fixture();
    const two = fixture();
    await one.store.save(snapshotOf('g1'));
    expect(await two.store.load('g1')).toEqual({ ok: true, value: null });
    await one.store.close();
    expect((await two.store.save(snapshotOf('g2'))).ok).toBe(true);
    expect(two.backing.calls.close).toBe(0);
  });
});

describe('createMongoSessionStore', () => {
  it('makes a SessionStore without connecting to anything', async () => {
    // No server is listening here. Construction must not try to reach one.
    const store: SessionStore = createMongoSessionStore({
      uri: 'mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=200',
      databaseName: 'touchgrass_test',
    });
    expect(store).toBeInstanceOf(MongoSessionStore);
    await (store as MongoSessionStore).close();
  });

  it('does not fail on a connection string that is not one, until it is used', async () => {
    const store = createMongoSessionStore({ uri: 'not a connection string', databaseName: 'x' });
    const result = await store.load('g1');
    expect(result).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be loaded.' },
    });
    expect(JSON.stringify(result)).not.toContain('not a connection string');
    await store.close();
  });

  it('reports an unreachable server as STORAGE_ERROR, without the address', async () => {
    const store = createMongoSessionStore({
      uri: 'mongodb://127.0.0.1:9/?appName=LEAK_MARKER&serverSelectionTimeoutMS=200',
      databaseName: 'touchgrass_test',
    });
    const result = await store.save(snapshotOf('g1'));
    expect(result).toEqual({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'The session could not be saved.' },
    });
    expect(JSON.stringify(result)).not.toMatch(/LEAK_MARKER|127\.0\.0\.1|appName|mongodb:/);
    await store.close();
  });

  it('defaults the collection name', () => {
    expect(DEFAULT_SESSION_COLLECTION).toBe('sessions');
  });
});

describe('MongoDB stays in one file', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = join(directory, '..', '..');
  const source = (name: string): string => readFileSync(join(directory, name), 'utf-8');
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('is the only source file that imports the driver', () => {
    const importers = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.includes('test') && name !== 'conformance.ts')
      .filter((name) => /from 'mongodb'/.test(source(name)));
    expect(importers).toEqual(['mongodb.ts']);
  });

  it('is not reachable from the package’s main entry', () => {
    expect(source('index.ts')).not.toMatch(/mongodb|Mongo/);
    for (const name of ['store.ts', 'in-memory.ts']) {
      expect(source(name), name).not.toMatch(/mongodb|Mongo|BSON|ObjectId/);
    }
    const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf-8')) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './mongodb': './src/mongodb.ts' });
  });

  it('exposes no driver type in the store interface', () => {
    expect(strip(source('store.ts'))).not.toMatch(/Mongo|Collection|Document|ObjectId|Db\b/);
  });

  it('is a dependency of this package only', () => {
    for (const other of readdirSync(root).filter((name) => name !== 'session-store')) {
      const manifest = JSON.parse(readFileSync(join(root, other, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      expect(names, other).not.toContain('mongodb');
      expect(names, other).not.toContain('mongoose');
    }
  });

  it('is not imported by the session, the lifecycle, the transport or the web app', () => {
    const others = [
      ...['game-session', 'session-persistence', 'realtime', 'game-engine', 'shared'].map((name) =>
        join(root, name, 'src'),
      ),
    ];
    for (const folder of others) {
      for (const name of readdirSync(folder).filter((file) => file.endsWith('.ts'))) {
        const text = readFileSync(join(folder, name), 'utf-8');
        expect(text, `${folder}/${name}`).not.toMatch(
          /from '(mongodb|@touchgrass\/session-store\/mongodb)'/,
        );
      }
    }
  });

  it('keeps no client, registry or timer at module level, and reads no environment', () => {
    const code = strip(source('mongodb.ts'));
    expect(code).not.toMatch(
      /process\.env|setTimeout|setInterval|new Map|new Set|createIndex|transaction|startSession/i,
    );
    const topLevel = code
      .split('\n')
      .filter(
        (line) => /^(export )?(let|var)\s/.test(line) || /^(export )?const \w+ = new /.test(line),
      );
    expect(topLevel).toEqual([]);
    // One client per store, made inside the factory's open function.
    expect(code.match(/new MongoClient\(/g)).toHaveLength(1);
    expect(code).toContain('retryWrites: false');
    expect(code).toContain('retryReads: false');
  });
});
