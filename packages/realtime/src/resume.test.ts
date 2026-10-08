import { describe, expect, it } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import { type EngineContext, contextAt } from '@touchgrass/game-engine';
import { type GameSession, createGameSession, restoreGameSession } from '@touchgrass/game-session';
import { type ServerMessage, serverMessageSchema } from './protocol';
import { type Room, type RoomConnection, createRoom } from './room';

/**
 * Resume in a room whose player tokens can be made again.
 *
 * The token maker here is a plain, readable stand-in: it only has to be the
 * same for the same player and different for different ones. What makes a real
 * one unguessable is tested where it is made, in the server package.
 */

const T0 = 1_700_000_000_000;
const at = (ms: number): EngineContext => contextAt(fixedClock(T0 + ms));
const CODE = 'GRASS7';
const INVALID_TOKEN = { type: 'error', code: 'INVALID_TOKEN' };
const READY = { type: 'action', intent: { type: 'PLAYER_READY' } };

const tokenOf =
  (sessionId: string) =>
  (playerId: string): string =>
    `test-token:${sessionId}:${playerId}`;

function newSession(sessionId = 'g1'): GameSession {
  const created = createGameSession(
    { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode: CODE, randomSeed: 7 },
    at(0),
  );
  if (!created.ok) throw new Error('fixture failed');
  return created.value;
}

interface TestConnection extends RoomConnection {
  readonly inbox: ServerMessage[];
  take(): ServerMessage[];
  closes: number;
}

function connection(): TestConnection {
  const inbox: ServerMessage[] = [];
  let read = 0;
  return {
    inbox,
    closes: 0,
    send(text) {
      inbox.push(serverMessageSchema.parse(JSON.parse(text)));
    },
    close() {
      this.closes += 1;
    },
    take() {
      const fresh = inbox.slice(read);
      read = inbox.length;
      return fresh;
    },
  };
}

const send = (room: Room, who: RoomConnection, message: unknown, ms = 0): void => {
  room.receive(who, JSON.stringify(message), at(ms));
};

/** A room over a session, with ids that count up and tokens that can be made again. */
function roomFor(session: GameSession, firstPlayer = 1): Room {
  let next = firstPlayer;
  return createRoom({
    session,
    hostToken: `host-of-${session.id}`,
    createPlayerId: () => `player-${next++}`,
    playerToken: tokenOf(session.id),
  });
}

function join(
  room: Room,
  who: TestConnection,
  name: string,
  ms = 0,
): { playerId: string; token: string } {
  send(room, who, { type: 'join', joinCode: CODE, displayName: name }, ms);
  const reply = who.inbox.at(-1);
  if (reply?.type !== 'joined' || !reply.token) {
    throw new Error(`join failed: ${JSON.stringify(reply).slice(0, 200)}`);
  }
  who.take();
  return { playerId: reply.playerId, token: reply.token };
}

/** The same game in a new session object, as a reload gives. */
function reloaded(session: GameSession): GameSession {
  const restored = restoreGameSession(session.snapshot());
  if (!restored.ok) throw new Error('fixture failed');
  return restored.value;
}

describe('a player token that can be made again', () => {
  it('is what a join hands out, once, to the joiner only', () => {
    const room = roomFor(newSession());
    const ada = connection();
    const bo = connection();
    const first = join(room, ada, 'Ada');
    send(room, bo, { type: 'join', joinCode: CODE, displayName: 'Bo' });

    expect(first).toEqual({ playerId: 'player-1', token: 'test-token:g1:player-1' });
    // Bo's join told Ada the game changed. It did not tell her Bo's token.
    const heard = JSON.stringify(ada.take());
    expect(heard).toContain('player-2');
    expect(heard).not.toContain('test-token');
  });

  it('never enters the game state or a snapshot', () => {
    const session = newSession();
    const room = roomFor(session);
    join(room, connection(), 'Ada');
    expect(JSON.stringify(session.getState())).not.toContain('test-token');
    expect(JSON.stringify(session.snapshot())).not.toContain('test-token');
  });

  it('resumes the same player after the connection went away', () => {
    const session = newSession();
    const room = roomFor(session);
    const before = connection();
    const { playerId, token } = join(room, before, 'Ada');
    room.disconnect(before);
    const untouched = session.getState();

    const after = connection();
    send(room, after, { type: 'resume', token });
    const reply = after.take();
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ type: 'joined', playerId });
    // A resume hands out no token and changes nothing in the game.
    expect(reply[0]).not.toHaveProperty('token');
    expect(session.getState()).toBe(untouched);
    expect(room.playerIdOf(after)).toBe(playerId);
    expect(room.playerIdOf(before)).toBeUndefined();
    expect(before.take()).toEqual([]);
  });
});

describe('resuming in a new room around the same game', () => {
  /** Two players join and one is ready; then the room is closed and the game reloaded. */
  function unloadedAndReloaded() {
    const first = newSession();
    const oldRoom = roomFor(first);
    const [a, b] = [connection(), connection()];
    const ada = join(oldRoom, a, 'Ada');
    const bo = join(oldRoom, b, 'Bo');
    send(oldRoom, a, READY, 500);
    oldRoom.close();
    for (const who of [a, b]) who.take();

    const session = reloaded(first);
    const room = roomFor(session, 3);
    return { first, oldRoom, session, room, ada, bo, oldConnections: [a, b] };
  }

  it('gives a player back the same identity and the state that was saved', () => {
    const { session, room, ada, bo } = unloadedAndReloaded();
    const untouched = session.getState();

    const back = connection();
    send(room, back, { type: 'resume', token: ada.token });
    const reply = back.take();
    expect(reply).toHaveLength(1);
    const joined = reply[0];
    if (joined?.type !== 'joined') throw new Error('expected joined');
    expect(joined.playerId).toBe(ada.playerId);
    expect(joined.token).toBeUndefined();
    // Who they are comes from the restored game: still Ada, still ready.
    const me = joined.state.players.find((player) => player.id === ada.playerId);
    expect(me).toMatchObject({ displayName: 'Ada', ready: true });
    expect(joined.state.players.find((player) => player.id === bo.playerId)).toMatchObject({
      displayName: 'Bo',
      ready: false,
    });
    expect(session.getState()).toBe(untouched);
    expect(room.connectionCount()).toBe(1);
  });

  it('lets the resumed player act, and tells the others who have come back', () => {
    const { session, room, ada, bo } = unloadedAndReloaded();
    const [a, b] = [connection(), connection()];
    send(room, a, { type: 'resume', token: ada.token });
    send(room, b, { type: 'resume', token: bo.token });
    for (const who of [a, b]) who.take();

    send(room, b, READY, 1_000);
    expect(a.take().map((message) => message.type)).toEqual(['update']);
    expect(b.take().map((message) => message.type)).toEqual(['update']);
    expect(session.getState().players.map((player) => player.ready)).toEqual([true, true]);
  });

  it('leaves the old room, its connections and its session object out of it', () => {
    const { first, oldRoom, session, room, ada, oldConnections } = unloadedAndReloaded();
    const frozen = first.getState();
    const back = connection();
    send(room, back, { type: 'resume', token: ada.token });
    send(room, back, { type: 'action', intent: { type: 'PLAYER_READY' } }, 2_000);
    send(room, back, { type: 'leave' }, 3_000);

    // Nothing of that reached the session the old room was built around.
    expect(first.getState()).toBe(frozen);
    expect(session.getState()).not.toBe(frozen);
    for (const who of oldConnections) expect(who.take()).toEqual([]);

    // And the old room takes nobody back, with a token or without.
    const late = connection();
    send(oldRoom, late, { type: 'resume', token: ada.token });
    expect(late.take()).toEqual([{ type: 'error', code: 'SESSION_CLOSED' }]);
    expect(oldRoom.playerIdOf(late)).toBeUndefined();
    expect(first.getState()).toBe(frozen);
  });

  it('gives a new player a new token, and the returning ones the tokens they had', () => {
    const { room, ada } = unloadedAndReloaded();
    const cy = join(room, connection(), 'Cy', 1_000);
    expect(cy.token).not.toBe(ada.token);
    const back = connection();
    send(room, back, { type: 'resume', token: ada.token });
    expect(room.playerIdOf(back)).toBe(ada.playerId);
  });

  it('does not take back a player the game had lost before it was saved', () => {
    const first = newSession();
    const oldRoom = roomFor(first);
    const a = connection();
    const ada = join(oldRoom, a, 'Ada');
    send(oldRoom, a, { type: 'leave' });
    oldRoom.close();

    const session = reloaded(first);
    const room = roomFor(session, 2);
    const untouched = session.getState();
    const back = connection();
    send(room, back, { type: 'resume', token: ada.token });
    expect(back.take()).toEqual([INVALID_TOKEN]);
    expect(room.playerIdOf(back)).toBeUndefined();
    expect(session.getState()).toBe(untouched);
  });
});

describe('a resume that is refused', () => {
  function twoGames() {
    const one = newSession('one');
    const two = newSession('two');
    const roomOne = roomFor(one);
    const roomTwo = roomFor(two);
    const ada = join(roomOne, connection(), 'Ada');
    const al = join(roomOne, connection(), 'Al');
    const bo = join(roomTwo, connection(), 'Bo');
    return { one, two, roomOne, roomTwo, ada, al, bo };
  }

  it('changes nothing and attaches nobody, whatever the token is', () => {
    const { one, roomOne, ada } = twoGames();
    const untouched = one.getState();
    const who = connection();
    for (const token of [
      'nonsense',
      `${ada.token}x`,
      ada.token.slice(0, -1),
      ada.token.toUpperCase(),
      'test-token:one:player-9',
      'host-of-one',
    ]) {
      send(roomOne, who, { type: 'resume', token });
    }
    expect(who.take()).toEqual(Array.from({ length: 6 }, () => INVALID_TOKEN));
    expect(roomOne.playerIdOf(who)).toBeUndefined();
    expect(roomOne.isHost(who)).toBe(false);
    expect(roomOne.connectionCount()).toBe(2);
    expect(one.getState()).toBe(untouched);
    // It is still nobody.
    send(roomOne, who, READY);
    expect(who.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
  });

  it('refuses a token from another game, even for a player id both games have', () => {
    const { one, two, roomOne, roomTwo, ada, bo } = twoGames();
    // Both rooms count their players from one, so the ids are the same.
    expect(ada.playerId).toBe(bo.playerId);
    expect(ada.token).not.toBe(bo.token);
    const [stateOne, stateTwo] = [one.getState(), two.getState()];

    const inTwo = connection();
    send(roomTwo, inTwo, { type: 'resume', token: ada.token });
    const inOne = connection();
    send(roomOne, inOne, { type: 'resume', token: bo.token });
    expect(inTwo.take()).toEqual([INVALID_TOKEN]);
    expect(inOne.take()).toEqual([INVALID_TOKEN]);
    expect(roomTwo.playerIdOf(inTwo)).toBeUndefined();
    expect(roomOne.playerIdOf(inOne)).toBeUndefined();
    expect(one.getState()).toBe(stateOne);
    expect(two.getState()).toBe(stateTwo);
  });

  it('makes a player only the player the token is for', () => {
    const { roomOne, ada, al } = twoGames();
    const who = connection();
    send(roomOne, who, { type: 'resume', token: al.token });
    expect(roomOne.playerIdOf(who)).toBe(al.playerId);
    expect(roomOne.playerIdOf(who)).not.toBe(ada.playerId);

    // Having become Al, it cannot also become Ada.
    send(roomOne, who, { type: 'resume', token: ada.token });
    expect(who.take().at(-1)).toEqual({ type: 'error', code: 'ALREADY_JOINED' });
    expect(roomOne.playerIdOf(who)).toBe(al.playerId);
  });

  it('refuses a player who was removed, at once', () => {
    const { one, roomOne, ada } = twoGames();
    const removed = one.applyCommand({ type: 'REMOVE_PLAYER', playerId: ada.playerId }, at(100));
    expect(removed.ok).toBe(true);
    const who = connection();
    send(roomOne, who, { type: 'resume', token: ada.token });
    expect(who.take()).toEqual([INVALID_TOKEN]);
    // And stays refused: the token is not made again for a player who has left.
    send(roomOne, who, { type: 'resume', token: ada.token });
    expect(who.take()).toEqual([INVALID_TOKEN]);
  });
});

describe('a second connection resuming as a player who is connected', () => {
  function connected() {
    const session = newSession();
    const room = roomFor(session);
    const old = connection();
    const other = connection();
    const ada = join(room, old, 'Ada');
    join(room, other, 'Bo');
    old.take();
    return { session, room, old, other, ada };
  }

  it('takes the player over: the old connection is told, closed, and is nobody', () => {
    const { session, room, old, other, ada } = connected();
    const untouched = session.getState();
    const fresh = connection();
    send(room, fresh, { type: 'resume', token: ada.token });

    expect(old.take()).toEqual([{ type: 'error', code: 'CONNECTION_REPLACED' }]);
    expect(old.closes).toBe(1);
    expect(room.playerIdOf(old)).toBeUndefined();
    expect(room.playerIdOf(fresh)).toBe(ada.playerId);
    // Still two players connected: one connection each.
    expect(room.connectionCount()).toBe(2);
    expect(session.getState()).toBe(untouched);
    expect(other.take()).toEqual([]);
  });

  it('leaves the old connection unable to act or to hear', () => {
    const { session, room, old, other, ada } = connected();
    const fresh = connection();
    send(room, fresh, { type: 'resume', token: ada.token });
    for (const who of [old, fresh, other]) who.take();

    const before = session.getState();
    send(room, old, READY, 500);
    send(room, old, { type: 'leave' }, 500);
    expect(old.take()).toEqual([
      { type: 'error', code: 'NOT_JOINED' },
      { type: 'error', code: 'NOT_JOINED' },
    ]);
    expect(session.getState()).toBe(before);

    // The new one acts as the player, and the old one hears nothing of it.
    send(room, fresh, READY, 600);
    expect(fresh.take().map((message) => message.type)).toEqual(['update']);
    expect(other.take().map((message) => message.type)).toEqual(['update']);
    expect(old.take()).toEqual([]);
  });

  it('is not undone when the old connection finally reports closed', () => {
    const { room, old, ada } = connected();
    const fresh = connection();
    send(room, fresh, { type: 'resume', token: ada.token });
    room.disconnect(old);
    expect(room.playerIdOf(fresh)).toBe(ada.playerId);
    expect(room.connectionCount()).toBe(2);
  });

  it('settles two resumes in the order they arrive: the last one is the player', () => {
    const { room, old, ada } = connected();
    const [first, second] = [connection(), connection()];
    send(room, first, { type: 'resume', token: ada.token });
    send(room, second, { type: 'resume', token: ada.token });

    expect(room.playerIdOf(second)).toBe(ada.playerId);
    expect(room.playerIdOf(first)).toBeUndefined();
    expect(room.playerIdOf(old)).toBeUndefined();
    expect(first.take().map((message) => message.type)).toEqual(['joined', 'error']);
    expect(first.closes).toBe(1);
    expect(old.closes).toBe(1);
    expect(room.connectionCount()).toBe(2);
  });

  it('is not told again when the room closes', () => {
    const { room, old, ada } = connected();
    const fresh = connection();
    send(room, fresh, { type: 'resume', token: ada.token });
    old.take();
    room.close();
    expect(old.take()).toEqual([]);
    expect(old.closes).toBe(1);
    expect(fresh.take().at(-1)).toEqual({ type: 'error', code: 'SESSION_CLOSED' });
  });
});

describe('a room without tokens that can be made again', () => {
  it('still hands out a random token that works only in that room', () => {
    const first = newSession();
    const oldRoom = createRoom({ session: first });
    const ada = join(oldRoom, connection(), 'Ada');
    expect(ada.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = connection();
    send(oldRoom, again, { type: 'resume', token: ada.token });
    expect(oldRoom.playerIdOf(again)).toBe(ada.playerId);

    const room = createRoom({ session: reloaded(first) });
    const back = connection();
    send(room, back, { type: 'resume', token: ada.token });
    expect(back.take()).toEqual([INVALID_TOKEN]);
  });
});
