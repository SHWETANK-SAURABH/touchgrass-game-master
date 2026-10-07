import { describe, expect, it } from 'vitest';
import { GAME_EVENT_KINDS } from '@touchgrass/game-definitions';
import { EVENT_LIMITS, type GameEvent, gameEventSchema, parseGameEvent } from './events';

/** One valid example of every event kind. */
const VALID: Record<GameEvent['type'], GameEvent> = {
  ROUND_START: { type: 'ROUND_START', round: 1, durationSeconds: 180 },
  ROUND_END: { type: 'ROUND_END', round: 1 },
  ZONE_CHANGE: {
    type: 'ZONE_CHANGE',
    modifier: 'SAFE_ZONE',
    zone: 'the bench by the gate',
    durationSeconds: 60,
  },
  CHALLENGE: {
    type: 'CHALLENGE',
    challengeId: 'ch-1',
    description: 'Touch three different trees.',
    playerIds: ['p1'],
    points: 3,
    durationSeconds: 90,
  },
  POWER_UP: { type: 'POWER_UP', playerId: 'p1', powerId: 'shield' },
  RULE_MODIFIER: {
    type: 'RULE_MODIFIER',
    modifier: 'FREEZE_PERIOD',
    roleIds: ['seeker'],
    durationSeconds: 30,
  },
  BONUS_OBJECTIVE: {
    type: 'BONUS_OBJECTIVE',
    objectiveId: 'obj-1',
    description: 'First to reach the oak scores.',
    points: 2,
    durationSeconds: 120,
  },
  TIME_EXTENSION: { type: 'TIME_EXTENSION', seconds: 60 },
  ROLE_CHANGE: {
    type: 'ROLE_CHANGE',
    assignments: [
      { playerId: 'p1', roleId: 'runner' },
      { playerId: 'p2', roleId: 'tagger' },
    ],
  },
  GAME_END: { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
  PLAYER_OUT: { type: 'PLAYER_OUT', playerId: 'p2', byPlayerId: 'p1', reason: 'FOUND' },
  POWER_ACTIVATED: {
    type: 'POWER_ACTIVATED',
    playerId: 'p1',
    powerId: 'shield',
    durationSeconds: 20,
  },
  OBJECTIVE_COMPLETED: {
    type: 'OBJECTIVE_COMPLETED',
    playerId: 'p1',
    objectiveId: 'obj-1',
    points: 2,
  },
};

describe('gameEventSchema', () => {
  it('has a schema for every event kind in the vocabulary, and no others', () => {
    expect(Object.keys(VALID).sort()).toEqual([...GAME_EVENT_KINDS].sort());
  });

  it.each(Object.values(VALID))('accepts a valid $type', (event) => {
    expect(gameEventSchema.safeParse(event).success).toBe(true);
  });

  it.each(Object.values(VALID))('rejects $type carrying an unexpected key', (event) => {
    expect(gameEventSchema.safeParse({ ...event, score: 999 }).success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(gameEventSchema.safeParse({ type: 'SUMMON_LIGHTNING' }).success).toBe(false);
    // The Phase 1 vocabulary is gone.
    expect(gameEventSchema.safeParse({ type: 'MODIFIER', rule: 'Hop only.' }).success).toBe(false);
  });

  it('rejects a missing type', () => {
    expect(gameEventSchema.safeParse({ round: 1 }).success).toBe(false);
  });

  it('bounds durations', () => {
    const base = VALID.ZONE_CHANGE;
    expect(gameEventSchema.safeParse({ ...base, durationSeconds: 4 }).success).toBe(false);
    expect(
      gameEventSchema.safeParse({ ...base, durationSeconds: EVENT_LIMITS.maxDurationSeconds })
        .success,
    ).toBe(true);
    expect(
      gameEventSchema.safeParse({ ...base, durationSeconds: EVENT_LIMITS.maxDurationSeconds + 1 })
        .success,
    ).toBe(false);
    expect(gameEventSchema.safeParse({ ...base, durationSeconds: 30.5 }).success).toBe(false);
  });

  it('bounds points on challenges and objectives', () => {
    for (const base of [VALID.CHALLENGE, VALID.BONUS_OBJECTIVE]) {
      expect(gameEventSchema.safeParse({ ...base, points: 0 }).success).toBe(false);
      expect(gameEventSchema.safeParse({ ...base, points: -3 }).success).toBe(false);
      expect(
        gameEventSchema.safeParse({ ...base, points: EVENT_LIMITS.maxPoints + 1 }).success,
      ).toBe(false);
    }
  });

  it('bounds a time extension', () => {
    expect(gameEventSchema.safeParse({ type: 'TIME_EXTENSION', seconds: 0 }).success).toBe(false);
    expect(
      gameEventSchema.safeParse({
        type: 'TIME_EXTENSION',
        seconds: EVENT_LIMITS.maxExtensionSeconds + 1,
      }).success,
    ).toBe(false);
  });

  it('bounds the round number', () => {
    expect(gameEventSchema.safeParse({ ...VALID.ROUND_START, round: 0 }).success).toBe(false);
    expect(
      gameEventSchema.safeParse({ ...VALID.ROUND_START, round: EVENT_LIMITS.maxRounds + 1 })
        .success,
    ).toBe(false);
  });

  it('only accepts zone modifiers on ZONE_CHANGE and FREEZE_PERIOD on RULE_MODIFIER', () => {
    expect(
      gameEventSchema.safeParse({ ...VALID.ZONE_CHANGE, modifier: 'FREEZE_PERIOD' }).success,
    ).toBe(false);
    expect(
      gameEventSchema.safeParse({ ...VALID.RULE_MODIFIER, modifier: 'SAFE_ZONE' }).success,
    ).toBe(false);
  });

  it('has no coordinate fields: a zone is words, not a position', () => {
    expect(
      gameEventSchema.safeParse({ ...VALID.ZONE_CHANGE, latitude: 51.5, longitude: -0.12 }).success,
    ).toBe(false);
  });

  it('trims text before enforcing its length', () => {
    expect(gameEventSchema.safeParse({ ...VALID.ZONE_CHANGE, zone: '   a   ' }).success).toBe(
      false,
    );
    expect(gameEventSchema.safeParse({ ...VALID.ZONE_CHANGE, zone: 'x'.repeat(241) }).success).toBe(
      false,
    );
  });

  it('requires at least one player on a challenge and one assignment on a role change', () => {
    expect(gameEventSchema.safeParse({ ...VALID.CHALLENGE, playerIds: [] }).success).toBe(false);
    expect(gameEventSchema.safeParse({ type: 'ROLE_CHANGE', assignments: [] }).success).toBe(false);
  });

  it('caps how many players one ROLE_CHANGE may move', () => {
    const assignments = Array.from({ length: EVENT_LIMITS.maxRoleAssignments + 1 }, (_, i) => ({
      playerId: `p${i}`,
      roleId: 'runner',
    }));
    expect(gameEventSchema.safeParse({ type: 'ROLE_CHANGE', assignments }).success).toBe(false);
  });

  it('rejects a ROLE_CHANGE that assigns the same player twice', () => {
    const result = gameEventSchema.safeParse({
      type: 'ROLE_CHANGE',
      assignments: [
        { playerId: 'p1', roleId: 'runner' },
        { playerId: 'p1', roleId: 'tagger' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a typed cause on ROLE_CHANGE and nothing looser', () => {
    const base = VALID.ROLE_CHANGE;
    const cause = { reason: 'TAGGED', byPlayerId: 'p2', targetPlayerId: 'p1' };
    expect(gameEventSchema.safeParse({ ...base, cause }).success).toBe(true);
    expect(
      gameEventSchema.safeParse({ ...base, cause: { ...cause, reason: 'BRIBED' } }).success,
    ).toBe(false);
    expect(gameEventSchema.safeParse({ ...base, cause: { ...cause, points: 50 } }).success).toBe(
      false,
    );
    expect(gameEventSchema.safeParse({ ...base, cause: { reason: 'TAGGED' } }).success).toBe(false);
  });

  it('has no event that sets a score or writes arbitrary state', () => {
    for (const type of ['SCORE_CHANGE', 'STATE_MUTATION', 'SET_SCORE', 'SET_STATE']) {
      expect(gameEventSchema.safeParse({ type, playerId: 'p1', score: 99 }).success).toBe(false);
    }
  });

  it('bounds the points an OBJECTIVE_COMPLETED may carry', () => {
    expect(gameEventSchema.safeParse({ ...VALID.OBJECTIVE_COMPLETED, points: 0 }).success).toBe(
      false,
    );
    expect(
      gameEventSchema.safeParse({
        ...VALID.OBJECTIVE_COMPLETED,
        points: EVENT_LIMITS.maxPoints + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown GAME_END reason', () => {
    expect(gameEventSchema.safeParse({ type: 'GAME_END', reason: 'MODEL_SAID_SO' }).success).toBe(
      false,
    );
  });

  it.each(Object.values(VALID))('$type survives a JSON round trip unchanged', (event) => {
    const parsed = gameEventSchema.parse(event);
    expect(gameEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe('parseGameEvent', () => {
  it('returns the event on success', () => {
    const result = parseGameEvent(VALID.TIME_EXTENSION);
    expect(result).toEqual({ ok: true, value: VALID.TIME_EXTENSION });
  });

  it('returns INVALID_EVENT with field-level issues instead of throwing', () => {
    const result = parseGameEvent({ ...VALID.ZONE_CHANGE, durationSeconds: 9_999 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
    expect(JSON.stringify(result.error.context)).toMatch(/durationSeconds/);
  });

  it('handles input that is not an object', () => {
    for (const input of [null, undefined, 'ROUND_START', 42, []]) {
      const result = parseGameEvent(input);
      expect(result.ok).toBe(false);
    }
  });
});
