import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_LIMITS,
  gameEventProposalSchema,
  gameMasterTurnSchema,
  proposalDurationSeconds,
  proposalTextFragments,
} from './proposal';

/**
 * These tests describe what a model is *not* allowed to say. They matter more
 * than the happy paths: every assertion here is a class of malformed or abusive
 * output that cannot reach the engine.
 */

const RATIONALE = 'The chase has gone static and needs a movement constraint.';

describe('gameEventProposalSchema', () => {
  it('accepts a well-formed modifier', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'MODIFIER',
      rationale: RATIONALE,
      rule: 'Taggers may only move by hopping on one foot.',
      target: { roleIds: ['tagger'], playerIds: [] },
      durationSeconds: 60,
    });
    expect(result.success).toBe(true);
  });

  it('defaults an omitted target to nobody-in-particular', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'MODIFIER',
      rationale: RATIONALE,
      rule: 'Everyone must move silently.',
      target: {},
      durationSeconds: 30,
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.kind !== 'MODIFIER') return;
    expect(result.data.target).toEqual({ roleIds: [], playerIds: [] });
  });

  it('rejects an unknown event kind', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'SUMMON_LIGHTNING',
      rationale: RATIONALE,
      message: 'A storm approaches.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra keys, so a model cannot smuggle fields past the contract', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'ANNOUNCE',
      rationale: RATIONALE,
      message: 'Thirty seconds left.',
      executeShellCommand: 'rm -rf /',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing rationale, so every proposal stays auditable', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'ANNOUNCE',
      message: 'Thirty seconds left.',
    });
    expect(result.success).toBe(false);
  });

  it('caps how long a rule may stay in force', () => {
    const tooLong = gameEventProposalSchema.safeParse({
      kind: 'MODIFIER',
      rationale: RATIONALE,
      rule: 'Walk only.',
      target: {},
      durationSeconds: PROPOSAL_LIMITS.maxDurationSeconds + 1,
    });
    expect(tooLong.success).toBe(false);

    const atLimit = gameEventProposalSchema.safeParse({
      kind: 'MODIFIER',
      rationale: RATIONALE,
      rule: 'Walk only.',
      target: {},
      durationSeconds: PROPOSAL_LIMITS.maxDurationSeconds,
    });
    expect(atLimit.success).toBe(true);
  });

  it('caps the size of a score adjustment in both directions', () => {
    const base = { kind: 'SCORE_ADJUST', rationale: RATIONALE, target: {}, reason: 'Great find.' };
    expect(
      gameEventProposalSchema.safeParse({
        ...base,
        delta: PROPOSAL_LIMITS.maxScoreDelta + 1,
      }).success,
    ).toBe(false);
    expect(
      gameEventProposalSchema.safeParse({
        ...base,
        delta: -(PROPOSAL_LIMITS.maxScoreDelta + 1),
      }).success,
    ).toBe(false);
    expect(gameEventProposalSchema.safeParse({ ...base, delta: 5 }).success).toBe(true);
  });

  it('rejects a no-op score adjustment', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'SCORE_ADJUST',
      rationale: RATIONALE,
      target: {},
      delta: 0,
      reason: 'Nothing happened.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rule too long to shout across a field', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'MODIFIER',
      rationale: RATIONALE,
      rule: 'x'.repeat(241),
      target: {},
      durationSeconds: 30,
    });
    expect(result.success).toBe(false);
  });

  it('caps how many players one ROLE_ASSIGN may move', () => {
    const assignments = Array.from(
      { length: PROPOSAL_LIMITS.maxRoleReassignments + 1 },
      (_, i) => ({ playerId: `p${i}`, roleId: 'tagger' }),
    );
    const result = gameEventProposalSchema.safeParse({
      kind: 'ROLE_ASSIGN',
      rationale: RATIONALE,
      assignments,
      announcement: 'New taggers, go.',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a zone rule expressed as a landmark, not coordinates', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'ZONE_RULE',
      rationale: 'The field is too open and the runners are never under pressure.',
      landmark: 'the bench with the missing slat',
      effect: 'safe',
      rule: 'Nobody can be tagged while touching the bench.',
      durationSeconds: 90,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a zone rule carrying coordinates in place of a landmark', () => {
    // The schema has no coordinate fields at all, so this fails on strictness —
    // which is the point: the system never claims spatial authority.
    const result = gameEventProposalSchema.safeParse({
      kind: 'ZONE_RULE',
      rationale: 'Shrinking the area.',
      landmark: 'the north edge',
      effect: 'out-of-bounds',
      rule: 'Stay south of the path.',
      durationSeconds: 60,
      latitude: 51.5,
      longitude: -0.12,
    });
    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace before enforcing length', () => {
    const result = gameEventProposalSchema.safeParse({
      kind: 'ANNOUNCE',
      rationale: RATIONALE,
      message: '   Go!   ',
    });
    // "Go!" is three characters after trimming, below the four-character floor.
    expect(result.success).toBe(false);
  });
});

describe('gameMasterTurnSchema', () => {
  const announce = (message: string) => ({ kind: 'ANNOUNCE', rationale: RATIONALE, message });

  it('accepts one to three proposals', () => {
    expect(gameMasterTurnSchema.safeParse({ proposals: [announce('Round two.')] }).success).toBe(
      true,
    );
    expect(
      gameMasterTurnSchema.safeParse({
        proposals: [announce('One.'), announce('Two.'), announce('Three.')],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty turn', () => {
    expect(gameMasterTurnSchema.safeParse({ proposals: [] }).success).toBe(false);
  });

  it('rejects a turn that rewrites more rules than players can remember', () => {
    expect(
      gameMasterTurnSchema.safeParse({
        proposals: [announce('One.'), announce('Two.'), announce('Three.'), announce('Four.')],
      }).success,
    ).toBe(false);
  });
});

describe('helpers the safety layer depends on', () => {
  it('surfaces every human-readable string for scanning', () => {
    const parsed = gameEventProposalSchema.parse({
      kind: 'ZONE_RULE',
      rationale: RATIONALE,
      landmark: 'the split oak',
      effect: 'objective-site',
      rule: 'Touch the trunk to bank a point.',
      durationSeconds: 60,
    });
    const fragments = proposalTextFragments(parsed);
    expect(fragments).toContain(RATIONALE);
    expect(fragments).toContain('the split oak');
    expect(fragments).toContain('Touch the trunk to bank a point.');
  });

  it('reports a duration for timed kinds and null otherwise', () => {
    const modifier = gameEventProposalSchema.parse({
      kind: 'MODIFIER',
      rationale: RATIONALE,
      rule: 'Hop only.',
      target: {},
      durationSeconds: 45,
    });
    const announcement = gameEventProposalSchema.parse({
      kind: 'ANNOUNCE',
      rationale: RATIONALE,
      message: 'Final round.',
    });
    expect(proposalDurationSeconds(modifier)).toBe(45);
    expect(proposalDurationSeconds(announcement)).toBeNull();
  });
});
