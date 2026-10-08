import { describe, expect, it } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import { type EngineContext, contextAt } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from '@touchgrass/game-session';
import { type ServerMessage, serverMessageSchema } from './protocol';
import { type Room, type RoomConnection, createRoom } from './room';

const T0 = 1_700_000_000_000;
const at = (ms: number): EngineContext => contextAt(fixedClock(T0 + ms));
const CODE = 'GRASS7';
const ROUND_MS = 180_000;
const SESSION_CLOSED = { type: 'error', code: 'SESSION_CLOSED' };

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

function join(room: Room, who: TestConnection, name: string): string {
  send(room, who, { type: 'join', joinCode: CODE, displayName: name });
  const reply = who.inbox.at(-1);
  if (reply?.type !== 'joined' || !reply.token) throw new Error('join failed');
  return reply.token;
}

/** A room with a player, the host, a connection that only sent rubbish, and a silent one. */
function busyRoom(sessionId = 'g1') {
  const session = newSession(sessionId);
  const room = createRoom({ session, hostToken: 'host-token' });
  const player = connection();
  const host = connection();
  const stranger = connection();
  const silent = connection();
  const token = join(room, player, 'Ada');
  send(room, host, { type: 'host_auth', token: 'host-token' });
  send(room, stranger, 'not a message');
  expect(room.attach(silent)).toBe(true);
  for (const who of [player, host, stranger, silent]) who.take();
  return { session, room, player, host, stranger, silent, token };
}

describe('closing a room', () => {
  it('tells every connection it knows of, joined or not, and closes each once', () => {
    const { room, player, host, stranger, silent } = busyRoom();
    expect(room.isClosed()).toBe(false);
    room.close();
    expect(room.isClosed()).toBe(true);
    for (const who of [player, host, stranger, silent]) {
      expect(who.take()).toEqual([SESSION_CLOSED]);
      expect(who.closes).toBe(1);
    }
    expect(room.connectionCount()).toBe(0);
    expect(room.isHost(host)).toBe(false);
    expect(room.playerIdOf(player)).toBeUndefined();
  });

  it('does nothing the second time', () => {
    const { room, player } = busyRoom();
    room.close();
    room.close();
    expect(player.inbox.filter((message) => message.type === 'error')).toHaveLength(1);
    expect(player.closes).toBe(1);
  });

  it('does not tell a connection that had already gone', () => {
    const { room, player, silent } = busyRoom();
    room.disconnect(player);
    room.disconnect(silent);
    room.close();
    expect(player.take()).toEqual([]);
    expect(silent.take()).toEqual([]);
    expect(player.closes + silent.closes).toBe(0);
  });

  it('does not change the game', () => {
    const { room, session } = busyRoom();
    const before = session.getState();
    room.close();
    expect(session.getState()).toBe(before);
  });

  it('survives a connection that cannot be written to or closed', () => {
    const { room, player } = busyRoom();
    const broken: RoomConnection = {
      send() {
        throw new Error('gone');
      },
      close() {
        throw new Error('gone');
      },
    };
    room.attach(broken);
    expect(() => {
      room.close();
    }).not.toThrow();
    expect(player.closes).toBe(1);
  });
});

describe('a closed room', () => {
  it('answers every kind of frame with SESSION_CLOSED, closes the sender and changes nothing', () => {
    const { room, session, player, host, token } = busyRoom();
    room.close();
    const before = session.getState();
    for (const who of [player, host]) who.take();

    const late = connection();
    const frames: unknown[] = [
      { type: 'join', joinCode: CODE, displayName: 'Late' },
      { type: 'resume', token },
      { type: 'action', intent: { type: 'PLAYER_READY' } },
      { type: 'leave' },
      { type: 'host_auth', token: 'host-token' },
      { type: 'host_command', command: { type: 'ABORT_SESSION', reason: 'rain' } },
      'not a message',
    ];
    for (const who of [player, host, late]) {
      for (const frame of frames) send(room, who, frame, 5_000);
      expect(who.take()).toEqual(frames.map(() => SESSION_CLOSED));
    }
    expect(late.closes).toBe(frames.length);
    expect(session.getState()).toBe(before);
    expect(room.connectionCount()).toBe(0);
    expect(room.isHost(host)).toBe(false);
  });

  it('accepts no new connection', () => {
    const { room } = busyRoom();
    room.close();
    const late = connection();
    expect(room.attach(late)).toBe(false);
    // Nothing was kept, and nothing was sent: the caller decides what to say.
    expect(late.take()).toEqual([]);
    expect(late.closes).toBe(0);
  });

  it('no longer moves its game on with tick', () => {
    const session = newSession();
    const room = createRoom({ session });
    const players = [connection(), connection(), connection()];
    for (const [index, who] of players.entries()) join(room, who, `Player ${index}`);
    for (const who of players)
      send(room, who, { type: 'action', intent: { type: 'PLAYER_READY' } });
    expect(session.getState().status).toBe('active');
    room.close();
    for (const who of players) who.take();

    const before = session.getState();
    const ticked = room.tick(at(10 * ROUND_MS));
    expect(ticked).toEqual({ ok: true, value: { state: before, entries: [] } });
    expect(session.getState()).toBe(before);
    for (const who of players) expect(who.take()).toEqual([]);
  });

  it('leaves another room exactly as it was', () => {
    const a = busyRoom('a');
    const b = busyRoom('b');
    const untouched = b.session.getState();
    a.room.close();

    expect(b.room.isClosed()).toBe(false);
    for (const who of [b.player, b.host, b.stranger, b.silent]) {
      expect(who.take()).toEqual([]);
      expect(who.closes).toBe(0);
    }
    expect(b.session.getState()).toBe(untouched);
    expect(b.room.connectionCount()).toBe(1);
    expect(b.room.isHost(b.host)).toBe(true);

    // And it still works: an action there reaches its player and its host.
    send(b.room, b.player, { type: 'action', intent: { type: 'PLAYER_READY' } }, 500);
    expect(b.player.take().map((message) => message.type)).toEqual(['update']);
    expect(b.host.take().map((message) => message.type)).toEqual(['update']);
    expect(a.player.take()).toEqual([SESSION_CLOSED]);
  });
});

describe('attaching a connection', () => {
  it('changes nothing a client can see', () => {
    const session = newSession();
    const room = createRoom({ session });
    const who = connection();
    const before = session.getState();
    expect(room.attach(who)).toBe(true);
    expect(room.attach(who)).toBe(true);
    expect(who.take()).toEqual([]);
    expect(room.connectionCount()).toBe(0);
    expect(room.playerIdOf(who)).toBeUndefined();
    expect(session.getState()).toBe(before);
    // It is still nobody until it joins.
    send(room, who, { type: 'action', intent: { type: 'PLAYER_READY' } });
    expect(who.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
  });
});
