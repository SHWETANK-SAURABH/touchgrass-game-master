import { type Clock, type Result, err } from '@touchgrass/shared';
import type { GameSession, GameSessionSnapshot } from '@touchgrass/game-session';
import type { Room, RoomConnection } from '@touchgrass/realtime';
import {
  InMemorySessionStore,
  type SessionStore,
  type SessionStoreError,
} from '@touchgrass/session-store';
import type { ClosableSessionStore } from './persistent-server';

/**
 * Helpers for the server tests. Not exported from the package.
 */

export const T0 = 1_700_000_000_000;
export const CODE = 'GRASS7';
export const START = 1_000;
export const ROUND_MS = 180_000;

export const at = (ms: number) => ({
  now: T0 + ms,
  nextEntryId: (sequence: number) => `entry-${sequence}`,
});

/** A clock that only moves when a test moves it. */
export function testClock(): Clock & { set(ms: number): void } {
  let now = T0;
  return {
    now: () => now,
    set: (ms) => {
      now = T0 + ms;
    },
  };
}

export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

export const codeOf = (result: { ok: true } | { ok: false; error: { code: string } }): string =>
  result.ok ? 'ok' : result.error.code;

export const createCommand = (sessionId = 'g1', gameId = 'tag') => ({
  type: 'CREATE_SESSION' as const,
  sessionId,
  gameId,
  joinCode: CODE,
  randomSeed: 7,
});

/** Adds three players and makes them ready, so round 1 is running. */
export function start(session: GameSession): void {
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
}

/** Makes the tagger tag a runner, at `ms`. */
export function playTag(session: GameSession, ms: number): void {
  const players = session.getState().players;
  const tagger = players.find((player) => player.roleId === 'tagger');
  const runner = players.find((player) => player.roleId === 'runner');
  if (!tagger || !runner) throw new Error('fixture failed');
  unwrap(
    session.submitAction(tagger.id, { type: 'PLAYER_TAGGED', targetPlayerId: runner.id }, at(ms)),
  );
}

/** A real in-memory store that counts every call it receives and can be closed. */
export function countingStore(inner: SessionStore = new InMemorySessionStore()) {
  const calls = { save: 0, load: 0, delete: 0, close: 0 };
  const saved: GameSessionSnapshot[] = [];
  let closed = false;
  const refuse = <T>(): Promise<Result<T, SessionStoreError>> =>
    Promise.resolve(err({ code: 'STORAGE_ERROR', message: 'The session store is closed.' }));

  const store: ClosableSessionStore = {
    save(snapshot) {
      calls.save += 1;
      if (closed) return refuse();
      saved.push(snapshot);
      return inner.save(snapshot);
    },
    load(sessionId) {
      calls.load += 1;
      return closed ? refuse() : inner.load(sessionId);
    },
    delete(sessionId) {
      calls.delete += 1;
      return closed ? refuse() : inner.delete(sessionId);
    },
    close() {
      calls.close += 1;
      closed = true;
      return Promise.resolve();
    },
  };
  return { store, calls, saved, inner };
}

/** A store whose saves fail, and whose loads find nothing. */
export function failingStore(options: { load?: 'missing' | 'fail' } = {}) {
  const calls = { save: 0, load: 0, delete: 0 };
  const failure: SessionStoreError = { code: 'STORAGE_ERROR', message: 'The database is away.' };
  const store: SessionStore = {
    save() {
      calls.save += 1;
      return Promise.resolve(err(failure));
    },
    load() {
      calls.load += 1;
      return Promise.resolve(
        options.load === 'fail' ? err(failure) : { ok: true as const, value: null },
      );
    },
    delete() {
      calls.delete += 1;
      return Promise.resolve(err(failure));
    },
  };
  return { store, calls };
}

/** What a room sent a connection, decoded. */
export interface Received {
  type: string;
  code?: string;
  playerId?: string;
  token?: string;
  error?: { code: string };
  state?: { status: string; currentRound: number; players: { id: string; ready: boolean }[] };
}

export interface TestConnection extends RoomConnection {
  readonly inbox: Received[];
  readonly raw: string[];
  take(): Received[];
  closed: boolean;
}

export function connection(): TestConnection {
  const inbox: Received[] = [];
  const raw: string[] = [];
  let read = 0;
  return {
    inbox,
    raw,
    closed: false,
    send(text) {
      raw.push(text);
      inbox.push(JSON.parse(text) as Received);
    },
    close() {
      this.closed = true;
    },
    take() {
      const fresh = inbox.slice(read);
      read = inbox.length;
      return fresh;
    },
  };
}

export const send = (room: Room, who: RoomConnection, message: unknown, ms = 0): void => {
  room.receive(who, JSON.stringify(message), at(ms));
};

/** Joins and returns the player id and token the room gave. */
export function join(
  room: Room,
  who: TestConnection,
  name: string,
): { playerId: string; token: string } {
  send(room, who, { type: 'join', joinCode: CODE, displayName: name });
  const reply = who.inbox.at(-1);
  if (reply?.type !== 'joined' || !reply.playerId || !reply.token) throw new Error('join failed');
  return { playerId: reply.playerId, token: reply.token };
}
