import { describe, expect, it } from 'vitest';
import type { EngineContext } from './apply-event';
import { createSession, reduce } from './reduce';
import {
  GAME_STATUSES,
  LIFECYCLE_TRANSITIONS,
  type GameState,
  canTransition,
  gameStateSchema,
  gameStatusSchema,
  isTerminalStatus,
  playerStateSchema,
} from './state';

const T0 = 1_700_000_000_000;
const ctx = (tick = 0): EngineContext => ({
  now: T0 + tick,
  nextEntryId: (sequence) => `entry-${sequence}`,
});

/** A lobby with two players, produced by the engine rather than written by hand. */
function lobby(): GameState {
  const created = createSession(
    { type: 'CREATE_SESSION', sessionId: 'g1', gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
    ctx(),
  );
  if (!created.ok) throw new Error('fixture failed');
  let state = created.value;
  for (const [index, name] of ['Ada', 'Linus'].entries()) {
    const next = reduce(
      state,
      { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: name },
      ctx(index + 1),
    );
    if (!next.ok) throw new Error('fixture failed');
    state = next.value;
  }
  return state;
}

describe('lifecycle statuses', () => {
  it('declares the seven statuses of the contract', () => {
    expect([...GAME_STATUSES]).toEqual([
      'lobby',
      'starting',
      'active',
      'round_end',
      'paused',
      'completed',
      'aborted',
    ]);
  });

  it('rejects an unknown status', () => {
    expect(gameStatusSchema.safeParse('running').success).toBe(false);
    expect(gameStatusSchema.safeParse('ACTIVE').success).toBe(false);
  });

  it('treats completed and aborted as terminal, and nothing else', () => {
    const terminal = GAME_STATUSES.filter((status) => isTerminalStatus(status));
    expect(terminal).toEqual(['completed', 'aborted']);
  });

  it('follows the contract path lobby → starting → active → round_end → completed', () => {
    expect(canTransition('lobby', 'starting')).toBe(true);
    expect(canTransition('starting', 'active')).toBe(true);
    expect(canTransition('active', 'round_end')).toBe(true);
    expect(canTransition('round_end', 'active')).toBe(true);
    expect(canTransition('round_end', 'completed')).toBe(true);
  });

  it('completes only from round_end: never mid-round and never while paused', () => {
    for (const status of GAME_STATUSES) {
      expect(canTransition(status, 'completed')).toBe(status === 'round_end');
    }
  });

  it('pauses and resumes only from and to active', () => {
    expect(canTransition('active', 'paused')).toBe(true);
    expect(canTransition('paused', 'active')).toBe(true);
    expect(canTransition('lobby', 'paused')).toBe(false);
    expect(canTransition('round_end', 'paused')).toBe(false);
  });

  it('can abort from every non-terminal status', () => {
    for (const status of GAME_STATUSES) {
      expect(canTransition(status, 'aborted')).toBe(!isTerminalStatus(status));
    }
  });

  it('leads nowhere from a terminal status', () => {
    expect(LIFECYCLE_TRANSITIONS.completed).toEqual([]);
    expect(LIFECYCLE_TRANSITIONS.aborted).toEqual([]);
    for (const status of GAME_STATUSES) {
      expect(canTransition('completed', status)).toBe(false);
      expect(canTransition('aborted', status)).toBe(false);
    }
  });

  it('never skips straight from the lobby into play, or back into the lobby', () => {
    expect(canTransition('lobby', 'active')).toBe(false);
    expect(canTransition('lobby', 'completed')).toBe(false);
    for (const status of GAME_STATUSES) {
      expect(canTransition(status, 'lobby')).toBe(false);
    }
  });

  it('never lets a status follow itself', () => {
    for (const status of GAME_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('playerStateSchema', () => {
  const player = {
    id: 'p1',
    displayName: 'Ada',
    roleId: null,
    score: 0,
    status: 'active',
    ready: false,
    powers: [],
    joinedAt: T0,
  };

  it('accepts a new player', () => {
    expect(playerStateSchema.safeParse(player).success).toBe(true);
  });

  it('rejects a negative or fractional score', () => {
    expect(playerStateSchema.safeParse({ ...player, score: -1 }).success).toBe(false);
    expect(playerStateSchema.safeParse({ ...player, score: 2.5 }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(playerStateSchema.safeParse({ ...player, status: 'banned' }).success).toBe(false);
  });

  it('rejects extra fields, so no personal data can be attached', () => {
    expect(playerStateSchema.safeParse({ ...player, email: 'a@b.c' }).success).toBe(false);
  });

  it('bounds the display name', () => {
    expect(playerStateSchema.safeParse({ ...player, displayName: '' }).success).toBe(false);
    expect(playerStateSchema.safeParse({ ...player, displayName: 'x'.repeat(41) }).success).toBe(
      false,
    );
  });
});

describe('gameStateSchema', () => {
  it('accepts the lobby the engine produces', () => {
    expect(gameStateSchema.safeParse(lobby()).success).toBe(true);
  });

  it('starts a new game at round 0 with the settings of its definition and no timer', () => {
    const state = lobby();
    expect(state.currentRound).toBe(0);
    expect(state.settings).toEqual({ totalRounds: 3, roundDurationSeconds: 180 });
    expect(state.timer).toEqual({ endsAt: null, pausedAt: null });
    expect(state.winnerIds).toEqual([]);
    expect(state.activeModifiers).toEqual([]);
    expect(state.activeObjectives).toEqual([]);
  });

  it('survives a JSON round trip unchanged', () => {
    const state = lobby();
    expect(gameStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('rejects duplicate player ids', () => {
    const state = lobby();
    const players = [...state.players, { ...state.players[0]! }];
    expect(gameStateSchema.safeParse({ ...state, players }).success).toBe(false);
  });

  it('rejects a round beyond the configured total', () => {
    const state = lobby();
    expect(gameStateSchema.safeParse({ ...state, currentRound: 4 }).success).toBe(false);
  });

  it('rejects a history with a gap or a reordering', () => {
    const state = lobby();
    const gapped = state.history.map((entry, index) =>
      index === 1 ? { ...entry, sequence: 5 } : entry,
    );
    expect(gameStateSchema.safeParse({ ...state, history: gapped }).success).toBe(false);
    expect(
      gameStateSchema.safeParse({ ...state, history: [...state.history].reverse() }).success,
    ).toBe(false);
  });

  it('requires endedAt exactly when the game has ended', () => {
    const state = lobby();
    expect(gameStateSchema.safeParse({ ...state, endedAt: T0 }).success).toBe(false);
    expect(gameStateSchema.safeParse({ ...state, status: 'completed' }).success).toBe(false);
    expect(
      gameStateSchema.safeParse({ ...state, status: 'aborted', endedAt: T0 + 5 }).success,
    ).toBe(true);
  });

  it('rejects a lobby that claims to have started', () => {
    expect(gameStateSchema.safeParse({ ...lobby(), startedAt: T0 }).success).toBe(false);
  });

  it('rejects duplicate modifier or objective ids', () => {
    const state = lobby();
    const zone = { id: 'm1', kind: 'SAFE_ZONE', zone: 'the bench', expiresAt: T0 + 60_000 };
    expect(gameStateSchema.safeParse({ ...state, activeModifiers: [zone] }).success).toBe(true);
    expect(gameStateSchema.safeParse({ ...state, activeModifiers: [zone, zone] }).success).toBe(
      false,
    );

    const objective = {
      id: 'o1',
      source: 'BONUS_OBJECTIVE',
      description: 'Reach the oak.',
      points: 2,
      eligiblePlayerIds: [],
      completedByPlayerIds: [],
      expiresAt: T0 + 60_000,
    };
    expect(
      gameStateSchema.safeParse({ ...state, activeObjectives: [objective, objective] }).success,
    ).toBe(false);
  });

  it('rejects a modifier kind that is not a lasting modifier', () => {
    const state = lobby();
    for (const kind of ['TIME_EXTENSION', 'ROLE_SWAP', 'DOUBLE_GRAVITY']) {
      const modifier = { id: 'm1', kind, expiresAt: T0 + 1 };
      expect(gameStateSchema.safeParse({ ...state, activeModifiers: [modifier] }).success).toBe(
        false,
      );
    }
  });

  it('only records commands, validated actions, or validated events in history', () => {
    const state = lobby();
    const entry = (record: unknown) => ({
      id: 'entry-x',
      sequence: state.history.length,
      at: T0 + 99,
      source: 'human',
      summary: 'Something happened.',
      record,
    });
    const withEntry = (record: unknown) => ({
      ...state,
      history: [...state.history, entry(record)],
    });

    expect(
      gameStateSchema.safeParse(
        withEntry({ kind: 'ACTION', action: { type: 'PLAYER_READY', playerId: 'p0' } }),
      ).success,
    ).toBe(true);
    expect(
      gameStateSchema.safeParse(
        withEntry({ kind: 'EVENT', event: { type: 'TIME_EXTENSION', seconds: 30 } }),
      ).success,
    ).toBe(true);
    // A malformed event cannot be written into history.
    expect(
      gameStateSchema.safeParse(
        withEntry({ kind: 'EVENT', event: { type: 'TIME_EXTENSION', seconds: 99_999 } }),
      ).success,
    ).toBe(false);
    expect(gameStateSchema.safeParse(withEntry({ kind: 'MUTATION', set: {} })).success).toBe(false);
  });

  it('requires pausedAt exactly while the game is paused', () => {
    const state = lobby();
    const running = { ...state, status: 'active', startedAt: T0, currentRound: 1 };
    expect(
      gameStateSchema.safeParse({ ...running, timer: { endsAt: T0 + 1_000, pausedAt: null } })
        .success,
    ).toBe(true);
    expect(
      gameStateSchema.safeParse({ ...running, timer: { endsAt: T0 + 1_000, pausedAt: T0 + 5 } })
        .success,
    ).toBe(false);
    expect(
      gameStateSchema.safeParse({
        ...running,
        status: 'paused',
        timer: { endsAt: T0 + 1_000, pausedAt: null },
      }).success,
    ).toBe(false);
  });

  it('requires a running round to have an end time', () => {
    const state = lobby();
    expect(
      gameStateSchema.safeParse({ ...state, status: 'active', startedAt: T0, currentRound: 1 })
        .success,
    ).toBe(false);
  });

  it('allows winners only on a completed game, and only players of that game', () => {
    const state = lobby();
    expect(gameStateSchema.safeParse({ ...state, winnerIds: ['p0'] }).success).toBe(false);
    const completed = { ...state, status: 'completed', startedAt: T0, endedAt: T0 + 9 };
    expect(gameStateSchema.safeParse({ ...completed, winnerIds: ['p0'] }).success).toBe(true);
    expect(gameStateSchema.safeParse({ ...completed, winnerIds: ['ghost'] }).success).toBe(false);
  });

  it('records score awards on a history entry, and only positive ones', () => {
    const state = lobby();
    const entry = (awards: unknown) => ({
      id: 'entry-x',
      sequence: state.history.length,
      at: T0 + 99,
      source: 'engine',
      summary: 'Round 1 ended.',
      record: { kind: 'EVENT', event: { type: 'ROUND_END', round: 1 } },
      awards,
    });
    const withAwards = (awards: unknown) => ({
      ...state,
      history: [...state.history, entry(awards)],
    });
    expect(
      gameStateSchema.safeParse(
        withAwards([{ playerId: 'p0', reason: 'ROUND_SURVIVED', points: 1 }]),
      ).success,
    ).toBe(true);
    for (const bad of [
      [{ playerId: 'p0', reason: 'ROUND_SURVIVED', points: -1 }],
      [{ playerId: 'p0', reason: 'ROUND_SURVIVED', points: 0 }],
      [{ playerId: 'p0', reason: 'BECAUSE_I_SAID_SO', points: 1 }],
    ]) {
      expect(gameStateSchema.safeParse(withAwards(bad)).success).toBe(false);
    }
  });

  it('rejects unknown top-level fields', () => {
    expect(gameStateSchema.safeParse({ ...lobby(), mongoId: 'abc' }).success).toBe(false);
  });
});
