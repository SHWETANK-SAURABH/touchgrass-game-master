import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRng } from '@touchgrass/shared';
import { getGameDefinition } from '@touchgrass/game-definitions';
import { type EngineInput, type TimedInput, replay, step, submitGameEvent } from './engine';
import { processPlayerAction } from './process-action';
import { createSession, reduce } from './reduce';
import { type GameState, canTransition, gameStateSchema } from './state';
import {
  START,
  T0,
  at,
  codeOf,
  eventTypes,
  holders,
  lobby,
  must,
  scoreOf,
  started,
} from './test-support';
import { advanceTime } from './time';

const TAG_ROUND_MS = 180_000;
const ready = (playerId: string) => ({ type: 'PLAYER_READY' as const, playerId });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lobby', () => {
  it('creates a game in the lobby with the settings of its definition', () => {
    const state = lobby('tag', 0);
    expect(state.status).toBe('lobby');
    expect(state.settings).toEqual(getGameDefinition('tag').settings);
    expect(state.currentRound).toBe(0);
    expect(state.winnerIds).toEqual([]);
  });

  it('refuses an unknown game', () => {
    const result = createSession(
      { type: 'CREATE_SESSION', sessionId: 'g', gameId: 'quidditch', joinCode: 'X', randomSeed: 1 },
      at(0),
    );
    expect(codeOf(result)).toBe('INVALID_GAME_CONFIGURATION');
  });

  it('refuses a duplicate player and a player past the maximum', () => {
    const full = lobby('tag', 4);
    expect(
      codeOf(reduce(full, { type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Dup' }, at(1))),
    ).toBe('DUPLICATE_PLAYER');
    expect(
      codeOf(reduce(full, { type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Late' }, at(1))),
    ).toBe('PLAYER_LIMIT_EXCEEDED');
  });

  it('marks a removed player as left and keeps their record', () => {
    const state = must(reduce(lobby('tag', 3), { type: 'REMOVE_PLAYER', playerId: 'p1' }, at(1)));
    expect(state.players).toHaveLength(3);
    expect(state.players.find((player) => player.id === 'p1')?.status).toBe('left');
    expect(codeOf(reduce(state, { type: 'REMOVE_PLAYER', playerId: 'p1' }, at(2)))).toBe(
      'INVALID_PLAYER',
    );
    expect(codeOf(reduce(state, { type: 'REMOVE_PLAYER', playerId: 'ghost' }, at(2)))).toBe(
      'INVALID_PLAYER',
    );
  });
});

describe('lifecycle: lobby → starting → active', () => {
  it('stays in the lobby until every player is ready', () => {
    const one = must(processPlayerAction(lobby('tag', 3), ready('p0'), at(10)));
    const two = must(processPlayerAction(one, ready('p1'), at(20)));
    expect(two.status).toBe('lobby');
    expect(two.players.map((player) => player.ready)).toEqual([true, true, false]);
  });

  it('starts when the last player is ready, with no host command', () => {
    const state = started('tag', 3);
    expect(state.status).toBe('active');
    expect(state.startedAt).toBe(at(START).now);
    expect(state.currentRound).toBe(1);
  });

  it('passes through starting: roles are assigned, then ROUND_START begins the round', () => {
    const state = started('tag', 3);
    const kinds = state.history.slice(-3).map((entry) => entry.record.kind);
    expect(kinds).toEqual(['ACTION', 'ROLES_ASSIGNED', 'EVENT']);
    expect(eventTypes(state)).toEqual(['ROUND_START']);
    expect(canTransition('lobby', 'starting')).toBe(true);
    expect(canTransition('starting', 'active')).toBe(true);
    expect(canTransition('lobby', 'active')).toBe(false);
  });

  it('does not start with fewer players than the game needs', () => {
    const state = must(processPlayerAction(lobby('tag', 1), ready('p0'), at(10)));
    expect(state.status).toBe('lobby');
  });

  it('ignores players who left when deciding whether everyone is ready', () => {
    let state = lobby('tag', 3);
    state = must(reduce(state, { type: 'REMOVE_PLAYER', playerId: 'p2' }, at(5)));
    state = must(processPlayerAction(state, ready('p0'), at(10)));
    state = must(processPlayerAction(state, ready('p1'), at(20)));
    expect(state.status).toBe('active');
    expect(state.players.find((player) => player.id === 'p2')?.roleId).toBeNull();
  });

  it('assigns the same roles for the same seed and joining order', () => {
    const roles = (seed: number) => started('tag', 4, seed).players.map((player) => player.roleId);
    expect(roles(42)).toEqual(roles(42));
  });

  it('refuses joining and readying once the game has started', () => {
    const state = started('tag', 3);
    expect(
      codeOf(reduce(state, { type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Late' }, at(START))),
    ).toBe('GAME_ALREADY_STARTED');
    expect(codeOf(processPlayerAction(state, ready('p0'), at(START + 1)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('rejects a ready report from an unknown player', () => {
    expect(codeOf(processPlayerAction(lobby('tag', 2), ready('ghost'), at(1)))).toBe(
      'INVALID_PLAYER',
    );
  });
});

describe('lifecycle: rounds', () => {
  it('goes active → round_end → active when a round runs out', () => {
    const next = must(advanceTime(started('tag', 3), at(START + TAG_ROUND_MS)));
    expect(eventTypes(next)).toEqual(['ROUND_START', 'ROUND_END', 'ROUND_START']);
    expect(next.status).toBe('active');
    expect(next.currentRound).toBe(2);
  });

  it('goes round_end → completed after the final round', () => {
    const done = must(advanceTime(started('tag', 3), at(START + 3 * TAG_ROUND_MS)));
    expect(done.status).toBe('completed');
    expect(eventTypes(done).slice(-2)).toEqual(['ROUND_END', 'GAME_END']);
    expect(done.timer).toEqual({ endsAt: null, pausedAt: null });
    expect(done.winnerIds.length).toBeGreaterThan(0);
  });

  it('does nothing before the timer runs out', () => {
    const state = started('tag', 3);
    const next = must(advanceTime(state, at(START + TAG_ROUND_MS - 1)));
    expect(next).toEqual(state);
  });
});

describe('lifecycle: pause and abort', () => {
  const pause = { type: 'PAUSE_SESSION' as const, reason: 'water break' };
  const resume = { type: 'RESUME_SESSION' as const };

  it('pauses only a running round and resumes only a paused game', () => {
    expect(codeOf(reduce(lobby('tag', 2), pause, at(1)))).toBe('INVALID_STATE_TRANSITION');
    expect(codeOf(reduce(started('tag', 3), resume, at(START + 1)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const paused = must(reduce(started('tag', 3), pause, at(START + 60_000)));
    expect(paused.status).toBe('paused');
    expect(must(reduce(paused, resume, at(START + 70_000))).status).toBe('active');
  });

  it('freezes the round timer for the length of the pause', () => {
    const paused = must(reduce(started('tag', 3), pause, at(START + 60_000)));
    const resumed = must(reduce(paused, resume, at(START + 60_000 + 300_000)));

    // 120 seconds were left when the game paused; 120 seconds are left on resume.
    expect(resumed.timer.endsAt).toBe(at(START + TAG_ROUND_MS + 300_000).now);
    expect(resumed.timer.pausedAt).toBeNull();
    expect(must(advanceTime(resumed, at(START + TAG_ROUND_MS + 299_999))).currentRound).toBe(1);
    expect(must(advanceTime(resumed, at(START + TAG_ROUND_MS + 300_000))).currentRound).toBe(2);
  });

  it('does not let time run a paused game: a paused game cannot complete', () => {
    const paused = must(reduce(started('tag', 3), pause, at(START + 60_000)));
    const later = must(advanceTime(paused, at(START + 100 * TAG_ROUND_MS)));
    expect(later.status).toBe('paused');
    expect(later.currentRound).toBe(1);
    expect(canTransition('paused', 'completed')).toBe(false);
  });

  it('freezes modifiers and objectives during a pause too', () => {
    let state = started('tag', 3);
    state = must(
      submitGameEvent(
        state,
        { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 },
        'game-master',
        at(START + 10_000),
      ),
    );
    const paused = must(reduce(state, pause, at(START + 20_000)));
    const resumed = must(reduce(paused, resume, at(START + 120_000)));
    // 50 seconds were left on the zone; it now expires 50 seconds after the resume.
    expect(resumed.activeModifiers[0]?.expiresAt).toBe(at(START + 170_000).now);
  });

  it('refuses actions and events while paused', () => {
    const state = started('tag', 3);
    const [tagger] = holders(state, 'tagger');
    const [runner] = holders(state, 'runner');
    const paused = must(reduce(state, pause, at(START + 60_000)));
    expect(
      codeOf(
        processPlayerAction(
          paused,
          { type: 'PLAYER_TAGGED', playerId: tagger, targetPlayerId: runner },
          at(START + 61_000),
        ),
      ),
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      codeOf(
        submitGameEvent(
          paused,
          { type: 'TIME_EXTENSION', seconds: 30 },
          'human',
          at(START + 61_000),
        ),
      ),
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('aborts from the lobby, a running round, and a pause', () => {
    const abort = { type: 'ABORT_SESSION' as const, reason: 'rain' };
    const running = started('tag', 3);
    const paused = must(reduce(running, pause, at(START + 60_000)));

    for (const [state, when] of [
      [lobby('tag', 2), 5],
      [running, START + 5],
      [paused, START + 70_000],
    ] as const) {
      const aborted = must(reduce(state, abort, at(when)));
      expect(aborted.status).toBe('aborted');
      expect(aborted.endedAt).toBe(at(when).now);
      expect(aborted.winnerIds).toEqual([]);
      expect(gameStateSchema.safeParse(aborted).success).toBe(true);
    }
  });

  it('accepts nothing after the game has ended', () => {
    const aborted = must(
      reduce(started('tag', 3), { type: 'ABORT_SESSION', reason: 'rain' }, at(START + 5)),
    );
    const later = at(START + 10);
    expect(codeOf(reduce(aborted, pause, later))).toBe('GAME_ALREADY_COMPLETED');
    expect(codeOf(reduce(aborted, { type: 'ABORT_SESSION', reason: 'again' }, later))).toBe(
      'GAME_ALREADY_COMPLETED',
    );
    expect(codeOf(processPlayerAction(aborted, ready('p0'), later))).toBe('GAME_ALREADY_COMPLETED');
    expect(
      codeOf(submitGameEvent(aborted, { type: 'TIME_EXTENSION', seconds: 30 }, 'human', later)),
    ).toBe('GAME_ALREADY_COMPLETED');
    expect(must(advanceTime(aborted, at(START + 10 * TAG_ROUND_MS)))).toEqual(aborted);
  });
});

describe('time', () => {
  it('gives the same state whether time advances in one step or many', () => {
    const state = started('tag', 3);
    const end = START + 3 * TAG_ROUND_MS + 5_000;

    const oneStep = must(advanceTime(state, at(end)));
    let manySteps = state;
    for (let ms = START; ms <= end; ms += 7_919) {
      manySteps = must(advanceTime(manySteps, at(ms)));
    }
    manySteps = must(advanceTime(manySteps, at(end)));

    expect(manySteps).toEqual(oneStep);
  });

  it('stamps round events with the moment they were due, not the moment they were noticed', () => {
    const next = must(advanceTime(started('tag', 3), at(START + TAG_ROUND_MS + 45_000)));
    const roundEnd = next.history.find(
      (entry) => entry.record.kind === 'EVENT' && entry.record.event.type === 'ROUND_END',
    );
    expect(roundEnd?.at).toBe(at(START + TAG_ROUND_MS).now);
  });

  it('runs several rounds in a single advance', () => {
    const next = must(advanceTime(started('tag', 3), at(START + 2 * TAG_ROUND_MS + 1)));
    expect(next.currentRound).toBe(3);
  });

  it('refuses to go backwards', () => {
    expect(codeOf(advanceTime(started('tag', 3), at(START - 1)))).toBe('INVALID_STATE_TRANSITION');
  });

  it('extends the running round with TIME_EXTENSION', () => {
    const extended = must(
      submitGameEvent(
        started('tag', 3),
        { type: 'TIME_EXTENSION', seconds: 60 },
        'game-master',
        at(START + 10_000),
      ),
    );
    expect(extended.timer.endsAt).toBe(at(START + TAG_ROUND_MS + 60_000).now);
    expect(must(advanceTime(extended, at(START + TAG_ROUND_MS + 59_999))).currentRound).toBe(1);
    expect(must(advanceTime(extended, at(START + TAG_ROUND_MS + 60_000))).currentRound).toBe(2);
  });

  it('never reads the wall clock or a random source', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now() was called');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random() was called');
    });

    const state = started('tag', 4);
    const [tagger] = holders(state, 'tagger');
    const [runner] = holders(state, 'runner');
    const tagged = must(
      processPlayerAction(
        state,
        { type: 'PLAYER_TAGGED', playerId: tagger, targetPlayerId: runner },
        at(START + 5_000),
      ),
    );
    expect(must(advanceTime(tagged, at(START + 3 * TAG_ROUND_MS))).status).toBe('completed');
  });
});

describe('external events', () => {
  const zone = {
    type: 'ZONE_CHANGE',
    modifier: 'SAFE_ZONE',
    zone: 'the bench',
    durationSeconds: 60,
  };

  it('stores a zone and drops it when its time is up', () => {
    const state = must(submitGameEvent(started('tag', 3), zone, 'game-master', at(START + 10_000)));
    expect(state.activeModifiers).toEqual([
      expect.objectContaining({
        kind: 'SAFE_ZONE',
        zone: 'the bench',
        expiresAt: at(START + 70_000).now,
      }),
    ]);
    expect(state.history.at(-1)).toMatchObject({
      source: 'game-master',
      record: { kind: 'EVENT' },
    });
    expect(must(advanceTime(state, at(START + 69_999))).activeModifiers).toHaveLength(1);
    expect(must(advanceTime(state, at(START + 70_000))).activeModifiers).toHaveLength(0);
  });

  it('rejects a malformed event', () => {
    const result = submitGameEvent(
      started('tag', 3),
      { ...zone, durationSeconds: 99_999 },
      'game-master',
      at(START + 1),
    );
    expect(codeOf(result)).toBe('INVALID_EVENT');
    expect(
      codeOf(submitGameEvent(started('tag', 3), { type: 'SET_SCORE' }, 'human', at(START + 1))),
    ).toBe('INVALID_EVENT');
  });

  it('rejects an event kind the game does not support', () => {
    const challenge = {
      type: 'CHALLENGE',
      challengeId: 'c1',
      description: 'Touch three trees.',
      playerIds: ['p0'],
      points: 2,
      durationSeconds: 60,
    };
    expect(
      codeOf(submitGameEvent(started('tag', 3), challenge, 'game-master', at(START + 1))),
    ).toBe('UNSUPPORTED_EVENT');
  });

  it('rejects gameplay events before the game has started', () => {
    expect(codeOf(submitGameEvent(lobby('tag', 3), zone, 'game-master', at(1)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('accepts no lifecycle or derived event from outside', () => {
    const state = started('tag', 3);
    for (const event of [
      { type: 'ROUND_START', round: 2, durationSeconds: 180 },
      { type: 'ROUND_END', round: 1 },
      { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
      { type: 'POWER_ACTIVATED', playerId: 'p0', powerId: 'shield', durationSeconds: 20 },
      { type: 'OBJECTIVE_COMPLETED', playerId: 'p0', objectiveId: 'o1', points: 5 },
    ]) {
      expect(codeOf(submitGameEvent(state, event, 'game-master', at(START + 1)))).toBe(
        'UNSUPPORTED_EVENT',
      );
    }
  });

  it('rejects an outside ROLE_CHANGE that claims to be a tag', () => {
    const state = started('tag', 3);
    const [tagger] = holders(state, 'tagger');
    const [runner] = holders(state, 'runner');
    const forged = {
      type: 'ROLE_CHANGE',
      assignments: [
        { playerId: runner, roleId: 'tagger' },
        { playerId: tagger, roleId: 'runner' },
      ],
      cause: { reason: 'TAGGED', byPlayerId: tagger, targetPlayerId: runner },
    };
    expect(codeOf(submitGameEvent(state, forged, 'game-master', at(START + 1)))).toBe(
      'INVALID_EVENT',
    );
  });

  it('applies a plain ROLE_CHANGE without awarding anything', () => {
    const state = started('tag', 3);
    const [tagger] = holders(state, 'tagger');
    const [runner] = holders(state, 'runner');
    const swapped = must(
      submitGameEvent(
        state,
        {
          type: 'ROLE_CHANGE',
          assignments: [
            { playerId: runner, roleId: 'tagger' },
            { playerId: tagger, roleId: 'runner' },
          ],
        },
        'game-master',
        at(START + 1),
      ),
    );
    expect(holders(swapped, 'tagger')).toEqual([runner]);
    expect(swapped.players.every((player) => player.score === 0)).toBe(true);
    expect(swapped.history.at(-1)?.awards).toBeUndefined();
  });

  it('rejects a role change that would leave two taggers or none', () => {
    const state = started('tag', 3);
    const [tagger] = holders(state, 'tagger');
    const [runner] = holders(state, 'runner');
    const twoTaggers = {
      type: 'ROLE_CHANGE',
      assignments: [{ playerId: runner, roleId: 'tagger' }],
    };
    const noTagger = { type: 'ROLE_CHANGE', assignments: [{ playerId: tagger, roleId: 'runner' }] };
    expect(codeOf(submitGameEvent(state, twoTaggers, 'game-master', at(START + 1)))).toBe(
      'INVALID_ROLE',
    );
    expect(codeOf(submitGameEvent(state, noTagger, 'game-master', at(START + 1)))).toBe(
      'INVALID_ROLE',
    );
  });

  it('stores a freeze period but enforces nothing for it', () => {
    const state = started('hide-and-seek', 3);
    const [seeker] = holders(state, 'seeker');
    const [hider] = holders(state, 'hider');
    const frozen = must(
      submitGameEvent(
        state,
        {
          type: 'RULE_MODIFIER',
          modifier: 'FREEZE_PERIOD',
          roleIds: ['seeker'],
          durationSeconds: 60,
        },
        'game-master',
        at(START + 1_000),
      ),
    );
    expect(frozen.activeModifiers).toEqual([expect.objectContaining({ kind: 'FREEZE_PERIOD' })]);
    // No behaviour is attached to FREEZE_PERIOD in this phase: the seeker can still act.
    expect(
      codeOf(
        processPlayerAction(
          frozen,
          { type: 'PLAYER_FOUND', playerId: seeker, targetPlayerId: hider },
          at(START + 2_000),
        ),
      ),
    ).toBe('ok');
  });
});

describe('objectives', () => {
  const objective = {
    type: 'BONUS_OBJECTIVE',
    objectiveId: 'oak',
    description: 'First to the oak scores.',
    points: 4,
    durationSeconds: 60,
  };
  const complete = (playerId: string) => ({
    type: 'PLAYER_COMPLETED_CHALLENGE' as const,
    playerId,
    challengeId: 'oak',
  });
  const withObjective = (): GameState =>
    must(submitGameEvent(started('tag', 3), objective, 'game-master', at(START + 10_000)));

  it('awards the objective points to the player who completes it, with the cause recorded', () => {
    const next = must(processPlayerAction(withObjective(), complete('p1'), at(START + 20_000)));
    expect(scoreOf(next, 'p1')).toBe(4);
    expect(next.history.at(-1)).toMatchObject({
      record: {
        kind: 'EVENT',
        event: { type: 'OBJECTIVE_COMPLETED', playerId: 'p1', objectiveId: 'oak', points: 4 },
      },
      awards: [{ playerId: 'p1', reason: 'OBJECTIVE_COMPLETED', points: 4 }],
    });
  });

  it('lets a player complete an objective once', () => {
    const once = must(processPlayerAction(withObjective(), complete('p1'), at(START + 20_000)));
    expect(codeOf(processPlayerAction(once, complete('p1'), at(START + 21_000)))).toBe(
      'INVALID_ACTION',
    );
    expect(scoreOf(once, 'p1')).toBe(4);
  });

  it('refuses a completion after the objective has expired, or for an unknown one', () => {
    expect(codeOf(processPlayerAction(withObjective(), complete('p1'), at(START + 70_000)))).toBe(
      'INVALID_ACTION',
    );
    expect(codeOf(processPlayerAction(started('tag', 3), complete('p1'), at(START + 1)))).toBe(
      'INVALID_ACTION',
    );
  });

  it('refuses a second objective with an id that is still active', () => {
    expect(
      codeOf(submitGameEvent(withObjective(), objective, 'game-master', at(START + 11_000))),
    ).toBe('INVALID_EVENT');
  });
});

describe('PLAYER_ACCEPTED_EVENT', () => {
  it('is recorded as an acknowledgement and changes nothing else', () => {
    const state = must(
      submitGameEvent(
        started('tag', 3),
        { type: 'TIME_EXTENSION', seconds: 30 },
        'game-master',
        at(START + 1_000),
      ),
    );
    const eventId = state.history.at(-1)?.id;
    const next = must(
      processPlayerAction(
        state,
        { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p0', eventId },
        at(START + 2_000),
      ),
    );

    expect(next.history).toHaveLength(state.history.length + 1);
    expect(next.history.at(-1)?.record).toEqual({
      kind: 'ACTION',
      action: { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p0', eventId },
    });
    expect({ ...next, history: [] }).toEqual({ ...state, history: [] });
  });

  it('must name an event that is in the history', () => {
    const result = processPlayerAction(
      started('tag', 3),
      { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p0', eventId: 'nope' },
      at(START + 1),
    );
    expect(codeOf(result)).toBe('INVALID_ACTION');
  });
});

describe('replay and determinism', () => {
  const create = {
    type: 'CREATE_SESSION' as const,
    sessionId: 'g1',
    gameId: 'tag',
    joinCode: 'GRASS7',
    randomSeed: 7,
  };

  /** A full recorded game: join, ready, a power, tags, a pause, and time to the end. */
  function script(): TimedInput[] {
    const live = started('tag', 3);
    const [tagger] = holders(live, 'tagger');
    const [r1, r2] = holders(live, 'runner');
    const input = (ms: number, value: EngineInput): TimedInput => ({ at: T0 + ms, input: value });
    const tag = (playerId?: string, targetPlayerId?: string): EngineInput => ({
      type: 'ACTION',
      action: { type: 'PLAYER_TAGGED', playerId, targetPlayerId },
    });

    return [
      ...['p0', 'p1', 'p2'].map((id, index) =>
        input(0, {
          type: 'COMMAND',
          command: { type: 'ADD_PLAYER', playerId: id, displayName: `Player ${index}` },
        }),
      ),
      ...['p0', 'p1', 'p2'].map((id) => input(START, { type: 'ACTION', action: ready(id) })),
      input(START + 2_000, {
        type: 'EVENT',
        source: 'game-master',
        event: { type: 'POWER_UP', playerId: r2, powerId: 'shield' },
      }),
      input(START + 5_000, tag(tagger, r1)),
      input(START + 9_000, {
        type: 'ACTION',
        action: { type: 'PLAYER_ACTIVATED_POWER', playerId: r2, powerId: 'shield' },
      }),
      input(START + 40_000, tag(r1, r2)),
      input(START + 60_000, {
        type: 'COMMAND',
        command: { type: 'PAUSE_SESSION', reason: 'water' },
      }),
      input(START + 90_000, { type: 'COMMAND', command: { type: 'RESUME_SESSION' } }),
      input(START + 200_000, { type: 'ADVANCE_TIME' }),
      input(START + 250_000, tag(r2, tagger)),
      input(START + 3 * TAG_ROUND_MS + 30_000, { type: 'ADVANCE_TIME' }),
    ];
  }

  it('replays a recorded game to an identical final state', () => {
    const first = must(replay(create, T0, script()));
    const second = must(replay(create, T0, script()));
    expect(first.status).toBe('completed');
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('gives the same state as applying the inputs one at a time', () => {
    let state = must(createSession(create, at(0)));
    for (const { at: time, input } of script()) {
      state = must(step(state, input, at(time - T0)));
    }
    expect(state).toEqual(must(replay(create, T0, script())));
  });

  it('produces a schema-valid state after every input', () => {
    let state = must(createSession(create, at(0)));
    for (const { at: time, input } of script()) {
      state = must(step(state, input, at(time - T0)));
      const parsed = gameStateSchema.safeParse(state);
      expect(parsed.success).toBe(true);
    }
  });

  it('survives a JSON round trip mid-game and continues identically', () => {
    const inputs = script();
    const half = Math.floor(inputs.length / 2);
    let state = must(createSession(create, at(0)));
    for (const { at: time, input } of inputs.slice(0, half)) {
      state = must(step(state, input, at(time - T0)));
    }
    let restored = gameStateSchema.parse(JSON.parse(JSON.stringify(state)));
    for (const { at: time, input } of inputs.slice(half)) {
      state = must(step(state, input, at(time - T0)));
      restored = must(step(restored, input, at(time - T0)));
    }
    expect(restored).toEqual(state);
  });

  it('stops a replay at the first refused input', () => {
    const bad: TimedInput[] = [
      { at: T0 + 1, input: { type: 'COMMAND', command: { type: 'RESUME_SESSION' } } },
    ];
    expect(codeOf(replay(create, T0, bad))).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('state safety under arbitrary input', () => {
  /**
   * Feeds a game a long stream of seeded pseudo-random inputs, valid and invalid
   * alike, and checks the invariants after every one. The stream is generated
   * from a fixed seed, so a failure is reproducible.
   */
  function fuzz(gameId: 'tag' | 'hide-and-seek', seed: number): void {
    const rng = createRng(seed);
    const definition = getGameDefinition(gameId);
    const ids = ['p0', 'p1', 'p2', 'p3', 'ghost'];
    const pick = (): string => ids[rng.nextInt(ids.length)] ?? 'p0';
    let state = started(gameId, 4, seed);
    let ms = START;
    let accepted = 0;
    let refused = 0;

    for (let i = 0; i < 400; i += 1) {
      ms += rng.nextInt(20_000);
      const choice = rng.nextInt(9);
      const input: EngineInput =
        choice === 0
          ? { type: 'ADVANCE_TIME' }
          : choice === 1
            ? {
                type: 'ACTION',
                action: { type: 'PLAYER_TAGGED', playerId: pick(), targetPlayerId: pick() },
              }
            : choice === 2
              ? {
                  type: 'ACTION',
                  action: { type: 'PLAYER_FOUND', playerId: pick(), targetPlayerId: pick() },
                }
              : choice === 3
                ? {
                    type: 'ACTION',
                    action: { type: 'PLAYER_ACTIVATED_POWER', playerId: pick(), powerId: 'shield' },
                  }
                : choice === 4
                  ? {
                      type: 'EVENT',
                      source: 'game-master',
                      event: { type: 'POWER_UP', playerId: pick(), powerId: 'shield' },
                    }
                  : choice === 5
                    ? {
                        type: 'EVENT',
                        source: 'game-master',
                        event: {
                          type: 'ROLE_CHANGE',
                          assignments: [
                            {
                              playerId: pick(),
                              roleId:
                                definition.roles[rng.nextInt(definition.roles.length)]?.id ?? 'x',
                            },
                          ],
                        },
                      }
                    : choice === 6
                      ? {
                          type: 'COMMAND',
                          command:
                            rng.nextInt(2) === 0
                              ? { type: 'PAUSE_SESSION', reason: 'fuzz' }
                              : { type: 'RESUME_SESSION' },
                        }
                      : choice === 7
                        ? {
                            type: 'ACTION',
                            action: { type: 'PLAYER_TAGGED', playerId: pick(), score: -50 },
                          }
                        : {
                            type: 'EVENT',
                            source: 'game-master',
                            event: { type: 'TIME_EXTENSION', seconds: 5 + rng.nextInt(60) },
                          };

      const before = structuredClone(state);
      const result = step(state, input, at(ms));
      // A refusal must leave the caller's state exactly as it was.
      expect(state).toEqual(before);
      if (!result.ok) {
        refused += 1;
        continue;
      }
      accepted += 1;
      state = result.value;

      expect(gameStateSchema.safeParse(state).success).toBe(true);
      expect(state.players.every((player) => player.score >= 0)).toBe(true);
      expect(state.players.length).toBeLessThanOrEqual(definition.maxPlayers);
      // Scores never go down.
      for (const player of state.players) {
        expect(player.score).toBeGreaterThanOrEqual(
          before.players.find((old) => old.id === player.id)?.score ?? 0,
        );
      }
      if (state.status === 'active' || state.status === 'paused') {
        for (const role of definition.roles) {
          const count = holders(state, role.id).length;
          expect(count).toBeGreaterThanOrEqual(role.min);
          if (role.max !== undefined) expect(count).toBeLessThanOrEqual(role.max);
        }
      }
      if (before.status === 'completed' || before.status === 'aborted') {
        expect(state.status).toBe(before.status);
      }
    }

    // The stream must exercise both paths, or the invariants above prove nothing.
    expect(accepted).toBeGreaterThan(40);
    expect(refused).toBeGreaterThan(40);
    // Long enough to finish every round, unless the stream happened to end on a pause.
    expect(['completed', 'paused']).toContain(state.status);
  }

  it.each([1, 2, 3, 4, 5])('holds every invariant for Tag (seed %i)', (seed) => {
    fuzz('tag', seed);
  });

  it.each([1, 2, 3, 4, 5])('holds every invariant for Hide & Seek (seed %i)', (seed) => {
    fuzz('hide-and-seek', seed);
  });
});
