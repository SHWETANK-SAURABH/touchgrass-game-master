import { MongoClient } from 'mongodb';
import { afterAll, describe, expect, it } from 'vitest';
import { describeSessionStore } from './conformance';
import { type MongoSessionStore, createMongoSessionStore } from './mongodb';
import { snapshotOf, unwrap } from './test-support';

/**
 * The SessionStore contract against a real MongoDB server.
 *
 * Opt-in. It runs only when MONGODB_TEST_URI is set, for example:
 *
 *   MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Without it every test here is skipped, so the normal test run needs no
 * database. It uses a database of its own with a random name and drops it when
 * it finishes; it touches no other database on the server.
 */

const uri = process.env.MONGODB_TEST_URI;
const databaseName = `touchgrass_test_${Math.random().toString(36).slice(2, 10)}`;
let collections = 0;

/** A store on a fresh, empty collection. */
function openStore(): MongoSessionStore {
  collections += 1;
  return createMongoSessionStore({
    uri: uri ?? '',
    databaseName,
    collectionName: `sessions_${collections}`,
  });
}

describe.skipIf(!uri)('MongoSessionStore against a real MongoDB server', () => {
  afterAll(async () => {
    const client = new MongoClient(uri ?? '');
    try {
      await client.db(databaseName).dropDatabase();
    } finally {
      await client.close();
    }
  });

  describeSessionStore('MongoSessionStore on MongoDB', openStore, (store) =>
    (store as MongoSessionStore).close(),
  );

  it('stores one document per session, keyed by the session id', async () => {
    const collectionName = 'sessions_shape';
    const store = createMongoSessionStore({ uri: uri ?? '', databaseName, collectionName });
    const snapshot = snapshotOf('g1', { ready: true });
    await store.save(snapshot);
    await store.save(snapshot);

    const client = new MongoClient(uri ?? '');
    try {
      const collection = client.db(databaseName).collection<{ _id: string }>(collectionName);
      const documents = await collection.find({}).toArray();
      expect(documents).toHaveLength(1);
      expect(Object.keys(documents[0] ?? {}).sort()).toEqual(['_id', 'state', 'version']);
      expect(documents[0]?._id).toBe('g1');
      // Nothing but the automatic _id index.
      const indexes = await collection.indexes();
      expect(indexes.map((index) => index.name)).toEqual(['_id_']);
    } finally {
      await client.close();
      await store.close();
    }
  });

  it('survives the store being closed and a new one opened on the same collection', async () => {
    const collectionName = 'sessions_reopen';
    const first = createMongoSessionStore({ uri: uri ?? '', databaseName, collectionName });
    const snapshot = snapshotOf('g1', { ready: true });
    await first.save(snapshot);
    await first.close();
    expect((await first.load('g1')).ok).toBe(false);

    const second = createMongoSessionStore({ uri: uri ?? '', databaseName, collectionName });
    try {
      expect(unwrap(await second.load('g1'))).toEqual(snapshot);
    } finally {
      await second.close();
    }
  });
});
