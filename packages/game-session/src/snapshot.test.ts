import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import {
  type EngineContext,
  type GameState,
  contextAt,
  gameStateSchema,
} from '@touchgrass/game-engine';
import {
  type GameSession,
  type GameSessionSnapshot,
  SNAPSHOT_VERSION,
  createGameSession,
  restoreGameSession,
} from './session';

const T0 = 1_700_000_000_000;
const at = (ms: number): EngineContext => contextAt(fixedClock(T0 + ms));
const START = 1_000;
const NOW = START + 5_000;
const ROUND_MS = 180_000;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

const codeOf = (result: { ok: true } | { ok: false; error: { code: string } }): string =>
  result.ok ? 'ok' : result.error.code;

const READY = { type: 'PLAYER_READY' };
const tag = (targetPlayerId: string) => ({ type: 'PLAYER_TAGGED', targetPlayerId });

function lobbySession(sessionId = 'g1', gameId = 'tag'): GameSession {
  const session = unwrap(
    createGameSession(
      { type: 'CREATE_SESSION', sessionId, gameId, joinCode: 'GRASS7', randomSeed: 7 },
      at(0),
    ),
  );
  for (const index of [0, 1, 2]) {
    unwrap(
      session.applyCommand(
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  return session;
}

function runningSession(sessionId = 'g1', gameId = 'tag'): GameSession {
  const session = lobbySession(sessionId, gameId);
  for (const index of [0, 1, 2]) unwrap(session.submitAction(`p${index}`, READY, at(START)));
  return session;
}

function roles(state: GameState): { tagger: string; r1: string; r2: string } {
  const ids = (roleId: string) =>
    state.players.filter((player) => player.roleId === roleId).map((player) => player.id);
  const [tagger] = ids('tagger');
  const [r1, r2] = ids('runner');
  if (!tagger || !r1 || !r2) throw new Error('fixture failed');
  return { tagger, r1, r2 };
}

/** A running game with a tag made, so the history has actions, events and awards in it. */
function played(): GameSession {
  const session = runningSession();
  const { tagger, r1 } = roles(session.getState());
  unwrap(session.submitAction(tagger, tag(r1), at(NOW)));
  return session;
}

/** A snapshot as it would come back from storage: plain, mutable, unrelated objects. */
function stored(session: GameSession): {
  version: number;
  sessionId: string;
  state: GameState & Record<string, unknown>;
} {
  return JSON.parse(JSON.stringify(session.snapshot())) as never;
}

describe('snapshot', () => {
  it('is the session id, the layout version and the authoritative state', () => {
    const session = played();
    const snapshot = session.snapshot();

    expect(Object.keys(snapshot).sort()).toEqual(['sessionId', 'state', 'version']);
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.sessionId).toBe('g1');
    expect(snapshot.sessionId).toBe(session.id);
    expect(snapshot.state).toEqual(session.getState());
    expect(gameStateSchema.safeParse(snapshot.state).success).toBe(true);
  });

  it('carries the history inside the state, complete and in order, and nowhere else', () => {
    const session = played();
    const { state } = session.snapshot();

    expect(state.history).toEqual(session.getState().history);
    expect(state.history.map((entry) => entry.sequence)).toEqual(
      state.history.map((_, index) => index),
    );
    const kinds = state.history.map((entry) =>
      entry.record.kind === 'EVENT'
        ? entry.record.event.type
        : entry.record.kind === 'COMMAND'
          ? entry.record.command
          : entry.record.kind,
    );
    expect(kinds).toEqual([
      'CREATE_SESSION',
      'ADD_PLAYER',
      'ADD_PLAYER',
      'ADD_PLAYER',
      'ACTION',
      'ACTION',
      'ACTION',
      'ROLES_ASSIGNED',
      'ROUND_START',
      'ACTION',
      'ROLE_CHANGE',
    ]);
    expect(state.history.at(-1)?.awards).toEqual([
      expect.objectContaining({ reason: 'TAG_MADE', points: 2 }),
    ]);
    // There is no second log beside the state.
    expect(JSON.stringify(Object.keys(session.snapshot()))).not.toMatch(/history|events|log/);
  });

  it('cannot be used to change the session', () => {
    const session = played();
    const before = session.getState();
    const copy = structuredClone(before);
    const snapshot = session.snapshot() as unknown as {
      version: number;
      sessionId: string;
      state: {
        status: string;
        players: { score: number; roleId: string; powers: string[] }[];
        history: { summary: string; record: { kind: string } }[];
        timer: { endsAt: number };
      };
    };

    const writes: (() => void)[] = [
      () => {
        snapshot.version = 2;
      },
      () => {
        snapshot.sessionId = 'other';
      },
      () => {
        snapshot.state = { ...snapshot.state, status: 'completed' };
      },
      () => {
        snapshot.state.status = 'completed';
      },
      () => {
        (snapshot.state.players[0] as { score: number }).score = 999;
      },
      () => {
        (snapshot.state.players[0] as { powers: string[] }).powers.push('shield');
      },
      () => {
        snapshot.state.history.pop();
      },
      () => {
        (snapshot.state.history[0] as { summary: string }).summary = 'rewritten';
      },
      () => {
        (snapshot.state.history[4] as { record: { kind: string } }).record.kind = 'EVENT';
      },
      () => {
        snapshot.state.timer.endsAt = 0;
      },
    ];
    for (const write of writes) expect(write).toThrow(TypeError);

    expect(session.getState()).toBe(before);
    expect(session.getState()).toEqual(copy);
    expect(session.snapshot().sessionId).toBe('g1');
  });

  it('is unaffected by a mutable copy of it being changed', () => {
    const session = played();
    const before = structuredClone(session.getState());
    const copy = stored(session);
    copy.state.status = 'aborted';
    copy.state.players.length = 0;
    copy.state.history.length = 0;
    expect(session.getState()).toEqual(before);
  });

  it('is a picture of one moment: a later change does not alter an earlier snapshot', () => {
    const session = runningSession();
    const early = session.snapshot();
    const earlyCopy = structuredClone(early);
    const { tagger, r1 } = roles(session.getState());
    unwrap(session.submitAction(tagger, tag(r1), at(NOW)));

    expect(early).toEqual(earlyCopy);
    expect(session.snapshot().state.history.length).toBe(early.state.history.length + 2);
    expect(session.snapshot()).not.toEqual(early);
  });

  it('is plain data that survives being written out and read back', () => {
    const session = played();
    const text = JSON.stringify(session.snapshot());
    expect(JSON.parse(text)).toEqual(session.snapshot());
    // Deterministic: the same session gives the same bytes.
    expect(JSON.stringify(session.snapshot())).toBe(text);
    expect(JSON.stringify(played().snapshot())).toBe(text);
  });

  it('does not change the session, and is not a promise', () => {
    const session = played();
    const before = session.getState();
    const snapshot: unknown = session.snapshot();
    expect(snapshot).not.toBeInstanceOf(Promise);
    expect(session.getState()).toBe(before);
    expect(session.snapshot.length).toBe(0);
  });
});

describe('restore', () => {
  it('rebuilds a session with the same id, state and history', () => {
    const original = played();
    const restored = unwrap(restoreGameSession(original.snapshot()));

    expect(restored.id).toBe(original.id);
    expect(restored.getState()).toEqual(original.getState());
    expect(restored.getState().history).toEqual(original.getState().history);
    expect(restored.snapshot()).toEqual(original.snapshot());
    expect(JSON.stringify(restored.snapshot())).toBe(JSON.stringify(original.snapshot()));
  });

  it('rebuilds from what storage would hand back', () => {
    const original = played();
    const restored = unwrap(restoreGameSession(stored(original)));
    expect(restored.getState()).toEqual(original.getState());
  });

  it('holds its own copy: the two sessions and the snapshot share nothing', () => {
    const original = played();
    const data = stored(original);
    const restored = unwrap(restoreGameSession(data));

    expect(restored.getState()).not.toBe(original.getState());
    expect(restored.getState().players).not.toBe(original.getState().players);
    expect(restored.getState()).not.toBe(data.state);

    // Changing what was passed in afterwards changes nothing.
    const before = structuredClone(restored.getState());
    data.state.status = 'aborted';
    data.state.players.length = 0;
    expect(restored.getState()).toEqual(before);

    // Changing one session does not change the other.
    unwrap(restored.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(NOW + 1_000)));
    expect(restored.getState().status).toBe('aborted');
    expect(original.getState().status).toBe('active');
  });

  it('gives a frozen state, like any session', () => {
    const restored = unwrap(restoreGameSession(stored(played())));
    const state = restored.getState() as unknown as { status: string; players: unknown[] };
    expect(() => {
      state.status = 'completed';
    }).toThrow(TypeError);
    expect(() => {
      state.players.pop();
    }).toThrow(TypeError);
  });

  it('carries on accepting actions, commands and time', () => {
    const restored = unwrap(restoreGameSession(stored(played())));
    const state = restored.getState();
    const { tagger, r1 } = roles(state);
    const before = state.history.length;

    const outcome = unwrap(restored.submitAction(tagger, tag(r1), at(NOW + 1_000)));
    expect(outcome.entries.map((entry) => entry.sequence)).toEqual([before, before + 1]);
    expect(codeOf(restored.submitAction(tagger, tag(r1), at(NOW + 2_000)))).toBe('INVALID_ROLE');
    unwrap(restored.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW + 3_000)));
    unwrap(restored.applyCommand({ type: 'RESUME_SESSION' }, at(NOW + 4_000)));
    unwrap(restored.advanceTime(at(START + 3 * ROUND_MS + 1_000)));
    expect(restored.getState().status).toBe('completed');
  });

  it('continues exactly as the original would have', () => {
    const original = played();
    const restored = unwrap(restoreGameSession(stored(original)));
    const { tagger, r1, r2 } = roles(original.getState());

    for (const session of [original, restored]) {
      unwrap(session.submitAction(tagger, tag(r2), at(NOW + 1_000)));
      session.submitAction(r1, tag(tagger), at(NOW + 2_000));
      unwrap(session.applyCommand({ type: 'REMOVE_PLAYER', playerId: r1 }, at(NOW + 3_000)));
      unwrap(session.advanceTime(at(START + 3 * ROUND_MS)));
    }
    expect(restored.getState()).toEqual(original.getState());
    expect(restored.getState().status).toBe('completed');
    expect(restored.getState().winnerIds).toEqual(original.getState().winnerIds);
  });

  it('can be repeated: a restored session snapshots and restores the same', () => {
    const first = played();
    const second = unwrap(restoreGameSession(stored(first)));
    const third = unwrap(restoreGameSession(stored(second)));
    expect(third.getState()).toEqual(first.getState());
  });

  it.each([
    ['in the lobby', (): GameSession => lobbySession()],
    [
      'an empty lobby',
      (): GameSession =>
        unwrap(
          createGameSession(
            {
              type: 'CREATE_SESSION',
              sessionId: 'g1',
              gameId: 'tag',
              joinCode: 'GRASS7',
              randomSeed: 7,
            },
            at(0),
          ),
        ),
    ],
    ['running', (): GameSession => runningSession()],
    ['running Hide & Seek', (): GameSession => runningSession('g2', 'hide-and-seek')],
    [
      'in a later round',
      (): GameSession => {
        const session = runningSession();
        unwrap(session.advanceTime(at(START + ROUND_MS + 5_000)));
        return session;
      },
    ],
    [
      'paused',
      (): GameSession => {
        const session = played();
        unwrap(session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW + 1_000)));
        return session;
      },
    ],
    [
      'completed',
      (): GameSession => {
        const session = played();
        unwrap(session.advanceTime(at(START + 3 * ROUND_MS)));
        return session;
      },
    ],
    [
      'aborted',
      (): GameSession => {
        const session = played();
        unwrap(session.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(NOW + 1_000)));
        return session;
      },
    ],
    [
      'with a player who left',
      (): GameSession => {
        const session = lobbySession();
        unwrap(session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'p1' }, at(500)));
        return session;
      },
    ],
  ])('restores a game %s', (_label, make) => {
    const original = make();
    const restored = unwrap(restoreGameSession(stored(original)));
    expect(restored.getState()).toEqual(original.getState());
    expect(restored.id).toBe(original.id);
  });

  it('resumes a paused game with its clock where it was', () => {
    const original = played();
    unwrap(original.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW + 10_000)));
    const restored = unwrap(restoreGameSession(stored(original)));

    // Restored much later: the pause is still a pause, however long storage took.
    unwrap(restored.applyCommand({ type: 'RESUME_SESSION' }, at(NOW + 3_600_000)));
    const remaining = (restored.getState().timer.endsAt ?? 0) - (T0 + NOW + 3_600_000);
    expect(remaining).toBe(START + ROUND_MS - (NOW + 10_000));
  });

  it('refuses time earlier than the game had already seen', () => {
    const restored = unwrap(restoreGameSession(stored(played())));
    expect(codeOf(restored.advanceTime(at(NOW - 1)))).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('restore: invalid snapshots', () => {
  const good = (): ReturnType<typeof stored> => stored(played());

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'snapshot'],
    ['a number', 1],
    ['an array', []],
    ['an empty object', {}],
    ['a bare game state', played().getState()],
  ])('refuses %s', (_label, value) => {
    expect(codeOf(restoreGameSession(value))).toBe('INVALID_GAME_STATE');
  });

  it.each([
    ['a missing version', (s: Record<string, unknown>) => delete s.version],
    ['a missing session id', (s: Record<string, unknown>) => delete s.sessionId],
    ['a missing state', (s: Record<string, unknown>) => delete s.state],
    ['an extra field', (s: Record<string, unknown>) => (s.hostToken = 'secret')],
    ['a token table', (s: Record<string, unknown>) => (s.tokens = { secret: 'p0' })],
    ['a second history', (s: Record<string, unknown>) => (s.history = [])],
    ['a later version', (s: Record<string, unknown>) => (s.version = 2)],
    ['version zero', (s: Record<string, unknown>) => (s.version = 0)],
    ['a version as text', (s: Record<string, unknown>) => (s.version = '1')],
    ['a different session id', (s: Record<string, unknown>) => (s.sessionId = 'g2')],
    ['a session id that is not text', (s: Record<string, unknown>) => (s.sessionId = 7)],
    ['a state that is not an object', (s: Record<string, unknown>) => (s.state = 'active')],
  ])('refuses a snapshot with %s', (_label, damage) => {
    const snapshot = good() as unknown as Record<string, unknown>;
    damage(snapshot);
    expect(codeOf(restoreGameSession(snapshot))).toBe('INVALID_GAME_STATE');
  });

  it.each([
    ['a missing field', (s: Record<string, unknown>) => delete s.players],
    ['an unknown field', (s: Record<string, unknown>) => (s.connections = ['socket-1'])],
    ['tokens added to it', (s: Record<string, unknown>) => (s.playerTokens = { p0: 'secret' })],
    ['a status the game does not have', (s: Record<string, unknown>) => (s.status = 'frozen')],
    [
      'a negative score',
      (s: Record<string, unknown>) => {
        ((s.players as { score: number }[])[0] as { score: number }).score = -1;
      },
    ],
    [
      'a player with an unknown field',
      (s: Record<string, unknown>) => {
        ((s.players as Record<string, unknown>[])[0] as Record<string, unknown>).socketId = 'abc';
      },
    ],
    [
      'two players with one id',
      (s: Record<string, unknown>) => {
        const players = s.players as { id: string }[];
        (players[1] as { id: string }).id = (players[0] as { id: string }).id;
      },
    ],
    [
      'a gap in its history',
      (s: Record<string, unknown>) => {
        (s.history as unknown[]).splice(3, 1);
      },
    ],
    [
      'a history entry of an unknown kind',
      (s: Record<string, unknown>) => {
        ((s.history as { record: unknown }[])[2] as { record: unknown }).record = { kind: 'PATCH' };
      },
    ],
    [
      'an event the engine does not have',
      (s: Record<string, unknown>) => {
        ((s.history as { record: unknown }[]).at(-1) as { record: unknown }).record = {
          kind: 'EVENT',
          event: { type: 'SET_SCORE', playerId: 'p0', score: 99 },
        };
      },
    ],
    [
      'a running round with no end time',
      (s: Record<string, unknown>) => {
        (s.timer as { endsAt: number | null }).endsAt = null;
      },
    ],
    ['an end time on a game that has not ended', (s: Record<string, unknown>) => (s.endedAt = 5)],
    ['winners before the game is over', (s: Record<string, unknown>) => (s.winnerIds = ['p0'])],
    ['a round beyond the last', (s: Record<string, unknown>) => (s.currentRound = 9)],
    ['a seed that is not a whole number', (s: Record<string, unknown>) => (s.randomSeed = 1.5)],
  ])('refuses a state with %s', (_label, damage) => {
    const snapshot = good();
    damage(snapshot.state);
    const result = restoreGameSession(snapshot);
    expect(codeOf(result)).toBe('INVALID_GAME_STATE');
    expect(Object.keys(result)).not.toContain('value');
  });

  it('refuses a game the engine has no definition for', () => {
    const snapshot = good();
    snapshot.state.gameId = 'quidditch';
    expect(codeOf(restoreGameSession(snapshot))).toBe('INVALID_GAME_CONFIGURATION');
  });

  it('refuses settings that are not the game definition’s', () => {
    for (const change of [
      { roundDurationSeconds: 5 },
      { totalRounds: 9 },
      { roundDurationSeconds: 3_600, totalRounds: 1 },
    ]) {
      const snapshot = good();
      snapshot.state.settings = { ...snapshot.state.settings, ...change };
      expect(codeOf(restoreGameSession(snapshot))).toBe('INVALID_GAME_STATE');
    }
    // A snapshot of one game relabelled as another carries the wrong settings too.
    const relabelled = good();
    relabelled.state.gameId = 'hide-and-seek';
    expect(codeOf(restoreGameSession(relabelled))).toBe('INVALID_GAME_STATE');
  });

  it('refuses a history that does not begin with the creation of the session', () => {
    const dropped = good();
    dropped.state.history.shift();
    for (const [index, entry] of dropped.state.history.entries()) {
      (entry as { sequence: number }).sequence = index;
    }
    expect(codeOf(restoreGameSession(dropped))).toBe('INVALID_GAME_STATE');

    const emptied = stored(
      unwrap(
        createGameSession(
          {
            type: 'CREATE_SESSION',
            sessionId: 'g1',
            gameId: 'tag',
            joinCode: 'GRASS7',
            randomSeed: 7,
          },
          at(0),
        ),
      ),
    );
    emptied.state.history.length = 0;
    expect(codeOf(restoreGameSession(emptied))).toBe('INVALID_GAME_STATE');

    const moved = good();
    moved.state.createdAt -= 1;
    expect(codeOf(restoreGameSession(moved))).toBe('INVALID_GAME_STATE');
  });

  it('refuses a history whose times go backwards', () => {
    const snapshot = good();
    (snapshot.state.history.at(-1) as { at: number }).at = T0;
    expect(codeOf(restoreGameSession(snapshot))).toBe('INVALID_GAME_STATE');
  });

  it('refuses a round that had already run out when the snapshot was taken', () => {
    const snapshot = good();
    // The engine never leaves a round open past its end; this state says it did.
    snapshot.state.timer.endsAt = T0 + START;
    expect(codeOf(restoreGameSession(snapshot))).toBe('INVALID_GAME_STATE');
  });

  it('refuses a modifier that had already expired, and accepts one still in force', () => {
    const zone = (expiresAt: number) => ({
      id: 'm1',
      kind: 'SAFE_ZONE',
      zone: 'the bench',
      expiresAt,
    });

    // The latest time in the history is T0 + NOW. A modifier that ended then or
    // earlier would already have been dropped by the engine.
    const expired = good();
    (expired.state.activeModifiers as unknown[]).push(zone(T0 + NOW));
    expect(codeOf(restoreGameSession(expired))).toBe('INVALID_GAME_STATE');

    const live = good();
    (live.state.activeModifiers as unknown[]).push(zone(T0 + NOW + 1));
    const restored = unwrap(restoreGameSession(live));
    expect(restored.getState().activeModifiers).toHaveLength(1);
    // And the engine drops it when its time comes, as it would have.
    unwrap(restored.advanceTime(at(NOW + 1)));
    expect(restored.getState().activeModifiers).toEqual([]);
  });

  it('never throws, whatever it is given', () => {
    const snapshot = good();
    const oddities: unknown[] = [
      Object.create(null),
      new Map(),
      () => snapshot,
      { ...snapshot, state: { ...snapshot.state, history: 'none' } },
      { ...snapshot, state: { ...snapshot.state, players: null } },
      { ...snapshot, state: null },
      new Proxy(snapshot, {}),
    ];
    for (const value of oddities) {
      expect(() => restoreGameSession(value)).not.toThrow();
    }
    expect(restoreGameSession(new Proxy(snapshot, {})).ok).toBe(true);
  });

  it('leaves the session a bad snapshot came from untouched', () => {
    const original = played();
    const before = original.getState();
    const copy = structuredClone(before);
    const snapshot = stored(original);
    snapshot.state.timer.endsAt = T0;

    expect(restoreGameSession(snapshot).ok).toBe(false);
    expect(original.getState()).toBe(before);
    expect(original.getState()).toEqual(copy);
    // And it can still be played and restored properly.
    expect(restoreGameSession(original.snapshot()).ok).toBe(true);
  });

  it('cannot tell that a well-formed state was edited: storage must be trusted', () => {
    // The history does not hold enough to replay a game, so a changed score in an
    // otherwise valid state is accepted. This pins the limit so it is not forgotten.
    const snapshot = good();
    (snapshot.state.players[0] as { score: number }).score += 50;
    expect(restoreGameSession(snapshot).ok).toBe(true);
  });
});

describe('the persistence boundary', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(join(directory, 'session.ts'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    '',
  );

  it('is a labelled game state: nothing of a transport is in it', () => {
    const snapshot: GameSessionSnapshot = played().snapshot();
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/token|socket|connection|hostToken|host_auth|password|secret/i);
    expect(Object.keys(snapshot.state).sort()).toEqual(Object.keys(gameStateSchema.shape).sort());
  });

  it('stores nothing itself: no file, network, timer or registry', () => {
    expect(code).not.toMatch(
      /node:fs|readFile|writeFile|fetch\(|mongo|redis|setTimeout|setInterval|\basync\b|\bawait\b|Promise|subscribe|EventEmitter/i,
    );
    const topLevel = code
      .split('\n')
      .filter(
        (line) => /^(export )?(let|var)\s/.test(line) || /^(export )?const \w+ = new /.test(line),
      );
    expect(topLevel).toEqual([]);
  });

  it('restores through the engine, and changes the state only through the four operations', () => {
    expect(code).toContain('gameStateSchema.safeParse(');
    expect(code).toContain('createSession(');
    expect(code).not.toMatch(/processPlayerAction|\bstep\(|submitGameEvent|replay\(/);
    // One mutable binding in the whole module, inside the holder. After it is
    // initialised it is assigned in exactly two places: an accepted action, and
    // `replace`, which the other three operations call on success.
    expect(code.match(/\blet\b/g)).toHaveLength(1);
    expect(code.match(/\bcurrent = /g)).toHaveLength(2);
  });
});
