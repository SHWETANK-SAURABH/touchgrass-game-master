import { describe, expect, it } from 'vitest';
import { getGameDefinition } from '@touchgrass/game-definitions';
import type { EngineCommand } from './commands';
import { createSession, reduce, replay, type EngineContext } from './reduce';
import type { SessionState } from './state';

const T0 = 1_700_000_000_000;

/** A context whose ids and clock are fully determined by the sequence number. */
function ctx(tickMs = 0): EngineContext {
  return { now: T0 + tickMs, nextEntryId: (sequence) => `entry-${sequence}` };
}

function create(overrides: Partial<Extract<EngineCommand, { type: 'CREATE_SESSION' }>> = {}) {
  return {
    type: 'CREATE_SESSION' as const,
    sessionId: 'ses_test',
    gameId: 'tag',
    joinCode: 'GRASS7',
    randomSeed: 12345,
    ...overrides,
  };
}

function session(gameId = 'tag'): SessionState {
  const result = createSession(create({ gameId }), ctx());
  if (!result.ok) throw new Error(`fixture failed: ${result.error.message}`);
  return result.value;
}

function addPlayers(state: SessionState, count: number): SessionState {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    const next = reduce(
      current,
      { type: 'ADD_PLAYER', playerId: `p${i}`, displayName: `Player ${i}` },
      ctx(i),
    );
    if (!next.ok) throw new Error(`fixture failed: ${next.error.message}`);
    current = next.value;
  }
  return current;
}

describe('createSession', () => {
  it('opens a lobby with an audit entry', () => {
    const result = createSession(create(), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('lobby');
    expect(result.value.players).toEqual([]);
    expect(result.value.startedAt).toBeNull();
    expect(result.value.log).toHaveLength(1);
    expect(result.value.log[0]).toMatchObject({
      sequence: 0,
      source: 'engine',
      type: 'CREATE_SESSION',
    });
    expect(result.value.log[0]?.summary).toContain('GRASS7');
  });

  it('refuses an unknown game id', () => {
    const result = createSession(create({ gameId: 'quidditch' }), ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNKNOWN_GAME');
  });
});

describe('ADD_PLAYER', () => {
  it('appends a player with a null role and zero score', () => {
    const result = reduce(
      session(),
      { type: 'ADD_PLAYER', playerId: 'p1', displayName: 'Ada' },
      ctx(10),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players).toHaveLength(1);
    expect(result.value.players[0]).toMatchObject({
      id: 'p1',
      displayName: 'Ada',
      roleId: null,
      score: 0,
      active: true,
    });
  });

  it('rejects a duplicate player id', () => {
    const withAda = addPlayers(session(), 1);
    const result = reduce(
      withAda,
      { type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Impostor' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_PLAYER');
  });

  it('rejects joins past the game maximum', () => {
    const definition = getGameDefinition('tag');
    const full = addPlayers(session(), definition.maxPlayers);
    const result = reduce(
      full,
      { type: 'ADD_PLAYER', playerId: 'late', displayName: 'Late' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_FULL');
  });

  it('rejects joins once the game is running', () => {
    const started = reduce(addPlayers(session(), 4), { type: 'START_SESSION' }, ctx(100));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = reduce(
      started.value,
      { type: 'ADD_PLAYER', playerId: 'late', displayName: 'Late' },
      ctx(200),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_STATUS');
  });
});

describe('REMOVE_PLAYER', () => {
  it('deactivates rather than deletes, so the log stays readable', () => {
    const withPlayers = addPlayers(session(), 3);
    const result = reduce(withPlayers, { type: 'REMOVE_PLAYER', playerId: 'p1' }, ctx(50));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players).toHaveLength(3);
    expect(result.value.players.find((p) => p.id === 'p1')?.active).toBe(false);
  });

  it('rejects an unknown player', () => {
    const result = reduce(session(), { type: 'REMOVE_PLAYER', playerId: 'ghost' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNKNOWN_PLAYER');
  });
});

describe('START_SESSION', () => {
  it('assigns every active player a role from the definition', () => {
    const result = reduce(addPlayers(session(), 6), { type: 'START_SESSION' }, ctx(100));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const roleIds = getGameDefinition('tag').roles.map((role) => role.id);
    for (const player of result.value.players) {
      expect(roleIds).toContain(player.roleId);
    }
    expect(result.value.status).toBe('active');
    expect(result.value.startedAt).toBe(T0 + 100);
  });

  it('honours each role minimum', () => {
    const result = reduce(addPlayers(session('ice-and-fire'), 8), { type: 'START_SESSION' }, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const role of getGameDefinition('ice-and-fire').roles) {
      const holders = result.value.players.filter((player) => player.roleId === role.id).length;
      expect(holders).toBeGreaterThanOrEqual(role.min);
      if (role.max !== undefined) expect(holders).toBeLessThanOrEqual(role.max);
    }
  });

  it('refuses to start below the player minimum', () => {
    const result = reduce(addPlayers(session(), 2), { type: 'START_SESSION' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_ENOUGH_PLAYERS');
    expect(result.error.message).toMatch(/at least 3 players/);
  });

  it('assigns identical roles for the same seed and different roles for another', () => {
    const rolesFor = (seed: number): (string | null)[] => {
      const base = createSession(create({ randomSeed: seed }), ctx());
      if (!base.ok) throw new Error('fixture failed');
      const started = reduce(addPlayers(base.value, 8), { type: 'START_SESSION' }, ctx());
      if (!started.ok) throw new Error('fixture failed');
      return started.value.players.map((player) => player.roleId);
    };

    expect(rolesFor(999)).toEqual(rolesFor(999));
    // Two seeds producing the same layout would be a coincidence, not a bug, but
    // with 8 players across two roles it is overwhelmingly unlikely.
    expect(rolesFor(1)).not.toEqual(rolesFor(2));
  });

  it('cannot start twice', () => {
    const started = reduce(addPlayers(session(), 5), { type: 'START_SESSION' }, ctx());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const again = reduce(started.value, { type: 'START_SESSION' }, ctx());
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('WRONG_STATUS');
  });
});

describe('phases', () => {
  it('advances through the declared phases in order', () => {
    const started = reduce(addPlayers(session(), 5), { type: 'START_SESSION' }, ctx());
    if (!started.ok) throw new Error('fixture failed');

    const phases = getGameDefinition('tag').phases;
    let current = started.value;
    expect(current.phaseIndex).toBe(0);

    for (let i = 1; i < phases.length; i += 1) {
      const next = reduce(current, { type: 'ADVANCE_PHASE' }, ctx(i * 10));
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      expect(next.value.phaseIndex).toBe(i);
      current = next.value;
    }

    const past = reduce(current, { type: 'ADVANCE_PHASE' }, ctx(999));
    expect(past.ok).toBe(false);
    if (past.ok) return;
    expect(past.error.code).toBe('NO_FURTHER_PHASE');
  });

  it('refuses to advance a lobby', () => {
    const result = reduce(session(), { type: 'ADVANCE_PHASE' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_STATUS');
  });
});

describe('pause, resume, complete, abort', () => {
  function running(): SessionState {
    const started = reduce(addPlayers(session(), 5), { type: 'START_SESSION' }, ctx());
    if (!started.ok) throw new Error('fixture failed');
    return started.value;
  }

  it('pauses and resumes', () => {
    const paused = reduce(running(), { type: 'PAUSE_SESSION', reason: 'shoelace' }, ctx(10));
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.value.status).toBe('paused');
    expect(paused.value.log.at(-1)?.summary).toContain('shoelace');

    const resumed = reduce(paused.value, { type: 'RESUME_SESSION' }, ctx(20));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.status).toBe('active');
  });

  it('will not resume a session that is not paused', () => {
    const result = reduce(running(), { type: 'RESUME_SESSION' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_STATUS');
  });

  it('completes a running session and stamps the end time', () => {
    const result = reduce(running(), { type: 'COMPLETE_SESSION' }, ctx(500));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('completed');
    expect(result.value.endedAt).toBe(T0 + 500);
  });

  it('refuses to complete a lobby that never started', () => {
    const result = reduce(session(), { type: 'COMPLETE_SESSION' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_STATUS');
  });

  it('aborts from the lobby, because stopping a game is never blocked', () => {
    const result = reduce(session(), { type: 'ABORT_SESSION', reason: 'rain' }, ctx(5));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('aborted');
  });

  it('aborts from a paused session too', () => {
    const paused = reduce(running(), { type: 'PAUSE_SESSION', reason: 'injury check' }, ctx(10));
    if (!paused.ok) throw new Error('fixture failed');
    const aborted = reduce(paused.value, { type: 'ABORT_SESSION', reason: 'injury' }, ctx(20));
    expect(aborted.ok).toBe(true);
    if (!aborted.ok) return;
    expect(aborted.value.status).toBe('aborted');
  });

  it('accepts nothing after a terminal status', () => {
    const done = reduce(running(), { type: 'COMPLETE_SESSION' }, ctx(100));
    if (!done.ok) throw new Error('fixture failed');
    for (const command of [
      { type: 'ADD_PLAYER' as const, playerId: 'x', displayName: 'X' },
      { type: 'ADVANCE_PHASE' as const },
      { type: 'RESUME_SESSION' as const },
      { type: 'ABORT_SESSION' as const, reason: 'too late' },
    ]) {
      const result = reduce(done.value, command, ctx(200));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('WRONG_STATUS');
    }
  });
});

describe('determinism', () => {
  const script: Exclude<EngineCommand, { type: 'CREATE_SESSION' }>[] = [
    { type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Ada' },
    { type: 'ADD_PLAYER', playerId: 'p1', displayName: 'Linus' },
    { type: 'ADD_PLAYER', playerId: 'p2', displayName: 'Grace' },
    { type: 'ADD_PLAYER', playerId: 'p3', displayName: 'Alan' },
    { type: 'START_SESSION' },
    { type: 'ADVANCE_PHASE' },
    { type: 'PAUSE_SESSION', reason: 'water break' },
    { type: 'RESUME_SESSION' },
    { type: 'COMPLETE_SESSION' },
  ];

  const contextFor = (index: number): EngineContext => ({
    now: T0 + index * 1000,
    nextEntryId: (sequence) => `entry-${sequence}`,
  });

  it('replays a command log to an identical state', () => {
    const first = replay(create(), script, contextFor);
    const second = replay(create(), script, contextFor);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
  });

  it('never mutates the state it was given', () => {
    const before = addPlayers(session(), 4);
    const snapshot = structuredClone(before);
    reduce(before, { type: 'START_SESSION' }, ctx(1));
    reduce(before, { type: 'ABORT_SESSION', reason: 'noop' }, ctx(2));
    expect(before).toEqual(snapshot);
  });

  it('numbers log entries contiguously from zero', () => {
    const result = replay(create(), script, contextFor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.log.map((entry) => entry.sequence)).toEqual(
      result.value.log.map((_, index) => index),
    );
  });

  it('attributes every lifecycle entry to the engine or a human, never the model', () => {
    const result = replay(create(), script, contextFor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const entry of result.value.log) {
      expect(['engine', 'human']).toContain(entry.source);
    }
  });

  it('stops the replay at the first refusal', () => {
    const result = replay(create(), [{ type: 'START_SESSION' }], contextFor);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_ENOUGH_PLAYERS');
  });
});
