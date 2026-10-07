import { describe, expect, it } from 'vitest';
import { PLAYER_ACTION_KINDS } from '@touchgrass/game-definitions';
import { type PlayerAction, parsePlayerAction, playerActionSchema } from './actions';

/** One valid example of every action kind. */
const VALID: Record<PlayerAction['type'], PlayerAction> = {
  PLAYER_READY: { type: 'PLAYER_READY', playerId: 'p1' },
  PLAYER_TAGGED: { type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p2' },
  PLAYER_FOUND: { type: 'PLAYER_FOUND', playerId: 'p1', targetPlayerId: 'p2' },
  PLAYER_ACTIVATED_POWER: { type: 'PLAYER_ACTIVATED_POWER', playerId: 'p1', powerId: 'shield' },
  PLAYER_COMPLETED_CHALLENGE: {
    type: 'PLAYER_COMPLETED_CHALLENGE',
    playerId: 'p1',
    challengeId: 'ch-1',
  },
  PLAYER_ACCEPTED_EVENT: { type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p1', eventId: 'entry-4' },
};

describe('playerActionSchema', () => {
  it('has a schema for every action kind in the vocabulary, and no others', () => {
    expect(Object.keys(VALID).sort()).toEqual([...PLAYER_ACTION_KINDS].sort());
  });

  it.each(Object.values(VALID))('accepts a valid $type', (action) => {
    expect(playerActionSchema.safeParse(action).success).toBe(true);
  });

  it.each(Object.values(VALID))('requires a playerId on $type', (action) => {
    const { playerId: _omitted, ...rest } = action;
    expect(playerActionSchema.safeParse(rest).success).toBe(false);
    expect(playerActionSchema.safeParse({ ...action, playerId: '' }).success).toBe(false);
  });

  // An action states intent. It has nowhere to put a result, so a client cannot
  // use one to write a score, a role, or a status.
  it.each(Object.values(VALID))('rejects $type carrying a state mutation', (action) => {
    for (const smuggled of [
      { score: 100 },
      { roleId: 'tagger' },
      { status: 'completed' },
      { state: { players: [] } },
    ]) {
      expect(playerActionSchema.safeParse({ ...action, ...smuggled }).success).toBe(false);
    }
  });

  it('rejects an unknown action type', () => {
    expect(playerActionSchema.safeParse({ type: 'SET_SCORE', playerId: 'p1' }).success).toBe(false);
    expect(playerActionSchema.safeParse({ playerId: 'p1' }).success).toBe(false);
  });

  it('rejects tagging or finding yourself', () => {
    expect(
      playerActionSchema.safeParse({ type: 'PLAYER_TAGGED', playerId: 'p1', targetPlayerId: 'p1' })
        .success,
    ).toBe(false);
    expect(
      playerActionSchema.safeParse({ type: 'PLAYER_FOUND', playerId: 'p1', targetPlayerId: 'p1' })
        .success,
    ).toBe(false);
  });

  it('requires a target on tag and found', () => {
    expect(playerActionSchema.safeParse({ type: 'PLAYER_TAGGED', playerId: 'p1' }).success).toBe(
      false,
    );
    expect(playerActionSchema.safeParse({ type: 'PLAYER_FOUND', playerId: 'p1' }).success).toBe(
      false,
    );
  });

  it('bounds id length', () => {
    expect(
      playerActionSchema.safeParse({ type: 'PLAYER_READY', playerId: 'p'.repeat(65) }).success,
    ).toBe(false);
  });

  it.each(Object.values(VALID))('$type survives a JSON round trip unchanged', (action) => {
    const parsed = playerActionSchema.parse(action);
    expect(playerActionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe('parsePlayerAction', () => {
  it('returns the action on success', () => {
    expect(parsePlayerAction(VALID.PLAYER_TAGGED)).toEqual({
      ok: true,
      value: VALID.PLAYER_TAGGED,
    });
  });

  it('returns INVALID_ACTION with issues instead of throwing', () => {
    const result = parsePlayerAction({ type: 'PLAYER_TAGGED', playerId: 'p1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ACTION');
    expect(JSON.stringify(result.error.context)).toMatch(/targetPlayerId/);
  });

  it('handles input that is not an object', () => {
    for (const input of [null, undefined, 'PLAYER_READY', 7, []]) {
      expect(parsePlayerAction(input).ok).toBe(false);
    }
  });
});
