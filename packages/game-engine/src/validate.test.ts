import { describe, expect, it } from 'vitest';
import { getGameDefinition } from '@touchgrass/game-definitions';
import type { PlayerAction } from './actions';
import type { EngineErrorCode } from './errors';
import type { GameEvent } from './events';
import { type GameState, type GameStatus, gameStateSchema } from './state';
import { validateGameEvent, validatePlayerAction } from './validate';

const T0 = 1_700_000_000_000;

/**
 * A hand-built state, checked against the schema. The reducer cannot yet produce
 * a round in progress with objectives and held powers, and validation must be
 * testable without it.
 */
function game(gameId: 'tag' | 'hide-and-seek', overrides: Partial<GameState> = {}): GameState {
  const [chaser, runner] = gameId === 'tag' ? ['tagger', 'runner'] : ['seeker', 'hider'];
  const player = (id: string, roleId: string) => ({
    id,
    displayName: id.toUpperCase(),
    roleId,
    score: 0,
    status: 'active' as const,
    ready: true,
    powers: [],
    joinedAt: T0,
  });
  return gameStateSchema.parse({
    id: 'g1',
    gameId,
    joinCode: 'GRASS7',
    status: 'active',
    phaseIndex: 0,
    settings: getGameDefinition(gameId).settings,
    currentRound: 1,
    timer: { endsAt: T0 + 180_000, pausedAt: null },
    players: [player('p1', chaser), player('p2', runner), player('p3', runner)],
    activeModifiers: [],
    activeObjectives: [],
    history: [],
    winnerIds: [],
    createdAt: T0,
    startedAt: T0,
    endedAt: null,
    randomSeed: 1,
    ...overrides,
  });
}

function withStatus(state: GameState, status: GameStatus): GameState {
  const terminal = status === 'completed' || status === 'aborted';
  return gameStateSchema.parse({
    ...state,
    status,
    timer: { ...state.timer, pausedAt: status === 'paused' ? T0 + 1 : null },
    startedAt: status === 'lobby' ? null : state.startedAt,
    endedAt: terminal ? T0 + 1 : null,
  });
}

function expectEvent(event: GameEvent, state: GameState, expected: 'ok' | EngineErrorCode): void {
  const result = validateGameEvent(event, getGameDefinition(state.gameId), state);
  expect(result.ok ? 'ok' : result.error.code).toBe(expected);
}

function expectAction(
  action: PlayerAction,
  state: GameState,
  expected: 'ok' | EngineErrorCode,
): void {
  const result = validatePlayerAction(action, getGameDefinition(state.gameId), state, T0);
  expect(result.ok ? 'ok' : result.error.code).toBe(expected);
}

const ZONE: GameEvent = {
  type: 'ZONE_CHANGE',
  modifier: 'SAFE_ZONE',
  zone: 'the bench by the gate',
  durationSeconds: 60,
};

describe('validateGameEvent', () => {
  it('accepts an event the game supports while a round is running', () => {
    expectEvent(ZONE, game('tag'), 'ok');
  });

  it('never changes the state it is given', () => {
    const state = game('tag');
    const snapshot = structuredClone(state);
    validateGameEvent(ZONE, getGameDefinition('tag'), state);
    expect(state).toEqual(snapshot);
  });

  it('rejects an event kind the game does not support', () => {
    // Tag has no CHALLENGE; Hide & Seek has no POWER_UP.
    expectEvent(
      {
        type: 'CHALLENGE',
        challengeId: 'c1',
        description: 'Touch three trees.',
        playerIds: ['p2'],
        points: 2,
        durationSeconds: 60,
      },
      game('tag'),
      'UNSUPPORTED_EVENT',
    );
    expectEvent(
      { type: 'POWER_UP', playerId: 'p2', powerId: 'shield' },
      game('hide-and-seek'),
      'UNSUPPORTED_EVENT',
    );
  });

  it('rejects a modifier the game does not allow', () => {
    // Tag allows RULE_MODIFIER neither as an event nor FREEZE_PERIOD as a modifier,
    // so use a definition that allows the event but not this modifier.
    const definition = {
      ...getGameDefinition('tag'),
      allowedModifiers: getGameDefinition('tag').allowedModifiers.filter(
        (modifier) => modifier !== 'SAFE_ZONE',
      ),
    };
    const result = validateGameEvent(ZONE, definition, game('tag'));
    expect(result.ok ? 'ok' : result.error.code).toBe('INVALID_MODIFIER');
  });

  it('rejects gameplay events before the game starts', () => {
    expectEvent(ZONE, withStatus(game('tag'), 'lobby'), 'INVALID_STATE_TRANSITION');
    expectEvent(ZONE, withStatus(game('tag'), 'starting'), 'INVALID_STATE_TRANSITION');
  });

  it('rejects gameplay events while paused or between rounds', () => {
    expectEvent(ZONE, withStatus(game('tag'), 'paused'), 'INVALID_STATE_TRANSITION');
    expectEvent(ZONE, withStatus(game('tag'), 'round_end'), 'INVALID_STATE_TRANSITION');
  });

  it('rejects every event once the game has ended', () => {
    for (const status of ['completed', 'aborted'] as const) {
      expectEvent(ZONE, withStatus(game('tag'), status), 'GAME_ALREADY_COMPLETED');
      expectEvent(
        { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
        withStatus(game('tag'), status),
        'GAME_ALREADY_COMPLETED',
      );
    }
  });

  it('rejects an event for a player who is not in the game', () => {
    expectEvent(
      { type: 'POWER_UP', playerId: 'ghost', powerId: 'shield' },
      game('tag'),
      'INVALID_PLAYER',
    );
    expectEvent(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'ghost', roleId: 'runner' }] },
      game('tag'),
      'INVALID_PLAYER',
    );
  });

  it('rejects an event for a player who has left', () => {
    const state = game('tag');
    const players = state.players.map((player) =>
      player.id === 'p2' ? { ...player, status: 'left' as const } : player,
    );
    expectEvent(
      { type: 'POWER_UP', playerId: 'p2', powerId: 'shield' },
      { ...state, players },
      'INVALID_PLAYER',
    );
  });

  it('rejects a power the game does not define', () => {
    expectEvent(
      { type: 'POWER_UP', playerId: 'p2', powerId: 'jetpack' },
      game('tag'),
      'INVALID_EVENT',
    );
    expectEvent({ type: 'POWER_UP', playerId: 'p2', powerId: 'shield' }, game('tag'), 'ok');
  });

  it('rejects a role the game does not define', () => {
    expectEvent(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p2', roleId: 'wizard' }] },
      game('tag'),
      'INVALID_ROLE',
    );
    expectEvent(
      {
        type: 'RULE_MODIFIER',
        modifier: 'FREEZE_PERIOD',
        roleIds: ['wizard'],
        durationSeconds: 30,
      },
      game('hide-and-seek'),
      'INVALID_ROLE',
    );
    expectEvent(
      {
        type: 'RULE_MODIFIER',
        modifier: 'FREEZE_PERIOD',
        roleIds: ['seeker'],
        durationSeconds: 30,
      },
      game('hide-and-seek'),
      'ok',
    );
  });

  it('ends the game only between rounds, after the last one', () => {
    const end: GameEvent = { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' };
    expectEvent(end, game('tag'), 'INVALID_STATE_TRANSITION');
    expectEvent(end, withStatus(game('tag'), 'lobby'), 'INVALID_STATE_TRANSITION');
    expectEvent(end, withStatus(game('tag'), 'round_end'), 'INVALID_EVENT');
    expectEvent(end, withStatus(game('tag', { currentRound: 3 }), 'round_end'), 'ok');
  });
});

describe('validatePlayerAction', () => {
  it('accepts the tagger tagging a runner', () => {
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' },
      game('tag'),
      'ok',
    );
  });

  it('accepts the seeker finding a hider', () => {
    expectAction(
      { type: 'PLAYER_FOUND', playerId: 'p1', targetPlayerId: 'p2' },
      game('hide-and-seek'),
      'ok',
    );
  });

  it('never changes the state it is given', () => {
    const state = game('tag');
    const snapshot = structuredClone(state);
    validatePlayerAction(
      { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' },
      getGameDefinition('tag'),
      state,
      T0,
    );
    expect(state).toEqual(snapshot);
  });

  it('rejects a runner tagging anyone, and the tagger tagging nobody in particular', () => {
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p2', targetPlayerId: 'p1' },
      game('tag'),
      'INVALID_ROLE',
    );
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p2', targetPlayerId: 'p3' },
      game('tag'),
      'INVALID_ROLE',
    );
  });

  it('rejects a hider finding the seeker', () => {
    expectAction(
      { type: 'PLAYER_FOUND', playerId: 'p2', targetPlayerId: 'p1' },
      game('hide-and-seek'),
      'INVALID_ROLE',
    );
  });

  it('rejects an action the game does not have', () => {
    expectAction(
      { type: 'PLAYER_FOUND', playerId: 'p1', targetPlayerId: 'p2' },
      game('tag'),
      'INVALID_ACTION',
    );
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' },
      game('hide-and-seek'),
      'INVALID_ACTION',
    );
  });

  it('rejects an action from an unknown player or against one', () => {
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'ghost', targetPlayerId: 'p2' },
      game('tag'),
      'INVALID_PLAYER',
    );
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'ghost' },
      game('tag'),
      'INVALID_PLAYER',
    );
  });

  it('rejects an action from a player who has left', () => {
    const state = game('tag');
    const players = state.players.map((player) =>
      player.id === 'p1' ? { ...player, status: 'left' as const } : player,
    );
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' },
      { ...state, players },
      'INVALID_PLAYER',
    );
  });

  it('rejects finding a hider who is already out, and actions by a player who is out', () => {
    const state = game('hide-and-seek');
    const players = state.players.map((player) =>
      player.id === 'p2' ? { ...player, status: 'out' as const } : player,
    );
    expectAction(
      { type: 'PLAYER_FOUND', playerId: 'p1', targetPlayerId: 'p2' },
      { ...state, players },
      'INVALID_ACTION',
    );
    expectAction(
      { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p2', eventId: 'entry-0' },
      { ...state, players },
      'INVALID_ACTION',
    );
  });

  it('rejects gameplay actions unless a round is running', () => {
    const tagged: PlayerAction = { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' };
    for (const status of ['lobby', 'starting', 'round_end', 'paused'] as const) {
      expectAction(tagged, withStatus(game('tag'), status), 'INVALID_STATE_TRANSITION');
    }
  });

  it('rejects every action once the game has ended', () => {
    for (const status of ['completed', 'aborted'] as const) {
      expectAction(
        { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' },
        withStatus(game('tag'), status),
        'GAME_ALREADY_COMPLETED',
      );
      expectAction(
        { type: 'PLAYER_READY', playerId: 'p1' },
        withStatus(game('tag'), status),
        'GAME_ALREADY_COMPLETED',
      );
    }
  });

  it('accepts PLAYER_READY only in the lobby', () => {
    const ready: PlayerAction = { type: 'PLAYER_READY', playerId: 'p2' };
    expectAction(ready, withStatus(game('tag'), 'lobby'), 'ok');
    for (const status of ['starting', 'active', 'round_end', 'paused'] as const) {
      expectAction(ready, withStatus(game('tag'), status), 'INVALID_STATE_TRANSITION');
    }
  });

  it('only lets a player activate a power they hold', () => {
    const state = game('tag');
    const activate: PlayerAction = {
      type: 'PLAYER_ACTIVATED_POWER',
      playerId: 'p2',
      powerId: 'shield',
    };
    expectAction(activate, state, 'INVALID_ACTION');

    const players = state.players.map((player) =>
      player.id === 'p2' ? { ...player, powers: ['shield'] } : player,
    );
    expectAction(activate, { ...state, players }, 'ok');
  });

  it('only lets an eligible player complete an active objective, once', () => {
    const objective = {
      id: 'o1',
      source: 'CHALLENGE' as const,
      description: 'Touch three trees.',
      points: 2,
      eligiblePlayerIds: ['p2'],
      completedByPlayerIds: [] as string[],
      expiresAt: T0 + 60_000,
    };
    const complete = (playerId: string): PlayerAction => ({
      type: 'PLAYER_COMPLETED_CHALLENGE',
      playerId,
      challengeId: 'o1',
    });

    expectAction(complete('p2'), game('tag'), 'INVALID_ACTION');
    expectAction(complete('p2'), game('tag', { activeObjectives: [objective] }), 'ok');
    expectAction(complete('p3'), game('tag', { activeObjectives: [objective] }), 'INVALID_ACTION');
    expectAction(
      complete('p2'),
      game('tag', { activeObjectives: [{ ...objective, completedByPlayerIds: ['p2'] }] }),
      'INVALID_ACTION',
    );
    // An objective with no eligibility list is open to everyone.
    expectAction(
      complete('p3'),
      game('tag', { activeObjectives: [{ ...objective, eligiblePlayerIds: [] }] }),
      'ok',
    );
  });

  it('only lets a player accept an event that is in the history', () => {
    const history = [
      {
        id: 'entry-0',
        sequence: 0,
        at: T0,
        source: 'engine' as const,
        summary: 'Extra time.',
        record: { kind: 'EVENT' as const, event: { type: 'TIME_EXTENSION' as const, seconds: 30 } },
      },
      {
        id: 'entry-1',
        sequence: 1,
        at: T0 + 1,
        source: 'human' as const,
        summary: 'P1 is ready.',
        record: {
          kind: 'ACTION' as const,
          action: { type: 'PLAYER_READY' as const, playerId: 'p1' },
        },
      },
    ];
    const state = game('tag', { history });
    expectAction(
      { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p2', eventId: 'entry-0' },
      state,
      'ok',
    );
    expectAction(
      { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p2', eventId: 'entry-1' },
      state,
      'INVALID_ACTION',
    );
    expectAction(
      { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p2', eventId: 'nope' },
      state,
      'INVALID_ACTION',
    );
  });

  it('rejects a tag on a player whose shield is still in force', () => {
    const shield = (expiresAt: number) => ({
      id: 'm1',
      kind: 'TEMPORARY_POWER_UP' as const,
      playerId: 'p2',
      powerId: 'shield',
      expiresAt,
    });
    const tagged: PlayerAction = { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' };
    expectAction(tagged, game('tag', { activeModifiers: [shield(T0 + 1)] }), 'INVALID_ACTION');
    // Expired at exactly `now`: no longer in force.
    expectAction(tagged, game('tag', { activeModifiers: [shield(T0)] }), 'ok');
    // Someone else's shield protects nobody but its holder.
    expectAction(
      { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p3' },
      game('tag', { activeModifiers: [shield(T0 + 1)] }),
      'ok',
    );
  });

  it('rejects completing an objective that has expired', () => {
    const objective = {
      id: 'o1',
      source: 'BONUS_OBJECTIVE' as const,
      description: 'Reach the oak.',
      points: 2,
      eligiblePlayerIds: [],
      completedByPlayerIds: [],
      expiresAt: T0,
    };
    expectAction(
      { type: 'PLAYER_COMPLETED_CHALLENGE', playerId: 'p2', challengeId: 'o1' },
      game('tag', { activeObjectives: [objective] }),
      'INVALID_ACTION',
    );
  });
});

describe('validateGameEvent: engine-derived events', () => {
  it('accepts PLAYER_OUT only as the outcome of a rule of the game', () => {
    const out = (playerId: string, byPlayerId: string): GameEvent => ({
      type: 'PLAYER_OUT',
      playerId,
      byPlayerId,
      reason: 'FOUND',
    });
    expectEvent(out('p2', 'p1'), game('hide-and-seek'), 'ok');
    // A hider cannot put the seeker out, and Tag has no rule that puts anyone out.
    expectEvent(out('p1', 'p2'), game('hide-and-seek'), 'INVALID_ROLE');
    expectEvent(out('p2', 'p1'), game('tag'), 'UNSUPPORTED_EVENT');
    expectEvent(out('ghost', 'p1'), game('hide-and-seek'), 'INVALID_PLAYER');
  });

  it('rejects PLAYER_OUT for a player who is already out', () => {
    const state = game('hide-and-seek');
    const players = state.players.map((player) =>
      player.id === 'p2' ? { ...player, status: 'out' as const } : player,
    );
    expectEvent(
      { type: 'PLAYER_OUT', playerId: 'p2', byPlayerId: 'p1', reason: 'FOUND' },
      { ...state, players },
      'INVALID_EVENT',
    );
  });

  it('accepts a caused ROLE_CHANGE only when it is exactly the swap a rule produces', () => {
    const cause = { reason: 'TAGGED' as const, byPlayerId: 'p1', targetPlayerId: 'p2' };
    expectEvent(
      {
        type: 'ROLE_CHANGE',
        assignments: [
          { playerId: 'p2', roleId: 'tagger' },
          { playerId: 'p1', roleId: 'runner' },
        ],
        cause,
      },
      game('tag'),
      'ok',
    );
    // The cause names p2 but the assignments move p3.
    expectEvent(
      {
        type: 'ROLE_CHANGE',
        assignments: [
          { playerId: 'p3', roleId: 'tagger' },
          { playerId: 'p1', roleId: 'runner' },
        ],
        cause,
      },
      game('tag'),
      'INVALID_EVENT',
    );
    // A runner cannot be the cause of a tag.
    expectEvent(
      {
        type: 'ROLE_CHANGE',
        assignments: [
          { playerId: 'p3', roleId: 'tagger' },
          { playerId: 'p2', roleId: 'runner' },
        ],
        cause: { reason: 'TAGGED', byPlayerId: 'p2', targetPlayerId: 'p3' },
      },
      game('tag'),
      'INVALID_ROLE',
    );
  });

  it('rejects a role change that breaks the role limits of the game', () => {
    expectEvent(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p2', roleId: 'tagger' }] },
      game('tag'),
      'INVALID_ROLE',
    );
    expectEvent(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p1', roleId: 'runner' }] },
      game('tag'),
      'INVALID_ROLE',
    );
  });

  it('accepts POWER_ACTIVATED only for a held power with the duration the game defines', () => {
    const activated = (durationSeconds: number): GameEvent => ({
      type: 'POWER_ACTIVATED',
      playerId: 'p2',
      powerId: 'shield',
      durationSeconds,
    });
    const state = game('tag');
    const holding = {
      ...state,
      players: state.players.map((player) =>
        player.id === 'p2' ? { ...player, powers: ['shield'] } : player,
      ),
    };
    expectEvent(activated(20), state, 'INVALID_EVENT');
    expectEvent(activated(20), holding, 'ok');
    expectEvent(activated(600), holding, 'INVALID_EVENT');
  });

  it('accepts OBJECTIVE_COMPLETED only with the points the objective carries', () => {
    const objective = {
      id: 'o1',
      source: 'BONUS_OBJECTIVE' as const,
      description: 'Reach the oak.',
      points: 2,
      eligiblePlayerIds: [],
      completedByPlayerIds: [],
      expiresAt: T0 + 60_000,
    };
    const completed = (points: number): GameEvent => ({
      type: 'OBJECTIVE_COMPLETED',
      playerId: 'p2',
      objectiveId: 'o1',
      points,
    });
    const state = game('tag', { activeObjectives: [objective] });
    expectEvent(completed(2), state, 'ok');
    expectEvent(completed(10), state, 'INVALID_EVENT');
    expectEvent(completed(2), game('tag'), 'INVALID_EVENT');
  });
});
