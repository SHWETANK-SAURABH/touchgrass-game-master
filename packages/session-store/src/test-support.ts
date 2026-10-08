import { BSON } from 'mongodb';
import {
  type GameSession,
  type GameSessionSnapshot,
  createGameSession,
} from '@touchgrass/game-session';
import type { SessionCollection, SessionDocument } from './mongodb';

/**
 * Helpers for the store tests. Not exported from the package.
 */

export const T0 = 1_700_000_000_000;

/** The time context a session expects, built by hand: this package does not use the engine. */
export const at = (ms: number) => ({
  now: T0 + ms,
  nextEntryId: (sequence: number) => `entry-${sequence}`,
});

export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

/** A lobby with two players, or a running game if `ready` is set. */
export function session(
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

export const snapshotOf = (
  sessionId: string,
  options?: { ready?: boolean; gameId?: string },
): GameSessionSnapshot => session(sessionId, options).snapshot();

/** Player ids a database might treat specially: dots, and a leading dollar sign. */
export const AWKWARD_PLAYER_IDS = ['player.one', '$player', 'a.b.c', '$set'] as const;

/**
 * A running game whose session id and player ids contain dots and dollar
 * signs. Ids are arbitrary non-empty strings, and once roles are assigned the
 * history holds a record keyed by player id, so these become object keys.
 */
export function awkwardSnapshot(sessionId = 'game.one$'): GameSessionSnapshot {
  const created = unwrap(
    createGameSession(
      { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
      at(0),
    ),
  );
  for (const playerId of AWKWARD_PLAYER_IDS) {
    unwrap(created.applyCommand({ type: 'ADD_PLAYER', playerId, displayName: playerId }, at(0)));
  }
  for (const playerId of AWKWARD_PLAYER_IDS) {
    unwrap(created.submitAction(playerId, { type: 'PLAYER_READY' }, at(1_000)));
  }
  return created.snapshot();
}

/** A snapshot as plain writable data, for tests that change one. */
export interface WritableSnapshot {
  version: number;
  sessionId: string;
  state: {
    status: string;
    players: { score: number; displayName: string }[];
    history: unknown[];
  };
}

export const writable = (snapshot: GameSessionSnapshot): WritableSnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as WritableSnapshot;

/**
 * A stand-in for a MongoDB collection that keeps each document as BSON bytes.
 *
 * It is not a mock of the driver. It holds documents the way the server does:
 * serialised with the driver's own BSON library on the way in and deserialised
 * on the way out, so numbers, nesting and key order go through the same
 * conversion a real collection would give them.
 */
export function bsonCollection() {
  const documents = new Map<string, Uint8Array>();
  const calls = { replace: 0, find: 0, remove: 0, close: 0 };
  let failure: unknown;

  const check = (): void => {
    // Thrown, not returned, like a driver error. A test may make it throw
    // something that is not an Error, to check that too is contained.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (failure !== undefined) throw failure;
  };

  const collection: SessionCollection = {
    replace(document) {
      calls.replace += 1;
      check();
      documents.set(document._id, BSON.serialize(document));
      return Promise.resolve();
    },
    find(sessionId) {
      calls.find += 1;
      check();
      const bytes = documents.get(sessionId);
      return Promise.resolve(bytes ? (BSON.deserialize(bytes) as SessionDocument) : null);
    },
    remove(sessionId) {
      calls.remove += 1;
      check();
      documents.delete(sessionId);
      return Promise.resolve();
    },
    close() {
      calls.close += 1;
      return Promise.resolve();
    },
  };

  return {
    collection,
    calls,
    /** Every stored document, decoded. */
    stored: (): Record<string, unknown>[] =>
      [...documents.values()].map((bytes) => BSON.deserialize(bytes)),
    /** Writes a document directly, bypassing the store. */
    put(document: Record<string, unknown> & { _id: string }): void {
      documents.set(document._id, BSON.serialize(document));
    },
    /** Makes every later operation throw this. */
    failWith(error: unknown): void {
      failure = error;
    },
    recover(): void {
      failure = undefined;
    },
  };
}
