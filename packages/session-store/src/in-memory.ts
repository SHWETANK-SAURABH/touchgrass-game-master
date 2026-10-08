import { type Result, err, ok } from '@touchgrass/shared';
import type { GameSessionSnapshot } from '@touchgrass/game-session';
import {
  type SessionStore,
  type SessionStoreError,
  parseSessionId,
  sessionStoreError,
} from './store';

/**
 * A SessionStore that keeps snapshots in memory.
 *
 * It is for tests, for local development, and as the reference for how a store
 * behaves. It is not persistence: everything in it is gone when the process
 * stops, or when the instance is let go of.
 *
 * Each snapshot is kept as its JSON text. A snapshot is plain data that survives
 * JSON unchanged, and text cannot be altered through a reference, so the copy
 * rules of the interface follow directly: saving writes new text, and every load
 * parses that text into a new object. It is also how a real store would hold
 * one, so a snapshot that cannot be serialised fails here as it would there.
 *
 * All state is in the instance. Two stores share nothing.
 */
export class InMemorySessionStore implements SessionStore {
  /** Session id → the JSON text of its snapshot. */
  readonly #snapshots = new Map<string, string>();

  save(snapshot: GameSessionSnapshot): Promise<Result<void, SessionStoreError>> {
    return Promise.resolve(this.#save(snapshot));
  }

  load(sessionId: string): Promise<Result<GameSessionSnapshot | null, SessionStoreError>> {
    return Promise.resolve(this.#load(sessionId));
  }

  delete(sessionId: string): Promise<Result<void, SessionStoreError>> {
    const id = parseSessionId(sessionId);
    if (!id.ok) return Promise.resolve(id);
    this.#snapshots.delete(id.value);
    return Promise.resolve(ok(undefined));
  }

  #save(snapshot: GameSessionSnapshot): Result<void, SessionStoreError> {
    // The key is read from the snapshot, which may not be what its type says.
    const id = parseSessionId((snapshot as { sessionId?: unknown } | null | undefined)?.sessionId);
    if (!id.ok) return id;

    let text: string;
    try {
      text = JSON.stringify(snapshot);
    } catch {
      return err(sessionStoreError('STORAGE_ERROR', 'The snapshot could not be serialised.'));
    }
    this.#snapshots.set(id.value, text);
    return ok(undefined);
  }

  #load(sessionId: string): Result<GameSessionSnapshot | null, SessionStoreError> {
    const id = parseSessionId(sessionId);
    if (!id.ok) return id;

    const text = this.#snapshots.get(id.value);
    if (text === undefined) return ok(null);
    // A new object every time, frozen like the snapshot a session hands out.
    return ok(deepFreeze(JSON.parse(text) as GameSessionSnapshot));
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
