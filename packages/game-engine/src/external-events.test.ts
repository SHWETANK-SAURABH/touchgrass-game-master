import { describe, expect, it } from 'vitest';
import { getGameDefinition } from '@touchgrass/game-definitions';
import { submitGameEvent } from './engine';
import {
  type ValidatedGameEvent,
  applyValidatedEvent,
  validateExternalEvent,
} from './external-events';
import { processPlayerAction } from './process-action';
import { reduce } from './reduce';
import type { GameState } from './state';
import { START, at, codeOf, holders, lobby, must, started } from './test-support';

const hideAndSeek = getGameDefinition('hide-and-seek');
const NOW = START + 10_000;

const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };

/** Freezes a state deeply, so any attempt to write to it throws. */
function frozen(state: GameState): GameState {
  const freeze = (value: unknown): void => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.values(value).forEach(freeze);
    }
  };
  freeze(state);
  return state;
}

const validate = (state: GameState, input: unknown, ms = NOW) =>
  validateExternalEvent(state, input, 'game-master', at(ms));

describe('validateExternalEvent', () => {
  it('accepts a legal event and returns it tied to the state it was checked against', () => {
    const state = started('tag', 3);
    const validated = must(validate(state, zone));
    expect(validated.event).toEqual(zone);
    expect(validated.source).toBe('game-master');
    expect(validated.gameId).toBe(state.id);
    expect(validated.historyLength).toBe(state.history.length);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it('reads the state and changes nothing', () => {
    const state = frozen(started('tag', 3));
    const snapshot = structuredClone(state);
    must(validate(state, zone));
    expect(state).toEqual(snapshot);
  });

  it('refuses a state whose game is not a registered definition', () => {
    const state = { ...started('tag', 3), gameId: 'quidditch' };
    expect(codeOf(validate(state, zone))).toBe('INVALID_GAME_CONFIGURATION');
  });

  it('refuses malformed input', () => {
    const state = started('tag', 3);
    for (const input of [
      null,
      'ZONE_CHANGE',
      {},
      { type: 'SET_SCORE' },
      { ...zone, durationSeconds: 99_999 },
      { ...zone, score: 5 },
    ]) {
      expect(codeOf(validate(state, input))).toBe('INVALID_EVENT');
    }
  });

  it.each([
    { type: 'ROUND_START', round: 2, durationSeconds: 180 },
    { type: 'ROUND_END', round: 1 },
    { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
    { type: 'PLAYER_OUT', playerId: 'p1', byPlayerId: 'p0', reason: 'FOUND' },
    { type: 'POWER_ACTIVATED', playerId: 'p0', powerId: 'shield', durationSeconds: 20 },
    { type: 'OBJECTIVE_COMPLETED', playerId: 'p0', objectiveId: 'o1', points: 5 },
  ])('refuses the engine-only event $type', (event) => {
    expect(codeOf(validate(started('tag', 3), event))).toBe('UNSUPPORTED_EVENT');
    expect(codeOf(validate(started('hide-and-seek', 3), event))).toBe('UNSUPPORTED_EVENT');
  });

  it('refuses a ROLE_CHANGE that claims to be a tag', () => {
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
    expect(codeOf(validate(state, forged))).toBe('INVALID_EVENT');
  });

  it('refuses an event kind the game does not allow', () => {
    const challenge = {
      type: 'CHALLENGE',
      challengeId: 'c1',
      description: 'Touch three trees.',
      playerIds: ['p0'],
      points: 2,
      durationSeconds: 60,
    };
    expect(codeOf(validate(started('tag', 3), challenge))).toBe('UNSUPPORTED_EVENT');
    expect(
      codeOf(
        validate(started('hide-and-seek', 3), {
          type: 'POWER_UP',
          playerId: 'p0',
          powerId: 'shield',
        }),
      ),
    ).toBe('UNSUPPORTED_EVENT');
  });

  it('always judges against the registered definition, which a caller cannot replace', () => {
    // Regression: validateExternalEvent used to take the definition from the
    // caller and check only its id, so a modified copy could widen the rules.
    // There is no such parameter now. Hide & Seek has no powers, and no caller
    // can make the engine accept one for it.
    const state = started('hide-and-seek', 3);
    const grant = { type: 'POWER_UP', playerId: 'p0', powerId: 'godmode' };
    expect(validateExternalEvent.length).toBe(4);
    expect(codeOf(validate(state, grant))).toBe('UNSUPPORTED_EVENT');
    expect(codeOf(submitGameEvent(state, grant, 'game-master', at(NOW)))).toBe('UNSUPPORTED_EVENT');

    // A definition smuggled in where the event belongs is just a malformed event.
    const doctored = {
      ...hideAndSeek,
      allowedEventKinds: [...hideAndSeek.allowedEventKinds, 'POWER_UP'],
    };
    expect(codeOf(validate(state, doctored))).toBe('INVALID_EVENT');
  });

  it('refuses an event while the game is not in a running round', () => {
    expect(codeOf(validate(lobby('tag', 3), zone, 5))).toBe('INVALID_STATE_TRANSITION');

    const paused = must(
      reduce(started('tag', 3), { type: 'PAUSE_SESSION', reason: 'water' }, at(NOW)),
    );
    expect(codeOf(validate(paused, zone, NOW + 1_000))).toBe('INVALID_STATE_TRANSITION');

    const aborted = must(
      reduce(started('tag', 3), { type: 'ABORT_SESSION', reason: 'rain' }, at(NOW)),
    );
    expect(codeOf(validate(aborted, zone, NOW + 1_000))).toBe('GAME_ALREADY_COMPLETED');
  });

  it('judges the game as it is at the supplied time: after the last round, nothing is accepted', () => {
    const state = started('tag', 3);
    const afterTheEnd = START + 3 * 180_000 + 1;
    expect(codeOf(validate(state, zone, afterTheEnd))).toBe('GAME_ALREADY_COMPLETED');
  });
});

describe('validateExternalEvent: references to things that do not exist', () => {
  it('refuses an unknown player', () => {
    const state = started('tag', 3);
    expect(
      codeOf(validate(state, { type: 'POWER_UP', playerId: 'ghost', powerId: 'shield' })),
    ).toBe('INVALID_PLAYER');
    expect(
      codeOf(
        validate(state, {
          type: 'ROLE_CHANGE',
          assignments: [{ playerId: 'ghost', roleId: 'runner' }],
        }),
      ),
    ).toBe('INVALID_PLAYER');
  });

  it('refuses a player who has left the game', () => {
    const state = must(
      reduce(started('tag', 4), { type: 'REMOVE_PLAYER', playerId: 'p3' }, at(NOW)),
    );
    expect(
      codeOf(validate(state, { type: 'POWER_UP', playerId: 'p3', powerId: 'shield' }, NOW + 1_000)),
    ).toBe('INVALID_PLAYER');
  });

  it('refuses an unknown role', () => {
    const state = started('tag', 3);
    expect(
      codeOf(
        validate(state, {
          type: 'ROLE_CHANGE',
          assignments: [{ playerId: 'p0', roleId: 'wizard' }],
        }),
      ),
    ).toBe('INVALID_ROLE');
    expect(
      codeOf(
        validate(started('hide-and-seek', 3), {
          type: 'RULE_MODIFIER',
          modifier: 'FREEZE_PERIOD',
          roleIds: ['wizard'],
          durationSeconds: 30,
        }),
      ),
    ).toBe('INVALID_ROLE');
  });

  it('refuses a role change that breaks the role limits of the game', () => {
    const state = started('tag', 3);
    const [runner] = holders(state, 'runner');
    expect(
      codeOf(
        validate(state, {
          type: 'ROLE_CHANGE',
          assignments: [{ playerId: runner, roleId: 'tagger' }],
        }),
      ),
    ).toBe('INVALID_ROLE');
  });

  it('refuses an unknown power', () => {
    expect(
      codeOf(validate(started('tag', 3), { type: 'POWER_UP', playerId: 'p0', powerId: 'jetpack' })),
    ).toBe('INVALID_EVENT');
  });

  it('refuses a power the player already holds, or is already using', () => {
    const grant = { type: 'POWER_UP', playerId: 'p1', powerId: 'shield' };
    const holding = must(submitGameEvent(started('tag', 3), grant, 'game-master', at(NOW)));
    expect(codeOf(validate(holding, grant, NOW + 1_000))).toBe('INVALID_EVENT');

    const using = must(
      processPlayerAction(
        holding,
        { type: 'PLAYER_ACTIVATED_POWER', playerId: 'p1', powerId: 'shield' },
        at(NOW + 2_000),
      ),
    );
    expect(codeOf(validate(using, grant, NOW + 3_000))).toBe('INVALID_EVENT');
    // Once the shield has run out, it can be granted again.
    expect(codeOf(validate(using, grant, NOW + 30_000))).toBe('ok');
  });

  it('creates nothing: after a refusal there is no new player, role or power', () => {
    const state = frozen(started('tag', 3));
    const snapshot = structuredClone(state);
    validate(state, { type: 'POWER_UP', playerId: 'p123', powerId: 'speedBoost' });
    validate(state, {
      type: 'ROLE_CHANGE',
      assignments: [{ playerId: '123', roleId: 'merchant' }],
    });
    expect(state).toEqual(snapshot);
    expect(state.players.map((player) => player.id)).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('applyValidatedEvent', () => {
  it('applies an event the engine validated', () => {
    const state = started('tag', 3);
    const next = must(applyValidatedEvent(state, must(validate(state, zone)), at(NOW)));
    expect(next.activeModifiers).toEqual([
      expect.objectContaining({ kind: 'SAFE_ZONE', zone: 'the bench' }),
    ]);
    expect(next.history.at(-1)).toMatchObject({
      source: 'game-master',
      record: { kind: 'EVENT', event: zone },
    });
  });

  it('gives exactly the state submitGameEvent gives', () => {
    const state = started('tag', 3);
    const viaBoundary = must(applyValidatedEvent(state, must(validate(state, zone)), at(NOW)));
    expect(viaBoundary).toEqual(must(submitGameEvent(state, zone, 'game-master', at(NOW))));
  });

  it('refuses an object that only looks like a validated event', () => {
    const state = started('tag', 3);
    const genuine = must(validate(state, zone));
    const lookalike = {
      event: zone,
      source: 'game-master',
      gameId: state.id,
      historyLength: state.history.length,
    } as unknown as ValidatedGameEvent;
    const copy = { ...genuine } as ValidatedGameEvent;

    expect(codeOf(applyValidatedEvent(state, lookalike, at(NOW)))).toBe('INVALID_EVENT');
    expect(codeOf(applyValidatedEvent(state, copy, at(NOW)))).toBe('INVALID_EVENT');
    expect(codeOf(applyValidatedEvent(state, genuine, at(NOW)))).toBe('ok');
  });

  it('cannot be used to apply an event that was never validated, even an engine-only one', () => {
    const state = started('tag', 3);
    const smuggled = {
      event: { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
      source: 'game-master',
      gameId: state.id,
      historyLength: state.history.length,
    } as unknown as ValidatedGameEvent;
    const result = applyValidatedEvent(state, smuggled, at(NOW));
    expect(codeOf(result)).toBe('INVALID_EVENT');
  });

  it('refuses an event validated for a different game', () => {
    const one = started('tag', 3);
    const other = { ...started('tag', 3), id: 'another-game' };
    expect(codeOf(applyValidatedEvent(other, must(validate(one, zone)), at(NOW)))).toBe(
      'INVALID_EVENT',
    );
  });

  it('refuses an event once the game has moved on since it was validated', () => {
    const state = started('tag', 3);
    const validated = must(validate(state, zone));
    const moved = must(
      submitGameEvent(state, { type: 'TIME_EXTENSION', seconds: 30 }, 'human', at(NOW + 500)),
    );
    expect(codeOf(applyValidatedEvent(moved, validated, at(NOW + 1_000)))).toBe('INVALID_EVENT');
  });

  it('refuses an event validated on one branch of a game and applied to another', () => {
    // Regression: two states of the same game with equally long histories used
    // to be indistinguishable to the boundary.
    const base = started('tag', 3);
    const branchA = must(
      submitGameEvent(base, { type: 'TIME_EXTENSION', seconds: 30 }, 'human', at(NOW)),
    );
    const branchB = must(
      submitGameEvent(base, { type: 'TIME_EXTENSION', seconds: 300 }, 'human', at(NOW)),
    );
    expect(branchB.id).toBe(branchA.id);
    expect(branchB.history).toHaveLength(branchA.history.length);

    const validatedOnA = must(validate(branchA, zone, NOW + 1));
    expect(codeOf(applyValidatedEvent(branchB, validatedOnA, at(NOW + 2)))).toBe('INVALID_EVENT');
    expect(codeOf(applyValidatedEvent(branchA, validatedOnA, at(NOW + 2)))).toBe('ok');
  });

  it('refuses an event for a state rebuilt from JSON, and a validated event rebuilt from JSON', () => {
    const state = started('tag', 3);
    const validated = must(validate(state, zone));

    const reloadedState = JSON.parse(JSON.stringify(state)) as GameState;
    expect(codeOf(applyValidatedEvent(reloadedState, validated, at(NOW)))).toBe('INVALID_EVENT');

    const reloadedEvent = JSON.parse(JSON.stringify(validated)) as ValidatedGameEvent;
    expect(codeOf(applyValidatedEvent(state, reloadedEvent, at(NOW)))).toBe('INVALID_EVENT');

    // Validating again against the reloaded state works.
    expect(
      codeOf(applyValidatedEvent(reloadedState, must(validate(reloadedState, zone)), at(NOW))),
    ).toBe('ok');
  });

  it('refuses an event validated in one round and applied in the next', () => {
    const state = started('tag', 3);
    const validated = must(validate(state, zone));
    expect(codeOf(applyValidatedEvent(state, validated, at(START + 180_000 + 1)))).toBe(
      'INVALID_EVENT',
    );
  });

  it('can be applied later in the same round, while nothing else has happened', () => {
    const state = started('tag', 3);
    const validated = must(validate(state, zone));
    expect(codeOf(applyValidatedEvent(state, validated, at(NOW + 60_000)))).toBe('ok');
  });

  it('is deterministic: the same state and the same validated event give the same state', () => {
    const state = started('hide-and-seek', 3);
    const validated = must(validate(state, zone));
    const first = must(applyValidatedEvent(state, validated, at(NOW)));
    const second = must(applyValidatedEvent(state, validated, at(NOW)));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('never changes the state it was given, whether it applies or refuses', () => {
    const state = frozen(started('tag', 3));
    const snapshot = structuredClone(state);
    const validated = must(validate(state, zone));
    must(applyValidatedEvent(state, validated, at(NOW)));
    applyValidatedEvent(state, { ...validated }, at(NOW));
    expect(state).toEqual(snapshot);
  });
});

describe('regressions from real model output (Phase 3A live run)', () => {
  // Each of these was produced by gemma3:4b and is valid against the event schema.
  it.each([
    [
      'playerId "123" and roleId "merchant"',
      { type: 'ROLE_CHANGE', assignments: [{ playerId: '123', roleId: 'merchant' }] },
      'INVALID_PLAYER',
    ],
    [
      'roleIds "warrior" and "mage" for players "1" and "2"',
      {
        type: 'ROLE_CHANGE',
        assignments: [
          { playerId: '1', roleId: 'warrior' },
          { playerId: '2', roleId: 'mage' },
        ],
      },
      'INVALID_PLAYER',
    ],
    [
      'a real player with roleId "merchant"',
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p0', roleId: 'merchant' }] },
      'INVALID_ROLE',
    ],
    [
      'playerId "P123" with powerId "speedBoost"',
      { type: 'POWER_UP', playerId: 'P123', powerId: 'speedBoost' },
      'INVALID_PLAYER',
    ],
    [
      'a real player with powerId "speedBoost"',
      { type: 'POWER_UP', playerId: 'p0', powerId: 'speedBoost' },
      'INVALID_EVENT',
    ],
    [
      'playerId "123" with powerId "solarFlare"',
      { type: 'POWER_UP', playerId: '123', powerId: 'solarFlare' },
      'INVALID_PLAYER',
    ],
  ])('rejects %s', (_label, event, code) => {
    const state = frozen(started('tag', 3));
    const snapshot = structuredClone(state);
    expect(codeOf(validate(state, event))).toBe(code);
    expect(codeOf(submitGameEvent(state, event, 'game-master', at(NOW)))).toBe(code);
    expect(state).toEqual(snapshot);
  });

  it('rejects a shield for a player who already holds one', () => {
    const grant = { type: 'POWER_UP', playerId: 'p2', powerId: 'shield' };
    const state = frozen(must(submitGameEvent(started('tag', 3), grant, 'game-master', at(NOW))));
    const snapshot = structuredClone(state);
    expect(codeOf(validate(state, grant, NOW + 2_000))).toBe('INVALID_EVENT');
    expect(state).toEqual(snapshot);
    expect(state.players.find((player) => player.id === 'p2')?.powers).toEqual(['shield']);
  });
});
