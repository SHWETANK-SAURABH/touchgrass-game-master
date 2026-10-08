import { afterAll, describe, expect, it } from 'vitest';
import { type MongoSessionStore, createMongoSessionStore } from '@touchgrass/session-store/mongodb';
import { parseServerConfig } from './config';
import { startPersistentServer } from './persistent-server';
import {
  CODE,
  START,
  connection,
  createCommand,
  join,
  send,
  testClock,
  unwrap,
} from './test-support';

/**
 * The persistent server against a real MongoDB server.
 *
 * Opt-in. It runs only when MONGODB_TEST_URI is set, for example:
 *
 *   MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Without it every test here is skipped. It uses a database of its own with a
 * random name and drops it when it finishes.
 */

const uri = process.env.MONGODB_TEST_URI;
const databaseName = `touchgrass_test_${Math.random().toString(36).slice(2, 10)}`;

/** A store built the way the application builds one: from parsed configuration. */
function openStore(): MongoSessionStore {
  const config = unwrap(
    parseServerConfig({
      MONGODB_URI: uri,
      MONGODB_DATABASE: databaseName,
      MONGODB_COLLECTION: 'games',
    }),
  );
  return createMongoSessionStore(config.mongo);
}

describe.skipIf(!uri)('the persistent server on a real MongoDB server', () => {
  afterAll(async () => {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri ?? '');
    try {
      await client.db(databaseName).dropDatabase();
    } finally {
      await client.close();
    }
  });

  it('creates a game, saves it when asked, and brings it back on a new server', async () => {
    const clock = testClock();
    const first = unwrap(
      await startPersistentServer({
        store: openStore(),
        port: 0,
        clock,
        game: { create: createCommand('live') },
      }),
    );

    // Play over the room.
    const players = [connection(), connection(), connection()];
    const joined = players.map((who, index) => join(first.room, who, `Player ${index}`));
    for (const who of players) {
      send(first.room, who, { type: 'action', intent: { type: 'PLAYER_READY' } }, START);
    }
    expect(first.session.getState().status).toBe('active');

    // Nothing of that play was saved: the database still has the empty lobby.
    const reader = openStore();
    expect(unwrap(await reader.load('live'))?.state.status).toBe('lobby');

    // An explicit save.
    expect(await first.save()).toEqual({ ok: true, value: undefined });
    expect(unwrap(await reader.load('live'))).toEqual(first.session.snapshot());
    await reader.close();

    const saved = structuredClone(first.session.getState());
    const oldHostToken = first.hostToken;
    await first.close();
    // Its store was closed with it.
    expect((await first.save()).ok).toBe(false);

    // A new server, a new store, the same database.
    const second = unwrap(
      await startPersistentServer({ store: openStore(), port: 0, clock, game: { load: 'live' } }),
    );
    try {
      expect(second.session.id).toBe('live');
      expect(second.session.getState()).toEqual(saved);
      expect(second.session.getState().history).toEqual(saved.history);

      // A new room: no connections, and no token from before works.
      expect(second.room.connectionCount()).toBe(0);
      const returning = connection();
      send(second.room, returning, { type: 'resume', token: joined[0]?.token }, START + 5_000);
      send(second.room, returning, { type: 'host_auth', token: oldHostToken }, START + 5_000);
      expect(returning.take()).toEqual([
        { type: 'error', code: 'INVALID_TOKEN' },
        { type: 'error', code: 'INVALID_TOKEN' },
      ]);

      // The restored game plays on, under the new host token.
      const host = connection();
      send(second.room, host, { type: 'host_auth', token: second.hostToken }, START + 5_000);
      send(
        second.room,
        host,
        { type: 'host_command', command: { type: 'PAUSE_SESSION', reason: 'water' } },
        START + 6_000,
      );
      expect(second.session.getState().status).toBe('paused');
      expect((await second.save()).ok).toBe(true);
    } finally {
      await second.close();
    }

    // And the pause is what a third reader finds.
    const last = openStore();
    try {
      expect(unwrap(await last.load('live'))?.state.status).toBe('paused');
      expect(JSON.stringify(unwrap(await last.load('live')))).not.toMatch(
        /token|socket|connection/i,
      );
    } finally {
      await last.close();
    }
  });

  it('refuses to create over a stored game, and reports one that is not stored', async () => {
    const store = openStore();
    try {
      const first = unwrap(
        await startPersistentServer({ store, port: 0, game: { create: createCommand('once') } }),
      );
      const again = await startPersistentServer({
        store,
        port: 0,
        game: { create: createCommand('once') },
      });
      expect(!again.ok && again.error.code).toBe('SESSION_ALREADY_EXISTS');
      const missing = await startPersistentServer({ store, port: 0, game: { load: 'nobody' } });
      expect(!missing.ok && missing.error.code).toBe('SESSION_NOT_FOUND');
      expect(first.session.getState().joinCode).toBe(CODE);
      await first.close();
    } finally {
      await store.close();
    }
  });
});
