import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import { type EngineContext, contextAt, gameStateSchema } from '@touchgrass/game-engine';
import { restoreGameSession } from '@touchgrass/game-session';
import { type HostedGame, createHostedGame } from './hosted-game';
import { type ServerMessage, parseClientMessage, serverMessageSchema } from './protocol';
import { type RoomConnection, createRoom } from './room';

const T0 = 1_700_000_000_000;
const at = (ms: number): EngineContext => contextAt(fixedClock(T0 + ms));
const START = 1_000;
const NOW = START + 5_000;
const CODE = 'GRASS7';

interface TestConnection extends RoomConnection {
  readonly name: string;
  readonly inbox: ServerMessage[];
  /** Every frame exactly as the room wrote it. */
  readonly raw: string[];
  take(): ServerMessage[];
  closed: boolean;
}

function connection(name: string): TestConnection {
  const inbox: ServerMessage[] = [];
  const raw: string[] = [];
  let read = 0;
  return {
    name,
    inbox,
    raw,
    closed: false,
    send(text) {
      raw.push(text);
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

/** A hosted game whose ids and tokens are predictable. */
function newGame(sessionId = 'g1', label = ''): HostedGame & { minted: string[] } {
  const minted: string[] = [];
  let players = 0;
  const game = createHostedGame(
    { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode: CODE, randomSeed: 7 },
    at(0),
    {
      createPlayerId: () => `player-${(players += 1)}`,
      createToken: () => {
        const token = `${label}secret-${minted.length}`;
        minted.push(token);
        return token;
      },
    },
  );
  if (!game.ok) throw new Error('fixture failed');
  return { ...game.value, minted };
}

type Game = ReturnType<typeof newGame>;

const send = (game: Game, who: RoomConnection, message: unknown, ms = NOW): void => {
  game.room.receive(who, JSON.stringify(message), at(ms));
};

/** Joins and returns the token the joiner was given. */
function joinAs(game: Game, who: TestConnection, displayName = who.name): string {
  send(game, who, { type: 'join', joinCode: CODE, displayName }, 0);
  const reply = who.inbox.at(-1);
  if (reply?.type !== 'joined' || reply.token === undefined) throw new Error('join failed');
  return reply.token;
}

function lobbyOf(names: string[]): { game: Game; all: TestConnection[]; tokens: string[] } {
  const game = newGame();
  const all = names.map(connection);
  const tokens = all.map((who) => joinAs(game, who));
  for (const who of all) who.take();
  return { game, all, tokens };
}

/** Three players, all ready: round 1 is running. */
function running(): ReturnType<typeof lobbyOf> {
  const fixture = lobbyOf(['a', 'b', 'c']);
  for (const who of fixture.all) {
    send(fixture.game, who, { type: 'action', intent: { type: 'PLAYER_READY' } }, START);
  }
  for (const who of fixture.all) who.take();
  return fixture;
}

function asHost(game: Game, name = 'host'): TestConnection {
  const host = connection(name);
  send(game, host, { type: 'host_auth', token: game.hostToken });
  if (host.take().at(-1)?.type !== 'host_authorized') throw new Error('host auth failed');
  return host;
}

const types = (messages: ServerMessage[]): string[] => messages.map((message) => message.type);
const errorOf = (who: TestConnection): unknown => {
  const last = who.inbox.at(-1);
  return last?.type === 'error'
    ? last.code
    : last?.type === 'rejected'
      ? last.error.code
      : last?.type;
};
const READY = { type: 'action', intent: { type: 'PLAYER_READY' } };
const command = (value: unknown) => ({ type: 'host_command', command: value });

describe('new envelopes', () => {
  it.each([
    { type: 'resume', token: 't' },
    { type: 'leave' },
    { type: 'host_auth', token: 't' },
    command({ type: 'PAUSE_SESSION', reason: 'water' }),
    command({ type: 'RESUME_SESSION' }),
    command({ type: 'ABORT_SESSION', reason: 'rain' }),
    command({ type: 'REMOVE_PLAYER', playerId: 'p1' }),
  ])('accepts $type', (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
  });

  it.each([
    ['a resume without a token', { type: 'resume' }],
    ['an empty token', { type: 'resume', token: '' }],
    ['an over-long token', { type: 'host_auth', token: 'x'.repeat(257) }],
    ['a token that is not a string', { type: 'host_auth', token: 7 }],
    ['a resume naming a player', { type: 'resume', token: 't', playerId: 'p0' }],
    ['a leave naming a player', { type: 'leave', playerId: 'p0' }],
    ['a host_auth with a session', { type: 'host_auth', token: 't', sessionId: 'g2' }],
    ['a host command with a token inline', { ...command({ type: 'RESUME_SESSION' }), token: 't' }],
    ['a host command with no command', { type: 'host_command' }],
  ])('refuses %s', (_label, message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual({
      ok: false,
      error: 'BAD_MESSAGE',
    });
  });

  it.each([
    ['add a player', { type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Mallory' }],
    ['advance the phase', { type: 'ADVANCE_PHASE' }],
    [
      'create a session',
      { type: 'CREATE_SESSION', sessionId: 'g2', gameId: 'tag', joinCode: 'X', randomSeed: 1 },
    ],
    ['submit a game event', { type: 'TIME_EXTENSION', seconds: 300 }],
    ['end the game', { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' }],
    ['report a player action', { type: 'PLAYER_TAGGED', playerId: 'p0', targetPlayerId: 'p1' }],
    ['set a score', { type: 'SET_SCORE', playerId: 'p0', score: 99 }],
    ['advance time', { type: 'ADVANCE_TIME' }],
    ['pause with extra fields', { type: 'PAUSE_SESSION', reason: 'x', status: 'completed' }],
    ['remove without a target', { type: 'REMOVE_PLAYER' }],
    ['pause without a reason', { type: 'PAUSE_SESSION' }],
  ])('has no host command to %s', (_label, value) => {
    expect(parseClientMessage(JSON.stringify(command(value))).ok).toBe(false);
  });
});

describe('player tokens', () => {
  it('gives the joiner a token once, and only the joiner', () => {
    const game = newGame();
    const [a, b] = [connection('a'), connection('b')];
    const tokenA = joinAs(game, a);
    const tokenB = joinAs(game, b);

    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).not.toBe(game.hostToken);
    // a heard about b joining: that update has no token in it.
    expect(a.raw.filter((frame) => frame.includes(tokenA))).toHaveLength(1);
    expect(a.raw.join('')).not.toContain(tokenB);
    expect(b.raw.join('')).not.toContain(tokenA);
    expect(b.raw.filter((frame) => frame.includes(tokenB))).toHaveLength(1);
  });

  it('uses 32 random bytes by default', () => {
    const game = createHostedGame(
      { type: 'CREATE_SESSION', sessionId: 'g1', gameId: 'tag', joinCode: CODE, randomSeed: 7 },
      at(0),
    );
    if (!game.ok) throw new Error('fixture failed');
    const a = connection('a');
    game.value.room.receive(
      a,
      JSON.stringify({ type: 'join', joinCode: CODE, displayName: 'A' }),
      at(0),
    );
    const reply = a.inbox[0];
    const token = reply?.type === 'joined' ? reply.token : undefined;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(game.value.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(game.value.hostToken);
  });

  it('never sends a token in an update, a rejection or an error', () => {
    const { game, all, tokens } = running();
    const host = asHost(game);
    const [a, b, c] = all as [TestConnection, TestConnection, TestConnection];
    send(game, a, {
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: 'player-2' },
    });
    send(game, b, {
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: 'player-1' },
    });
    send(game, c, { type: 'action', intent: { type: 'NOPE' } });
    send(game, host, command({ type: 'PAUSE_SESSION', reason: 'water' }));
    game.room.tick(at(NOW + 1_000));

    const secrets = [...tokens, game.hostToken];
    for (const who of [...all, host]) {
      const later = who.raw.filter((frame) => !frame.startsWith('{"type":"joined"'));
      expect(later.length).toBeGreaterThan(0);
      for (const secret of secrets) expect(later.join('')).not.toContain(secret);
    }
  });
});

describe('resume', () => {
  it('binds a new connection to the same player, without creating one', () => {
    const { game, all, tokens } = running();
    const [a] = all as [TestConnection];
    const before = game.session.getState();
    game.room.disconnect(a);

    const again = connection('a2');
    send(game, again, { type: 'resume', token: tokens[0] });

    expect(game.room.playerIdOf(again)).toBe('player-1');
    const [reply] = again.take();
    expect(reply).toMatchObject({ type: 'joined', playerId: 'player-1' });
    // The token is not sent again.
    expect(reply?.type === 'joined' && reply.token).toBeUndefined();
    expect(reply?.type === 'joined' && reply.state).toEqual(game.session.getState());
    // Nothing about the game changed, and nobody else was told.
    expect(game.session.getState()).toBe(before);
    expect(game.session.getState().players).toHaveLength(3);
    for (const other of all.slice(1)) expect(other.take()).toEqual([]);
  });

  it('lets the resumed connection act as that player', () => {
    const { game, all, tokens } = running();
    const state = game.session.getState();
    const tagger = state.players.find((player) => player.roleId === 'tagger');
    const runner = state.players.find((player) => player.roleId === 'runner');
    if (!tagger || !runner) throw new Error('fixture failed');
    const index = Number(tagger.id.slice(-1)) - 1;
    game.room.disconnect(all[index] as TestConnection);

    const again = connection('again');
    send(game, again, { type: 'resume', token: tokens[index] });
    again.take();
    send(game, again, {
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: runner.id },
    });

    const [update] = again.take();
    expect(update?.type === 'update' && update.entries[0]?.record).toEqual({
      kind: 'ACTION',
      action: { type: 'PLAYER_TAGGED', playerId: tagger.id, targetPlayerId: runner.id },
    });
  });

  it('closes the earlier connection, which can then no longer act or hear', () => {
    const { game, all, tokens } = running();
    const [old, b] = all as [TestConnection, TestConnection];
    const fresh = connection('fresh');

    send(game, fresh, { type: 'resume', token: tokens[0] });

    expect(old.closed).toBe(true);
    expect(game.room.playerIdOf(old)).toBeUndefined();
    expect(game.room.playerIdOf(fresh)).toBe('player-1');
    expect(game.room.connectionCount()).toBe(3);

    // The old connection is a stranger now.
    const before = game.session.getState();
    send(game, old, READY);
    send(game, old, {
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: 'player-2' },
    });
    send(game, old, { type: 'leave' });
    expect(old.take()).toEqual(
      Array.from({ length: 3 }, () => ({ type: 'error', code: 'NOT_JOINED' })),
    );
    expect(game.session.getState()).toBe(before);

    // And it hears nothing about the game afterwards.
    game.room.tick(at(START + 180_000));
    expect(types(b.take())).toEqual(['update']);
    expect(types(fresh.take())).toEqual(['joined', 'update']);
    expect(old.take()).toEqual([]);
  });

  it('is not undone when the closed connection reports its close late', () => {
    const { game, all, tokens } = running();
    const [old] = all as [TestConnection];
    const fresh = connection('fresh');
    send(game, fresh, { type: 'resume', token: tokens[0] });
    // The adapter delivers the old socket's close event after the resume.
    game.room.disconnect(old);
    expect(game.room.playerIdOf(fresh)).toBe('player-1');
    expect(game.room.connectionCount()).toBe(3);
  });

  it('can be repeated: each resume replaces the one before', () => {
    const { game, tokens } = running();
    const [first, second] = [connection('first'), connection('second')];
    send(game, first, { type: 'resume', token: tokens[1] });
    send(game, second, { type: 'resume', token: tokens[1] });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(game.room.playerIdOf(second)).toBe('player-2');
    expect(game.room.connectionCount()).toBe(3);
  });

  it.each([
    ['a token nobody was given', 'nope'],
    ['a player id', 'player-1'],
    ['the join code', CODE],
    ['an empty-looking token', ' '],
  ])('refuses %s', (_label, token) => {
    const { game } = running();
    const stranger = connection('stranger');
    send(game, stranger, { type: 'resume', token });
    expect(stranger.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(game.room.playerIdOf(stranger)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(3);
  });

  it('refuses a connection that is already a player', () => {
    const { game, all, tokens } = running();
    const [a] = all as [TestConnection];
    send(game, a, { type: 'resume', token: tokens[1] });
    expect(a.take()).toEqual([{ type: 'error', code: 'ALREADY_JOINED' }]);
    expect(game.room.playerIdOf(a)).toBe('player-1');
    expect((all[1] as TestConnection).closed).toBe(false);
  });

  it('refuses the token of a player the host removed', () => {
    const { game, all, tokens } = running();
    const host = asHost(game);
    send(game, host, command({ type: 'REMOVE_PLAYER', playerId: 'player-2' }));
    expect(game.session.getState().players[1]?.status).toBe('left');

    const again = connection('again');
    send(game, again, { type: 'resume', token: tokens[1] });
    expect(again.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    // The removed player's old connection is no longer a player either.
    expect(game.room.playerIdOf(all[1] as TestConnection)).toBeUndefined();
  });

  it('refuses the token of a player removed by server code, even though the room was not told', () => {
    const { game, tokens } = running();
    game.session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'player-3' }, at(NOW));
    const again = connection('again');
    send(game, again, { type: 'resume', token: tokens[2] });
    expect(again.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
  });

  it('works after the game has ended, to read the result', () => {
    const { game, all, tokens } = running();
    game.room.tick(at(START + 3 * 180_000));
    game.room.disconnect(all[0] as TestConnection);
    const again = connection('again');
    send(game, again, { type: 'resume', token: tokens[0] }, START + 3 * 180_000 + 1);
    const [reply] = again.take();
    expect(reply?.type === 'joined' && reply.state.status).toBe('completed');
  });
});

describe('disconnect', () => {
  it('keeps the player and the token, and tells nobody', () => {
    const { game, all, tokens } = running();
    const [a, b, c] = all as [TestConnection, TestConnection, TestConnection];
    const before = game.session.getState();

    game.room.disconnect(a);

    expect(game.session.getState()).toBe(before);
    expect(before.players[0]).toMatchObject({ id: 'player-1', status: 'active' });
    expect(b.take()).toEqual([]);
    expect(c.take()).toEqual([]);
    expect(game.room.connectionCount()).toBe(2);

    // The token still works, more than once over time.
    for (const name of ['one', 'two']) {
      const again = connection(name);
      send(game, again, { type: 'resume', token: tokens[0] });
      expect(game.room.playerIdOf(again)).toBe('player-1');
      game.room.disconnect(again);
    }
  });
});

describe('leave', () => {
  it('removes the player in the lobby and tells everyone, including the leaver', () => {
    const { game, all } = lobbyOf(['a', 'b', 'c']);
    const [a, b, c] = all as [TestConnection, TestConnection, TestConnection];

    send(game, b, { type: 'leave' }, 500);

    const state = game.session.getState();
    expect(state.players.map((player) => player.status)).toEqual(['active', 'left', 'active']);
    expect(state.history.at(-1)?.record).toMatchObject({
      kind: 'COMMAND',
      command: 'REMOVE_PLAYER',
    });
    for (const who of [a, b, c]) {
      const [update] = who.take();
      if (update?.type !== 'update') throw new Error('expected an update');
      expect(update.state).toEqual(state);
      expect(update.entries).toEqual(state.history.slice(-1));
    }
    expect(game.room.playerIdOf(b)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(2);
  });

  it('invalidates the token, and the connection becomes a stranger', () => {
    const { game, all, tokens } = lobbyOf(['a', 'b']);
    const [, b] = all as [TestConnection, TestConnection];
    send(game, b, { type: 'leave' }, 500);
    b.take();

    send(game, b, READY);
    send(game, b, { type: 'resume', token: tokens[1] });
    expect(b.take()).toEqual([
      { type: 'error', code: 'NOT_JOINED' },
      { type: 'error', code: 'INVALID_TOKEN' },
    ]);
    const other = connection('other');
    send(game, other, { type: 'resume', token: tokens[1] });
    expect(other.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    // It hears nothing more about the game.
    send(game, all[0] as TestConnection, READY, START);
    expect(b.take()).toEqual([]);
  });

  it('frees the place: a full lobby has room again', () => {
    const { game, all } = lobbyOf(['a', 'b', 'c', 'd']);
    const extra = connection('extra');
    send(game, extra, { type: 'join', joinCode: CODE, displayName: 'E' }, 0);
    expect(errorOf(extra)).toBe('PLAYER_LIMIT_EXCEEDED');

    send(game, all[3] as TestConnection, { type: 'leave' }, 500);
    send(game, extra, { type: 'join', joinCode: CODE, displayName: 'E' }, 600);
    expect(extra.inbox.at(-1)).toMatchObject({ type: 'joined' });
    // The leaver can come back too, as a new player with a new id and token.
    expect(game.session.getState().players).toHaveLength(5);
  });

  it('affects only the sender: there is no way to name someone else', () => {
    const { game, all } = lobbyOf(['a', 'b']);
    const [a] = all as [TestConnection];
    send(game, a, { type: 'leave', playerId: 'player-2' }, 500);
    expect(a.take()).toEqual([{ type: 'error', code: 'BAD_MESSAGE' }]);
    expect(game.session.getState().players.every((player) => player.status === 'active')).toBe(
      true,
    );
  });

  it('is refused from a connection that is not a player', () => {
    const { game } = lobbyOf(['a']);
    const stranger = connection('stranger');
    send(game, stranger, { type: 'leave' });
    expect(stranger.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
  });

  it('is refused once the game is running, and changes nothing', () => {
    const { game, all, tokens } = running();
    const [a, b] = all as [TestConnection, TestConnection];
    const before = game.session.getState();

    send(game, a, { type: 'leave' });

    expect(a.take()).toEqual([{ type: 'error', code: 'CANNOT_LEAVE' }]);
    expect(game.session.getState()).toBe(before);
    expect(b.take()).toEqual([]);
    // Still a player, token still good.
    expect(game.room.playerIdOf(a)).toBe('player-1');
    game.room.disconnect(a);
    const again = connection('again');
    send(game, again, { type: 'resume', token: tokens[0] });
    expect(game.room.playerIdOf(again)).toBe('player-1');
  });

  it('is refused while paused, after the game ends, and after an abort', () => {
    const paused = running();
    const host = asHost(paused.game);
    send(paused.game, host, command({ type: 'PAUSE_SESSION', reason: 'water' }));
    expect(paused.game.session.getState().status).toBe('paused');
    send(paused.game, paused.all[0] as TestConnection, { type: 'leave' }, NOW + 1_000);
    expect(errorOf(paused.all[0] as TestConnection)).toBe('CANNOT_LEAVE');

    send(paused.game, host, command({ type: 'ABORT_SESSION', reason: 'rain' }), NOW + 2_000);
    send(paused.game, paused.all[1] as TestConnection, { type: 'leave' }, NOW + 3_000);
    expect(errorOf(paused.all[1] as TestConnection)).toBe('CANNOT_LEAVE');

    const finished = running();
    finished.game.room.tick(at(START + 3 * 180_000));
    send(
      finished.game,
      finished.all[0] as TestConnection,
      { type: 'leave' },
      START + 3 * 180_000 + 1,
    );
    expect(errorOf(finished.all[0] as TestConnection)).toBe('CANNOT_LEAVE');
    expect(
      finished.game.session.getState().players.every((player) => player.status !== 'left'),
    ).toBe(true);
  });
});

describe('the host', () => {
  it('is created with the game: a host token comes back to the creator', () => {
    const game = newGame();
    expect(game.hostToken).toBe('secret-0');
    expect(game.session.getState().status).toBe('lobby');
    expect(gameStateSchema.safeParse(game.session.getState()).success).toBe(true);
  });

  it('refuses to create a game that is not valid, and makes no token for it', () => {
    const result = createHostedGame(
      {
        type: 'CREATE_SESSION',
        sessionId: 'g1',
        gameId: 'quidditch',
        joinCode: CODE,
        randomSeed: 7,
      },
      at(0),
    );
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).not.toContain('value');
  });

  it('authorises the connection that presents the host token', () => {
    const { game, all } = running();
    const host = connection('host');
    send(game, host, { type: 'host_auth', token: game.hostToken });

    expect(game.room.isHost(host)).toBe(true);
    const [reply] = host.take();
    expect(reply?.type === 'host_authorized' && reply.state).toEqual(game.session.getState());
    // Nobody else is told, and the host is not a player.
    for (const who of all) expect(who.take()).toEqual([]);
    expect(game.room.playerIdOf(host)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(3);
  });

  it.each([
    ['a wrong token', 'nope'],
    ['a prefix of the token', 'secret-'],
    ['the token with a suffix', 'secret-0x'],
    ['the join code', CODE],
    ['the session id', 'g1'],
  ])('refuses %s', (_label, token) => {
    const game = newGame();
    const who = connection('who');
    send(game, who, { type: 'host_auth', token });
    expect(who.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(game.room.isHost(who)).toBe(false);
  });

  it('keeps player tokens and the host token apart', () => {
    const { game, all, tokens } = running();
    const [a] = all as [TestConnection];
    // A player token is not the host token.
    send(game, a, { type: 'host_auth', token: tokens[0] });
    expect(a.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(game.room.isHost(a)).toBe(false);
    // The host token is not a player token.
    const who = connection('who');
    send(game, who, { type: 'resume', token: game.hostToken });
    expect(who.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(game.room.playerIdOf(who)).toBeUndefined();
  });

  it('refuses a second connection with the same token while one is the host', () => {
    const { game } = running();
    const host = asHost(game);
    const second = connection('second');
    send(game, second, { type: 'host_auth', token: game.hostToken });

    expect(second.take()).toEqual([{ type: 'error', code: 'HOST_ALREADY_CONNECTED' }]);
    expect(game.room.isHost(second)).toBe(false);
    expect(game.room.isHost(host)).toBe(true);
    expect(host.closed).toBe(false);
    // The refused connection cannot command.
    send(game, second, command({ type: 'ABORT_SESSION', reason: 'mine now' }));
    expect(second.take()).toEqual([{ type: 'error', code: 'NOT_HOST' }]);
    expect(game.session.getState().status).toBe('active');
  });

  it('does not reveal whether a host is connected to someone with a wrong token', () => {
    const { game } = running();
    asHost(game);
    const prober = connection('prober');
    send(game, prober, { type: 'host_auth', token: 'guess' });
    expect(prober.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
  });

  it('can authenticate again after disconnecting, and the game is not stopped meanwhile', () => {
    const { game, all } = running();
    const host = asHost(game);
    const before = game.session.getState();

    game.room.disconnect(host);

    expect(game.room.isHost(host)).toBe(false);
    expect(game.session.getState()).toBe(before);
    expect(before.status).toBe('active');
    for (const who of all) expect(who.take()).toEqual([]);
    // The forgotten connection cannot command.
    send(game, host, command({ type: 'ABORT_SESSION', reason: 'x' }));
    expect(errorOf(host)).toBe('NOT_HOST');

    const back = asHost(game, 'back');
    expect(game.room.isHost(back)).toBe(true);
  });

  it('may also be a player on the same connection, and is told once per change', () => {
    const { game, all } = lobbyOf(['a', 'b']);
    const [a, b] = all as [TestConnection, TestConnection];
    send(game, a, { type: 'host_auth', token: game.hostToken });
    a.take();
    send(game, b, READY, START);
    expect(types(a.take())).toEqual(['update']);
    expect(game.room.isHost(a)).toBe(true);
    expect(game.room.playerIdOf(a)).toBe('player-1');
  });

  it('hears updates without being a player', () => {
    const { game, all } = lobbyOf(['a', 'b']);
    const host = asHost(game);
    send(game, all[0] as TestConnection, READY, START);
    expect(types(host.take())).toEqual(['update']);
    send(game, host, READY, START);
    expect(host.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
  });
});

describe('host commands', () => {
  it('pauses, resumes and aborts through the session, and tells everyone', () => {
    const { game, all } = running();
    const host = asHost(game);
    const everyone = [...all, host];

    const steps: [unknown, string, string][] = [
      [{ type: 'PAUSE_SESSION', reason: 'water break' }, 'paused', 'PAUSE_SESSION'],
      [{ type: 'RESUME_SESSION' }, 'active', 'RESUME_SESSION'],
      [{ type: 'ABORT_SESSION', reason: 'thunder' }, 'aborted', 'ABORT_SESSION'],
    ];
    for (const [index, [value, status, name]] of steps.entries()) {
      send(game, host, command(value), NOW + index * 1_000);

      const state = game.session.getState();
      expect(state.status).toBe(status);
      expect(state.history.at(-1)).toMatchObject({
        source: 'human',
        record: { kind: 'COMMAND', command: name },
      });
      for (const who of everyone) {
        const [update] = who.take();
        if (update?.type !== 'update') throw new Error(`expected an update for ${name}`);
        expect(update.state).toEqual(state);
        expect(update.entries).toEqual(state.history.slice(-1));
      }
    }
    expect(game.session.getState().endedAt).toBe(T0 + NOW + 2_000);
  });

  it('gives exactly what the trusted command boundary gives', () => {
    const viaWire = running();
    const host = asHost(viaWire.game);
    send(viaWire.game, host, command({ type: 'PAUSE_SESSION', reason: 'water' }));

    const direct = running();
    direct.game.session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW));

    expect(viaWire.game.session.getState()).toEqual(direct.game.session.getState());
  });

  it('removes a player by id, mid-game too, and that player is no longer a connection', () => {
    const { game, all, tokens } = running();
    const host = asHost(game);
    const [a, b, c] = all as [TestConnection, TestConnection, TestConnection];

    send(game, host, command({ type: 'REMOVE_PLAYER', playerId: 'player-2' }));

    const state = game.session.getState();
    expect(state.players.map((player) => player.status)).toEqual(['active', 'left', 'active']);
    // Everyone, including the removed player, gets this one update.
    for (const who of [a, b, c, host]) expect(types(who.take())).toEqual(['update']);
    expect(game.room.playerIdOf(b)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(2);
    send(game, b, READY);
    send(game, b, { type: 'resume', token: tokens[1] });
    expect(b.take()).toEqual([
      { type: 'error', code: 'NOT_JOINED' },
      { type: 'error', code: 'INVALID_TOKEN' },
    ]);
    game.room.tick(at(START + 180_000));
    expect(b.take()).toEqual([]);
  });

  it('answers a refused command to the host only, and changes nothing', () => {
    const { game, all } = running();
    const host = asHost(game);
    const before = game.session.getState();

    for (const value of [
      { type: 'RESUME_SESSION' }, // not paused
      { type: 'REMOVE_PLAYER', playerId: 'ghost' },
      { type: 'REMOVE_PLAYER', playerId: game.hostToken },
    ]) {
      send(game, host, command(value));
    }

    expect(host.take()).toMatchObject([
      { type: 'rejected', error: { code: 'INVALID_STATE_TRANSITION' } },
      { type: 'rejected', error: { code: 'INVALID_PLAYER' } },
      { type: 'rejected', error: { code: 'INVALID_PLAYER' } },
    ]);
    expect(game.session.getState()).toBe(before);
    for (const who of all) expect(who.take()).toEqual([]);
  });

  it('is refused from a player, with or without a token in hand', () => {
    const { game, all, tokens } = running();
    const [a, b] = all as [TestConnection, TestConnection];
    const before = game.session.getState();

    for (const value of [
      { type: 'ABORT_SESSION', reason: 'I am losing' },
      { type: 'PAUSE_SESSION', reason: 'x' },
      { type: 'REMOVE_PLAYER', playerId: 'player-2' },
      { type: 'REMOVE_PLAYER', playerId: 'player-1' },
    ]) {
      send(game, a, command(value));
    }
    expect(a.take()).toEqual(
      Array.from({ length: 4 }, () => ({ type: 'error', code: 'NOT_HOST' })),
    );

    // Presenting a player token as the host token does not help.
    send(game, a, { type: 'host_auth', token: tokens[0] });
    send(game, a, command({ type: 'ABORT_SESSION', reason: 'x' }));
    expect(types(a.take())).toEqual(['error', 'error']);

    // Nor does putting a command where an intent goes.
    send(game, a, { type: 'action', intent: { type: 'ABORT_SESSION', reason: 'x' } });
    expect(errorOf(a)).toBe('INVALID_ACTION');

    expect(game.session.getState()).toBe(before);
    expect(b.take()).toEqual([]);
  });

  it('is refused from a stranger', () => {
    const { game } = running();
    const stranger = connection('stranger');
    send(game, stranger, command({ type: 'ABORT_SESSION', reason: 'x' }));
    expect(stranger.take()).toEqual([{ type: 'error', code: 'NOT_HOST' }]);
    expect(game.session.getState().status).toBe('active');
  });

  it('cannot be sent at all in a room made without a host token', () => {
    const { session } = newGame();
    const room = createRoom({ session });
    const who = connection('who');
    for (const token of ['', 'undefined', 'secret-0', 'x']) {
      room.receive(who, JSON.stringify({ type: 'host_auth', token }), at(NOW));
    }
    room.receive(who, JSON.stringify(command({ type: 'ABORT_SESSION', reason: 'x' })), at(NOW));
    expect(
      who.inbox.map((message) => (message.type === 'error' ? message.code : message.type)),
    ).toEqual(['BAD_MESSAGE', 'INVALID_TOKEN', 'INVALID_TOKEN', 'INVALID_TOKEN', 'NOT_HOST']);
    expect(room.isHost(who)).toBe(false);
  });
});

describe('capabilities stay inside one game and outside the state', () => {
  it('keeps every token out of the game state and its history', () => {
    const { game, all, tokens } = running();
    const host = asHost(game);
    send(game, host, command({ type: 'PAUSE_SESSION', reason: 'water' }));
    send(game, host, command({ type: 'RESUME_SESSION' }), NOW + 1_000);
    game.room.disconnect(all[0] as TestConnection);
    send(game, connection('again'), { type: 'resume', token: tokens[0] }, NOW + 2_000);

    const state = game.session.getState();
    const text = JSON.stringify(state);
    for (const secret of [...tokens, game.hostToken]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/token|host_auth|hostToken|connection|socket/i);
    expect(Object.keys(state).sort()).toEqual(Object.keys(gameStateSchema.shape).sort());
    expect(gameStateSchema.safeParse(state).success).toBe(true);
  });

  it('gives two games different tokens that do not work in each other', () => {
    const one = newGame('g1', 'one-');
    const two = newGame('g2', 'two-');
    const [a, b] = [connection('a'), connection('b')];
    const tokenA = joinAs(one, a);
    const tokenB = joinAs(two, b);
    expect(one.hostToken).not.toBe(two.hostToken);
    expect(tokenA).not.toBe(tokenB);

    // A player token from one game is nothing in the other.
    const crossPlayer = connection('cross-player');
    send(two, crossPlayer, { type: 'resume', token: tokenA });
    expect(crossPlayer.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);

    // A host token from one game is nothing in the other.
    const crossHost = connection('cross-host');
    send(two, crossHost, { type: 'host_auth', token: one.hostToken });
    expect(crossHost.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    send(two, crossHost, command({ type: 'ABORT_SESSION', reason: 'x' }));
    expect(two.session.getState().status).toBe('lobby');

    // Each works where it was issued, and only there.
    send(one, connection('h1'), { type: 'host_auth', token: one.hostToken });
    send(one, asHost(two, 'h2'), command({ type: 'ABORT_SESSION', reason: 'x' }));
    expect(one.session.getState().status).toBe('lobby');
    expect(two.session.getState().players).toHaveLength(1);
    expect(one.session.getState().players).toHaveLength(1);
  });

  it('does not let identical tokens in two games cross over', () => {
    // Even if two games happened to issue the same strings, a token is looked up
    // in the room it was presented to and nowhere else.
    const one = newGame('g1');
    const two = newGame('g2');
    const a = connection('a');
    const tokenA = joinAs(one, a);
    expect(one.hostToken).toBe(two.hostToken);

    const cross = connection('cross');
    send(two, cross, { type: 'resume', token: tokenA });
    expect(cross.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(two.session.getState().players).toEqual([]);

    asHost(one);
    // Being the host of one game means nothing in the other room.
    const hostOfTwo = asHost(two, 'h2');
    send(two, hostOfTwo, command({ type: 'ABORT_SESSION', reason: 'x' }));
    expect(two.session.getState().status).toBe('aborted');
    expect(one.session.getState().status).toBe('lobby');
  });

  it('keeps no table of games or tokens outside a room', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(directory).filter(
      (name) => name.endsWith('.ts') && !name.includes('.test.'),
    );
    expect(sources).toEqual(
      expect.arrayContaining(['hosted-game.ts', 'protocol.ts', 'room.ts', 'ws-server.ts']),
    );
    for (const name of sources) {
      const code = readFileSync(join(directory, name), 'utf-8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      );
      // Nothing mutable at module level: no `let`/`var`, and no collection
      // created outside a function.
      const topLevel = code
        .split('\n')
        .filter(
          (line) => /^(export )?(let|var)\s/.test(line) || /^(export )?const \w+ = new /.test(line),
        );
      expect(topLevel, name).toEqual([]);
    }
  });

  it('logs a token in one place only: the development entry point', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const name of ['room.ts', 'protocol.ts', 'ws-server.ts', 'hosted-game.ts']) {
      expect(readFileSync(join(directory, name), 'utf-8'), name).not.toMatch(/console\.|logger/);
    }
    const dev = readFileSync(join(directory, 'dev.ts'), 'utf-8');
    expect(dev.match(/hostToken/g)).toHaveLength(1);
  });
});

describe('a player removed behind the room', () => {
  /** Trusted server code removes a player through the session, not the room. */
  function removedDirectly(): ReturnType<typeof running> & {
    gone: TestConnection;
    goneToken: string;
    others: TestConnection[];
  } {
    const fixture = running();
    const [first, gone, third] = fixture.all as [TestConnection, TestConnection, TestConnection];
    const removed = fixture.game.session.applyCommand(
      { type: 'REMOVE_PLAYER', playerId: 'player-2' },
      at(NOW),
    );
    if (!removed.ok) throw new Error('fixture failed');
    return { ...fixture, gone, goneToken: fixture.tokens[1] as string, others: [first, third] };
  }

  /** Makes someone still in the game cause an update, by a tag if there is a tagger. */
  function causeUpdate(game: Game, others: TestConnection[], ms: number): void {
    const state = game.session.getState();
    const playing = state.players.filter((player) => player.status !== 'left');
    const tagger = playing.find((player) => player.roleId === 'tagger');
    const target = playing.find((player) => player.roleId === 'runner');
    const actor = others.find((who) => game.room.playerIdOf(who) === tagger?.id);
    if (tagger && target && actor) {
      send(
        game,
        actor,
        { type: 'action', intent: { type: 'PLAYER_TAGGED', targetPlayerId: target.id } },
        ms,
      );
    } else {
      // The removed player was the tagger: a round ending is an update too.
      game.room.tick(at(START + 180_000));
    }
  }

  it('is stale until the room next handles something: nothing watches the session', () => {
    const { game, gone } = removedDirectly();
    expect(game.session.getState().players[1]?.status).toBe('left');
    // No timer, callback or subscription told the room.
    expect(game.room.playerIdOf(gone)).toBe('player-2');
    expect(gone.take()).toEqual([]);
  });

  it('is unbound when their connection next sends an action, which never reaches the game', () => {
    const { game, gone, others } = removedDirectly();
    const before = game.session.getState();

    send(
      game,
      gone,
      { type: 'action', intent: { type: 'PLAYER_TAGGED', targetPlayerId: 'player-1' } },
      NOW + 1_000,
    );

    // NOT_JOINED is the room's answer. Had the action reached the session, the
    // engine would have answered `rejected` with INVALID_PLAYER instead.
    expect(gone.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
    expect(game.room.playerIdOf(gone)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(2);
    expect(game.session.getState()).toBe(before);
    for (const who of others) expect(who.take()).toEqual([]);

    // And again: it stays a stranger.
    send(game, gone, READY, NOW + 2_000);
    expect(gone.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
  });

  it('is unbound when someone else causes an update, and is sent neither that one nor any later', () => {
    const { game, gone, others } = removedDirectly();

    causeUpdate(game, others, NOW + 1_000);

    for (const who of others) expect(types(who.take())).toEqual(['update']);
    expect(gone.take()).toEqual([]);
    expect(game.room.playerIdOf(gone)).toBeUndefined();

    game.room.tick(at(START + 2 * 180_000));
    const host = asHost(game);
    send(
      game,
      host,
      command({ type: 'PAUSE_SESSION', reason: 'water' }),
      START + 2 * 180_000 + 1_000,
    );
    for (const who of others) expect(who.take().length).toBeGreaterThan(0);
    expect(gone.take()).toEqual([]);
  });

  it('is unbound by a tick, before the update goes out', () => {
    const { game, gone, others } = removedDirectly();
    game.room.tick(at(START + 180_000));
    for (const who of others) expect(types(who.take())).toEqual(['update']);
    expect(gone.take()).toEqual([]);
    expect(game.room.playerIdOf(gone)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(2);
  });

  it('cannot resume with the old token, from a new connection or the old one', () => {
    const { game, gone, goneToken } = removedDirectly();
    const fresh = connection('fresh');
    send(game, fresh, { type: 'resume', token: goneToken }, NOW + 1_000);
    expect(fresh.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(game.room.playerIdOf(fresh)).toBeUndefined();

    // That frame reconciled the room, so the old connection is a stranger too,
    // and its resume is judged on the token, which is gone.
    expect(game.room.playerIdOf(gone)).toBeUndefined();
    send(game, gone, { type: 'resume', token: goneToken }, NOW + 2_000);
    expect(gone.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    expect(game.room.connectionCount()).toBe(2);
  });

  it('cannot leave: they are no longer a player of this room', () => {
    const fixture = lobbyOf(['a', 'b', 'c']);
    const gone = fixture.all[1] as TestConnection;
    fixture.game.session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'player-2' }, at(100));
    const before = fixture.game.session.getState();

    send(fixture.game, gone, { type: 'leave' }, 500);

    // Not CANNOT_LEAVE and not an engine rejection: the room no longer knows them.
    expect(gone.take()).toEqual([{ type: 'error', code: 'NOT_JOINED' }]);
    expect(fixture.game.session.getState()).toBe(before);
    expect(fixture.game.room.playerIdOf(gone)).toBeUndefined();
  });

  it('may join again in the lobby, as a new player with a new token', () => {
    const fixture = lobbyOf(['a', 'b']);
    const gone = fixture.all[1] as TestConnection;
    fixture.game.session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'player-2' }, at(100));

    send(fixture.game, gone, { type: 'join', joinCode: CODE, displayName: 'B again' }, 500);
    const reply = gone.take().at(-1);
    expect(reply).toMatchObject({ type: 'joined', playerId: 'player-3' });
    expect(reply?.type === 'joined' && reply.token).not.toBe(fixture.tokens[1]);
  });

  it('leaves everyone else exactly as they were', () => {
    const { game, all, tokens, others } = removedDirectly();
    game.room.tick(at(START + 180_000));
    for (const who of others) who.take();

    // Players still in the game act and hear as before.
    send(
      game,
      others[0] as TestConnection,
      { type: 'action', intent: { type: 'NOPE' } },
      START + 181_000,
    );
    expect((others[0] as TestConnection).take()).toMatchObject([
      { type: 'rejected', error: { code: 'INVALID_ACTION' } },
    ]);
    game.room.tick(at(START + 2 * 180_000));
    for (const who of others) expect(types(who.take())).toEqual(['update']);

    // A player who was not removed can still drop and resume.
    const a = all[0] as TestConnection;
    game.room.disconnect(a);
    const again = connection('again');
    send(game, again, { type: 'resume', token: tokens[0] }, START + 2 * 180_000 + 1_000);
    expect(again.take()).toMatchObject([{ type: 'joined', playerId: 'player-1' }]);
    expect(game.room.connectionCount()).toBe(2);
  });

  it('still removes at once when the host does it through the room', () => {
    const { game, all, tokens } = running();
    const host = asHost(game);
    const [a, b, c] = all as [TestConnection, TestConnection, TestConnection];

    send(game, host, command({ type: 'REMOVE_PLAYER', playerId: 'player-2' }));

    // Unbound and token gone immediately, with no further frame needed.
    expect(game.room.playerIdOf(b)).toBeUndefined();
    expect(game.room.connectionCount()).toBe(2);
    // The removed player is told about their own removal, once.
    for (const who of [a, b, c, host]) expect(types(who.take())).toEqual(['update']);
    const fresh = connection('fresh');
    send(game, fresh, { type: 'resume', token: tokens[1] });
    expect(fresh.take()).toEqual([{ type: 'error', code: 'INVALID_TOKEN' }]);
    game.room.tick(at(START + 180_000));
    expect(b.take()).toEqual([]);
  });

  it('still tells a leaver about their own leaving, once', () => {
    const { game, all } = lobbyOf(['a', 'b']);
    const [a, b] = all as [TestConnection, TestConnection];
    send(game, b, { type: 'leave' }, 500);
    expect(types(b.take())).toEqual(['update']);
    expect(types(a.take())).toEqual(['update']);
    send(game, a, READY, START);
    expect(b.take()).toEqual([]);
  });

  it('adds no timer, subscription or module-level state to do it', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(join(directory, 'room.ts'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    expect(code).not.toMatch(
      /setTimeout|setInterval|setImmediate|queueMicrotask|\basync\b|\bawait\b|Promise|subscribe|addListener|\.on\(|EventEmitter|observe/i,
    );
    expect(code.match(/const reconcile = /g)).toHaveLength(1);
  });
});

describe('the session snapshot and the room', () => {
  it('contains no token, host capability or connection, however the room has been used', () => {
    const { game, all, tokens } = running();
    const host = asHost(game);
    send(game, host, command({ type: 'PAUSE_SESSION', reason: 'water' }));
    send(game, host, command({ type: 'RESUME_SESSION' }), NOW + 1_000);
    game.room.disconnect(all[0] as TestConnection);
    send(game, connection('again'), { type: 'resume', token: tokens[0] }, NOW + 2_000);

    const snapshot = game.session.snapshot();
    const text = JSON.stringify(snapshot);
    for (const secret of [...tokens, game.hostToken]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/token|host_auth|hostToken|connection|socket/i);
    expect(Object.keys(snapshot).sort()).toEqual(['sessionId', 'state', 'version']);
    expect(Object.keys(snapshot.state).sort()).toEqual(Object.keys(gameStateSchema.shape).sort());
    expect(snapshot.state).toEqual(game.session.getState());
  });

  it('restores the game and none of the room: capabilities do not come back', () => {
    const { game, tokens } = running();
    const stored: unknown = JSON.parse(JSON.stringify(game.session.snapshot()));
    const restored = restoreGameSession(stored);
    if (!restored.ok) throw new Error('restore failed');
    expect(restored.value.getState()).toEqual(game.session.getState());

    // A room around the restored session is a new room. It knows no player
    // token and no connection, and the old host token is not its own.
    const room = createRoom({ session: restored.value, hostToken: 'a-new-host-token' });
    const returning = connection('returning');
    room.receive(returning, JSON.stringify({ type: 'resume', token: tokens[0] }), at(NOW));
    room.receive(returning, JSON.stringify({ type: 'host_auth', token: game.hostToken }), at(NOW));
    expect(returning.take()).toEqual([
      { type: 'error', code: 'INVALID_TOKEN' },
      { type: 'error', code: 'INVALID_TOKEN' },
    ]);
    expect(room.connectionCount()).toBe(0);
    // The players are all still in the restored game.
    expect(restored.value.getState().players.map((player) => player.status)).toEqual([
      'active',
      'active',
      'active',
    ]);
  });

  it('is not changed by taking a snapshot: play carries on', () => {
    const { game, all } = running();
    const before = game.session.getState();
    game.session.snapshot();
    expect(game.session.getState()).toBe(before);
    game.room.tick(at(START + 180_000));
    for (const who of all) expect(types(who.take())).toEqual(['update']);
  });
});
