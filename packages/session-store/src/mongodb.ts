import { MongoClient } from 'mongodb';
import { type Result, err, ok } from '@touchgrass/shared';
import type { GameSessionSnapshot } from '@touchgrass/game-session';
import {
  type SessionStore,
  type SessionStoreError,
  parseSessionId,
  sessionStoreError,
} from './store';

/**
 * A SessionStore that keeps snapshots in MongoDB.
 *
 * It is an adapter for the SessionStore interface and nothing more. It stores a
 * snapshot, gives one back, and deletes one. It does not create or restore a
 * GameSession, apply a game rule, or judge whether a snapshot is a valid game:
 * `restoreGameSession` does that when a snapshot becomes a session again.
 *
 * One session is one document:
 *
 *   { _id: <session id>, version: <snapshot version>, state: <GameState> }
 *
 * The session id is the document's `_id`, which MongoDB already indexes and
 * keeps unique, so there is nothing else to index and no second copy of the id.
 * `_id` never appears in what this store returns: a loaded snapshot has
 * `sessionId` again.
 *
 * Everything about MongoDB stays in this file. The interface it implements
 * names no driver type, and nothing the driver throws leaves here: every
 * failure becomes STORAGE_ERROR with a fixed message.
 *
 * This module is loaded only by code that asks for it, through the package's
 * `./mongodb` entry. Importing it connects to nothing.
 */

/** A stored session, as it is in the collection. */
export interface SessionDocument {
  readonly _id: string;
  readonly version: number;
  readonly state: unknown;
}

/**
 * The three single-document operations the adapter uses. It is the whole of
 * what it needs from a collection; a driver collection is adapted to it below.
 */
export interface SessionCollection {
  /** Replaces the document with this id, or inserts it if there is none. */
  replace(document: SessionDocument): Promise<void>;
  /** The document with this id, or null. */
  find(sessionId: string): Promise<SessionDocument | null>;
  /** Removes the document with this id, if there is one. */
  remove(sessionId: string): Promise<void>;
  /** Lets go of the connection. */
  close(): Promise<void>;
}

export interface MongoSessionStoreOptions {
  /** A MongoDB connection string. It is used to connect and never reported back. */
  readonly uri: string;
  readonly databaseName: string;
  /** Defaults to "sessions". */
  readonly collectionName?: string;
  /**
   * How long an operation may wait to find a server before it fails. Left out,
   * the driver's own default applies (30 seconds).
   */
  readonly serverSelectionTimeoutMs?: number;
}

export const DEFAULT_SESSION_COLLECTION = 'sessions';

const SAVE_FAILED = 'The session could not be saved.';
const LOAD_FAILED = 'The session could not be loaded.';
const DELETE_FAILED = 'The session could not be deleted.';
const CLOSED = 'The session store is closed.';
const NOT_SERIALISABLE = 'The snapshot could not be serialised.';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Copies a value as plain JSON data. A snapshot is JSON-compatible by
 * definition, so this changes nothing in a real one. It is what makes the copy
 * independent of the caller's object, and it refuses what cannot be stored.
 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export class MongoSessionStore implements SessionStore {
  readonly #open: () => SessionCollection;
  #collection: SessionCollection | undefined;
  #closed = false;

  /**
   * `open` is called at most once, on the first operation, to get the
   * collection. Use `createMongoSessionStore` to make a store for a real
   * database; this constructor exists so the adapter can be tested without one.
   */
  constructor(open: () => SessionCollection) {
    this.#open = open;
  }

  async save(snapshot: GameSessionSnapshot): Promise<Result<void, SessionStoreError>> {
    const id = parseSessionId((snapshot as { sessionId?: unknown } | null | undefined)?.sessionId);
    if (!id.ok) return id;

    let document: SessionDocument;
    try {
      const copy = plain(snapshot) as { version: number; state: unknown };
      document = { _id: id.value, version: copy.version, state: copy.state };
    } catch {
      return err(sessionStoreError('STORAGE_ERROR', NOT_SERIALISABLE));
    }
    return this.#run(SAVE_FAILED, (collection) => collection.replace(document));
  }

  async load(sessionId: string): Promise<Result<GameSessionSnapshot | null, SessionStoreError>> {
    const id = parseSessionId(sessionId);
    if (!id.ok) return id;

    return this.#run(LOAD_FAILED, async (collection) => {
      const document = await collection.find(id.value);
      if (document === null) return null;
      // A new plain object every time: nothing of the driver's own document, and
      // no `_id`. Frozen like the snapshot a session hands out.
      const snapshot = plain({
        version: document.version,
        sessionId: document._id,
        state: document.state,
      });
      return deepFreeze(snapshot as GameSessionSnapshot);
    });
  }

  async delete(sessionId: string): Promise<Result<void, SessionStoreError>> {
    const id = parseSessionId(sessionId);
    if (!id.ok) return id;
    return this.#run(DELETE_FAILED, (collection) => collection.remove(id.value));
  }

  /**
   * Lets go of the connection. Afterwards every operation returns
   * STORAGE_ERROR; the store does not reconnect. Closing twice, or closing a
   * store that never connected, does nothing.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const collection = this.#collection;
    this.#collection = undefined;
    try {
      await collection?.close();
    } catch {
      // There is nothing useful to do with a failure to close.
    }
  }

  /** Runs one operation, once, and turns anything it throws into STORAGE_ERROR. */
  async #run<T>(
    message: string,
    operation: (collection: SessionCollection) => Promise<T>,
  ): Promise<Result<T, SessionStoreError>> {
    if (this.#closed) return err(sessionStoreError('STORAGE_ERROR', CLOSED));
    try {
      this.#collection ??= this.#open();
      return ok(await operation(this.#collection));
    } catch {
      // The driver's error is dropped here on purpose. It can carry a host
      // name, a connection string or server detail, and none of that belongs in
      // a SessionStoreError.
      return err(sessionStoreError('STORAGE_ERROR', message));
    }
  }
}

/**
 * Makes a store for a MongoDB database.
 *
 * Nothing happens until the store is used: no client is made and no connection
 * is opened here, so this cannot fail. The first operation makes one client,
 * which the driver connects, and the store keeps it until `close`. Each store
 * has its own client; nothing is shared between stores or kept at module level.
 *
 * The driver's own automatic retry of a failed read or write is switched off,
 * so an operation is attempted once.
 */
export function createMongoSessionStore(options: MongoSessionStoreOptions): MongoSessionStore {
  const { uri, databaseName } = options;
  const collectionName = options.collectionName ?? DEFAULT_SESSION_COLLECTION;

  return new MongoSessionStore(() => {
    const client = new MongoClient(uri, {
      retryWrites: false,
      retryReads: false,
      ...(options.serverSelectionTimeoutMs === undefined
        ? {}
        : { serverSelectionTimeoutMS: options.serverSelectionTimeoutMs }),
    });
    const collection = client.db(databaseName).collection<SessionDocument>(collectionName);
    return {
      async replace(document) {
        await collection.replaceOne({ _id: document._id }, document, { upsert: true });
      },
      find: (sessionId) => collection.findOne({ _id: sessionId }),
      async remove(sessionId) {
        await collection.deleteOne({ _id: sessionId });
      },
      close: () => client.close(),
    };
  });
}
