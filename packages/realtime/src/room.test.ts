import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import { type EngineContext, type GameState, contextAt } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from '@touchgrass/game-session';
import { type ServerMessage, serverMessageSchema } from './protocol';
import { type Room, type RoomConnection, createRoom } from './room';

const T0 = 1_700_000_000_000;
const at = (ms: number): EngineContext => contextAt(fixedClock(T0 + ms));
const START = 1_000;
const NOW = START + 5_000;
const ROUND_MS = 180_000;
const CODE = 'GRASS7';

function newSession(sessionId = 'g1', joinCode = CODE): GameSession {
  const created = createGameSession(
    { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode, randomSeed: 7 },
    at(0),
  );
  if (!created.ok) throw new Error('fixture failed');
  return created.value;
}

/** A connection that records what it was sent. */
interface TestConnection extends RoomConnection {
  readonly name: string;
  readonly inbox: ServerMessage[];
  /** The messages received since the last call. */
  take(): ServerMessage[];
  closed: boolean;
}

function connection(name: string): TestConnection {
  const inbox: ServerMessage[] = [];
  let read = 0;
  return {
    name,
    inbox,
    closed: false,
    send(text) {
      // Everything a room sends must be a valid server envelope.
      inbox.push(serverMessageSchema.parse(JSON.parse(text)));
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

interface Fixture {
  session: GameSession;
  room: Room;
  minted: string[];
}

/** A room whose player ids are predictable: player-1, player-2, ... */
function newRoom(session = newSession()): Fixture {
  const minted: string[] = [];
  const room = createRoom({
    session,
    createPlayerId: () => {
      const id = `player-${minted.length + 1}`;
      minted.push(id);
      return id;
    },
  });
  return { session, room, minted };
}

const send = (room: Room, who: RoomConnection, message: unknown, ms = NOW): void => {
  room.receive(who, JSON.stringify(message), at(ms));
};
const joinAs = (room: Room, who: RoomConnection, displayName: string, ms = 0): void => {
  send(room, who, { type: 'join', joinCode: CODE, displayName }, ms);
};
const act = (room: Room, who: RoomConnection, intent: unknown, ms = NOW): void => {
  send(room, who, { type: 'action', intent }, ms);
};

/** Three joined connections whose players are all ready, so round 1 is running. */
function running(): Fixture & { a: TestConnection; b: TestConnection; c: TestConnection } {
  const fixture = newRoom();
  const [a, b, c] = [connection('a'), connection('b'), connection('c')];
  for (const who of [a, b, c]) joinAs(fixture.room, who, who.name.toUpperCase());
  for (const who of [a, b, c]) act(fixture.room, who, { type: 'PLAYER_READY' }, START);
  for (const who of [a, b, c]) who.take();
  return { ...fixture, a, b, c };
}

function byRole(fixture: ReturnType<typeof running>): {
  tagger: TestConnection;
  runners: [TestConnection, TestConnection];
  idOf: (who: TestConnection) => string;
} {
  const { room, session, a, b, c } = fixture;
  const idOf = (who: TestConnection): string => room.playerIdOf(who) ?? '';
  const roleOf = (who: TestConnection): string | null | undefined =>
    session.getState().players.find((player) => player.id === idOf(who))?.roleId;
  const all = [a, b, c];
  const tagger = all.find((who) => roleOf(who) === 'tagger');
  const runners = all.filter((who) => roleOf(who) === 'runner');
  if (!tagger || runners.length !== 2) throw new Error('fixture failed');
  return { tagger, runners: [runners[0] as TestConnection, runners[1] as TestConnection], idOf };
}

const tag = (targetPlayerId: string) => ({ type: 'PLAYER_TAGGED', targetPlayerId });
const types = (messages: ServerMessage[]): string[] => messages.map((message) => message.type);

describe('joining', () => {
  it('adds a player with an id the server made, and tells the joiner', () => {
    const { room, session, minted } = newRoom();
    const a = connection('a');
    joinAs(room, a, 'Ada');

    expect(minted).toEqual(['player-1']);
    expect(room.playerIdOf(a)).toBe('player-1');
    expect(session.getState().players).toMatchObject([{ id: 'player-1', displayName: 'Ada' }]);

    const [message] = a.take();
    expect(message).toMatchObject({ type: 'joined', playerId: 'player-1' });
    // The state in the reply is the session's authoritative state.
    expect(message?.type === 'joined' && message.state).toEqual(session.getState());
  });

  it('uses a random id by default, different for every join', () => {
    const session = newSession();
    const room = createRoom({ session });
    const [a, b] = [connection('a'), connection('b')];
    joinAs(room, a, 'Ada');
    joinAs(room, b, 'Grace');
    const ids = [room.playerIdOf(a), room.playerIdOf(b)];
    expect(ids[0]).toMatch(/^plr_[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^plr_[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(session.getState().players.map((player) => player.id)).toEqual(ids);
  });

  it('lets several connections join as different players and tells the others', () => {
    const { room, session } = newRoom();
    const [a, b] = [connection('a'), connection('b')];
    joinAs(room, a, 'Ada');
    a.take();
    joinAs(room, b, 'Grace');

    expect(room.connectionCount()).toBe(2);
    expect(session.getState().players.map((player) => player.id)).toEqual(['player-1', 'player-2']);
    expect(types(b.take())).toEqual(['joined']);
    const [update] = a.take();
    expect(update).toMatchObject({ type: 'update' });
    expect(update?.type === 'update' && update.state).toEqual(session.getState());
    expect(update?.type === 'update' && update.entries).toMatchObject([
      { record: { kind: 'COMMAND', command: 'ADD_PLAYER' } },
    ]);
  });

  it('checks the join code against the one game the room holds', () => {
    const { room, session } = newRoom();
    const a = connection('a');
    for (const joinCode of ['WRONG1', 'grass7', 'GRASS7 ', 'g1']) {
      send(room, a, { type: 'join', joinCode, displayName: 'Ada' }, 0);
    }
    expect(a.take()).toEqual(
      Array.from({ length: 4 }, () => ({ type: 'error', code: 'WRONG_JOIN_CODE' })),
    );
    expect(room.playerIdOf(a)).toBeUndefined();
    expect(session.getState().players).toEqual([]);
  });

  it('cannot be pointed at another game: the code of a different session is just wrong', () => {
    const other = newSession('g2', 'OTHER9');
    const { room, session } = newRoom();
    const a = connection('a');
    send(room, a, { type: 'join', joinCode: 'OTHER9', displayName: 'Ada' }, 0);
    expect(a.take()).toEqual([{ type: 'error', code: 'WRONG_JOIN_CODE' }]);
    expect(other.getState().players).toEqual([]);
    expect(session.getState().players).toEqual([]);
  });

  it('refuses a second join from the same connection', () => {
    const { room, session, minted } = newRoom();
    const a = connection('a');
    joinAs(room, a, 'Ada');
    joinAs(room, a, 'Ada again');
    expect(types(a.take())).toEqual(['joined', 'error']);
    expect(a.inbox.at(-1)).toEqual({ type: 'error', code: 'ALREADY_JOINED' });
    expect(session.getState().players).toHaveLength(1);
    expect(minted).toHaveLength(1);
  });

  it('does not bind a connection whose join the game refused', () => {
    const fixture = running();
    const { room, session } = fixture;
    const late = connection('late');
    const before = session.getState();

    // The game has started: the engine refuses new players.
    joinAs(room, late, 'Late', NOW);
    expect(late.take()).toMatchObject([
      { type: 'rejected', error: { code: 'GAME_ALREADY_STARTED' } },
    ]);
    expect(room.playerIdOf(late)).toBeUndefined();
    expect(room.connectionCount()).toBe(3);
    expect(session.getState()).toBe(before);
    // It is still not a player, so it cannot act and hears nothing.
    act(room, late, { type: 'PLAYER_READY' });
    expect(late.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
    for (const who of [fixture.a, fixture.b, fixture.c]) expect(who.take()).toEqual([]);
  });

  it('leaves the display name rule to the engine', () => {
    const { room, session } = newRoom();
    const a = connection('a');
    joinAs(room, a, 'x'.repeat(41));
    expect(a.take()).toMatchObject([{ type: 'rejected' }]);
    expect(room.playerIdOf(a)).toBeUndefined();
    expect(session.getState().players).toEqual([]);
  });

  it('refuses a fifth player, and does not bind the connection', () => {
    const { room } = newRoom();
    const all = ['a', 'b', 'c', 'd', 'e'].map(connection);
    for (const who of all) joinAs(room, who, who.name);
    expect(room.connectionCount()).toBe(4);
    expect(all[4]?.inbox).toMatchObject([
      { type: 'rejected', error: { code: 'PLAYER_LIMIT_EXCEEDED' } },
    ]);
  });
});

describe('actions', () => {
  it('refuses an action from a connection that has not joined', () => {
    const fixture = running();
    const stranger = connection('stranger');
    const before = fixture.session.getState();
    act(fixture.room, stranger, tag(fixture.room.playerIdOf(fixture.a) ?? ''));
    expect(stranger.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
    expect(fixture.session.getState()).toBe(before);
  });

  it('acts as the player the connection joined as', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    act(fixture.room, tagger, tag(idOf(runners[0])));

    const [update] = tagger.take();
    expect(update?.type === 'update' && update.entries[0]?.record).toEqual({
      kind: 'ACTION',
      action: { type: 'PLAYER_TAGGED', playerId: idOf(tagger), targetPlayerId: idOf(runners[0]) },
    });
  });

  it.each([
    [
      'in the envelope',
      (victim: string, target: string) => ({
        type: 'action',
        intent: tag(target),
        playerId: victim,
      }),
    ],
    [
      'as an actor id in the envelope',
      (victim: string, target: string) => ({
        type: 'action',
        intent: tag(target),
        actorId: victim,
      }),
    ],
    [
      'inside the intent',
      (victim: string, target: string) => ({
        type: 'action',
        intent: { ...tag(target), playerId: victim },
      }),
    ],
  ])('cannot act as another player by naming them %s', (_label, forge) => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    const [runner, other] = runners;
    const before = fixture.session.getState();

    // A runner's connection claims to be the tagger.
    send(fixture.room, runner, forge(idOf(tagger), idOf(other)));

    const [reply] = runner.take();
    expect(reply?.type === 'error' || reply?.type === 'rejected').toBe(true);
    expect(fixture.session.getState()).toBe(before);
    expect(tagger.take()).toEqual([]);
    expect(other.take()).toEqual([]);
  });

  it('sends the authoritative update to every joined connection', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    act(fixture.room, tagger, tag(idOf(runners[0])));

    const state = fixture.session.getState();
    for (const who of [fixture.a, fixture.b, fixture.c]) {
      const messages = who.take();
      expect(types(messages)).toEqual(['update']);
      const [update] = messages;
      if (update?.type !== 'update') throw new Error('expected an update');
      expect(update.state).toEqual(state);
      expect(update.entries).toEqual(state.history.slice(-2));
      expect(update.entries.map((entry) => entry.record.kind)).toEqual(['ACTION', 'EVENT']);
    }
  });

  it('never echoes what a client sent', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    send(fixture.room, tagger, {
      type: 'action',
      intent: { ...tag(idOf(runners[0])), state: { status: 'completed' }, note: 'SMUGGLED' },
    });
    send(fixture.room, tagger, {
      type: 'action',
      intent: tag(idOf(runners[0])),
      extra: 'SMUGGLED',
    });
    for (const who of [fixture.a, fixture.b, fixture.c]) {
      expect(JSON.stringify(who.inbox)).not.toContain('SMUGGLED');
    }
    expect(fixture.session.getState().status).toBe('active');
  });

  it('answers a refused action to the sender only, and changes nothing', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    const [runner, other] = runners;
    const before = fixture.session.getState();

    act(fixture.room, runner, tag(idOf(other)));

    expect(runner.take()).toMatchObject([{ type: 'rejected', error: { code: 'INVALID_ROLE' } }]);
    expect(tagger.take()).toEqual([]);
    expect(other.take()).toEqual([]);
    expect(fixture.session.getState()).toBe(before);
  });

  it('passes an invalid intent to the engine, which refuses it', () => {
    const fixture = running();
    const before = fixture.session.getState();
    for (const intent of [
      { type: 'NOPE' },
      'text',
      42,
      null,
      { type: 'ABORT_SESSION', reason: 'x' },
    ]) {
      act(fixture.room, fixture.a, intent);
    }
    expect(fixture.a.take()).toMatchObject(
      Array.from({ length: 5 }, () => ({ type: 'rejected', error: { code: 'INVALID_ACTION' } })),
    );
    expect(fixture.session.getState()).toBe(before);
    expect(fixture.b.take()).toEqual([]);
  });

  it('handles frames in order, each against the latest state', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    const [r1, r2] = runners;

    act(fixture.room, tagger, tag(idOf(r1))); // accepted
    act(fixture.room, tagger, tag(idOf(r2))); // refused: no longer the tagger
    act(fixture.room, r1, tag(idOf(r2))); // accepted, as the new tagger

    expect(types(tagger.take())).toEqual(['update', 'rejected', 'update']);
    const seen = r2.take();
    expect(types(seen)).toEqual(['update', 'update']);
    const sequences = seen.flatMap((message) =>
      message.type === 'update' ? message.entries.map((entry) => entry.sequence) : [],
    );
    const first = sequences[0] ?? 0;
    expect(sequences).toEqual(sequences.map((_, index) => first + index));
    const last = fixture.session.getState();
    expect(last.players.find((player) => player.id === idOf(r2))?.roleId).toBe('tagger');
    expect(last.history.at(-1)?.sequence).toBe(sequences.at(-1));
  });

  it('answers malformed frames with BAD_MESSAGE and nothing else happens', () => {
    const fixture = running();
    const before = fixture.session.getState();
    for (const raw of [
      '',
      'not json',
      '{"type":"tick"}',
      '[]',
      Buffer.from('{}'),
      null,
      undefined,
      7,
    ]) {
      fixture.room.receive(fixture.a, raw, at(NOW));
    }
    expect(fixture.a.take()).toEqual(
      Array.from({ length: 8 }, () => ({ type: 'error', code: 'BAD_MESSAGE' })),
    );
    expect(fixture.session.getState()).toBe(before);
    expect(fixture.b.take()).toEqual([]);
  });
});

describe('who hears what', () => {
  it('sends nothing about the game to a connection that has not joined', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    const watcher = connection('watcher');
    // It has spoken to the room, and been refused.
    send(fixture.room, watcher, { type: 'join', joinCode: 'WRONG1', displayName: 'W' });
    watcher.take();

    act(fixture.room, tagger, tag(idOf(runners[0])));
    fixture.room.tick(at(START + ROUND_MS));

    expect(watcher.take()).toEqual([]);
    expect(fixture.a.inbox.length).toBeGreaterThan(0);
  });

  it('keeps going when one connection cannot be written to', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    runners[0].send = () => {
      throw new Error('socket closed');
    };
    act(fixture.room, tagger, tag(idOf(runners[0])));
    expect(types(tagger.take())).toEqual(['update']);
    expect(types(runners[1].take())).toEqual(['update']);
  });
});

describe('disconnecting', () => {
  it('forgets the connection and leaves the player in the game', () => {
    const fixture = running();
    const { tagger, runners, idOf } = byRole(fixture);
    const gone = runners[0];
    const goneId = idOf(gone);
    const before = fixture.session.getState();

    fixture.room.disconnect(gone);

    expect(fixture.room.playerIdOf(gone)).toBeUndefined();
    expect(fixture.room.connectionCount()).toBe(2);
    // No command was issued: the very same state, the player still in it.
    expect(fixture.session.getState()).toBe(before);
    expect(before.players.find((player) => player.id === goneId)).toMatchObject({
      status: 'active',
    });
    expect(
      before.history.some(
        (entry) => entry.record.kind === 'COMMAND' && entry.record.command === 'REMOVE_PLAYER',
      ),
    ).toBe(false);

    // The others can still act on that player, and the gone connection hears nothing.
    act(fixture.room, tagger, tag(goneId));
    expect(types(tagger.take())).toEqual(['update']);
    expect(gone.take()).toEqual([]);
  });

  it('gives no way back: the old connection is a stranger, and a new one cannot be that player', () => {
    const fixture = running();
    const { runners, idOf } = byRole(fixture);
    const gone = runners[0];
    const goneId = idOf(gone);
    fixture.room.disconnect(gone);

    act(fixture.room, gone, { type: 'PLAYER_READY' });
    expect(gone.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);

    const again = connection('again');
    send(fixture.room, again, { type: 'join', joinCode: CODE, displayName: 'B', playerId: goneId });
    joinAs(fixture.room, again, 'B', NOW);
    expect(types(again.take())).toEqual(['error', 'rejected']);
    expect(fixture.room.playerIdOf(again)).toBeUndefined();
  });

  it('is harmless for a connection that never joined, or twice', () => {
    const { room } = newRoom();
    const a = connection('a');
    expect(() => {
      room.disconnect(a);
      room.disconnect(a);
    }).not.toThrow();
    expect(room.connectionCount()).toBe(0);
  });
});

describe('tick', () => {
  it('advances the game and tells every joined connection', () => {
    const fixture = running();
    const result = fixture.room.tick(at(START + ROUND_MS));
    expect(result.ok).toBe(true);
    expect(fixture.session.getState().currentRound).toBe(2);
    for (const who of [fixture.a, fixture.b, fixture.c]) {
      const [update] = who.take();
      if (update?.type !== 'update') throw new Error('expected an update');
      expect(update.state).toEqual(fixture.session.getState());
      expect(
        update.entries.map((entry) =>
          entry.record.kind === 'EVENT' ? entry.record.event.type : '',
        ),
      ).toEqual(['ROUND_END', 'ROUND_START']);
    }
  });

  it('says nothing when the time changed nothing', () => {
    const fixture = running();
    const before = fixture.session.getState();
    expect(fixture.room.tick(at(NOW)).ok).toBe(true);
    expect(fixture.session.getState()).toBe(before);
    for (const who of [fixture.a, fixture.b, fixture.c]) expect(who.take()).toEqual([]);
  });

  it('says nothing and changes nothing when the engine refuses', () => {
    const fixture = running();
    fixture.room.tick(at(NOW));
    const { tagger, runners, idOf } = byRole(fixture);
    act(fixture.room, tagger, tag(idOf(runners[0])), NOW);
    for (const who of [fixture.a, fixture.b, fixture.c]) who.take();
    const before = fixture.session.getState();

    const result = fixture.room.tick(at(NOW - 1));
    expect(result.ok).toBe(false);
    expect(fixture.session.getState()).toBe(before);
    for (const who of [fixture.a, fixture.b, fixture.c]) expect(who.take()).toEqual([]);
  });

  it('cannot be caused by a client message', () => {
    const fixture = running();
    const before = fixture.session.getState();
    for (const message of [
      { type: 'tick' },
      { type: 'action', intent: { type: 'ADVANCE_TIME' } },
      { type: 'action', intent: { type: 'TICK' } },
    ]) {
      send(fixture.room, fixture.a, message, START + ROUND_MS + 5_000);
    }
    expect(fixture.session.getState()).toBe(before);
    expect(before.currentRound).toBe(1);
  });

  it('is never called on a timer: a game left alone stays where it is', () => {
    vi.useFakeTimers();
    try {
      const fixture = running();
      const before = fixture.session.getState();
      vi.advanceTimersByTime(10 * ROUND_MS);
      expect(vi.getTimerCount()).toBe(0);
      expect(fixture.session.getState()).toBe(before);
      expect(fixture.a.take()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rooms are independent', () => {
  it('shares nothing between two rooms', () => {
    const one = newRoom(newSession('g1', CODE));
    const two = newRoom(newSession('g2', CODE));
    const [a, b] = [connection('a'), connection('b')];
    joinAs(one.room, a, 'Ada');
    joinAs(two.room, b, 'Grace');

    expect(one.session.getState().players.map((player) => player.displayName)).toEqual(['Ada']);
    expect(two.session.getState().players.map((player) => player.displayName)).toEqual(['Grace']);
    expect(one.room.playerIdOf(b)).toBeUndefined();
    expect(two.room.playerIdOf(a)).toBeUndefined();

    // A connection joined to one room is a stranger to the other.
    act(two.room, a, { type: 'PLAYER_READY' }, START);
    expect(a.inbox.at(-1)).toEqual({ type: 'error', code: 'NOT_JOINED' });
    act(one.room, a, { type: 'PLAYER_READY' }, START);
    expect(b.inbox.every((message) => message.type === 'joined')).toBe(true);
    expect(two.session.getState().players.every((player) => !player.ready)).toBe(true);
  });
});

describe('the room is synchronous and keeps transport out of the game', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const strip = (file: string): string =>
    readFileSync(join(directory, file), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('has no clock, timer, promise or socket in the room or the protocol', () => {
    for (const file of ['room.ts', 'protocol.ts']) {
      expect(strip(file), file).not.toMatch(
        /\basync\b|\bawait\b|Promise|setTimeout|setInterval|setImmediate|Date\.now|new Date|systemClock|Math\.random|from 'ws'|fetch\(/,
      );
    }
  });

  it('reaches the game only through the session', () => {
    const code = strip('room.ts');
    expect(code).not.toMatch(
      /submitPlayerAction|processPlayerAction|submitGameEvent|\breduce\(|createSession\(/,
    );
    const calls = [...code.matchAll(/session\.(\w+)\(/g)].map((match) => match[1]);
    expect([...new Set(calls)].sort()).toEqual([
      'advanceTime',
      'applyCommand',
      'applyEvent',
      'getState',
      'submitAction',
    ]);
    // The only commands the room writes itself: a join and a leave, each for the
    // connection's own player. Host commands arrive already checked against the
    // allow-list in protocol.ts and are passed through.
    expect(code.match(/type: '([A-Z_]+)'/g)).toEqual([
      "type: 'ADD_PLAYER'",
      "type: 'REMOVE_PLAYER'",
    ]);
    expect(code).not.toMatch(/ABORT_SESSION|PAUSE_SESSION|RESUME_SESSION|ADVANCE_PHASE/);
  });

  it('puts nothing about connections into the game state', () => {
    const fixture = running();
    const state: GameState = fixture.session.getState();
    expect(JSON.stringify(state)).not.toMatch(/socket|connection|transport/i);
    expect(Object.keys(state.players[0] ?? {}).sort()).toEqual(
      ['displayName', 'id', 'joinedAt', 'powers', 'ready', 'roleId', 'score', 'status'].sort(),
    );
  });
});
