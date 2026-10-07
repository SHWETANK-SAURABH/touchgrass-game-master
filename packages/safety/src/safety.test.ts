import { describe, expect, it } from 'vitest';
import { getGameDefinition, listGameDefinitions } from '@touchgrass/game-definitions';
import {
  HAZARD_CATEGORIES,
  HAZARD_CATEGORY_IDS,
  NON_NEGOTIABLE_HAZARDS,
  getHazardCategory,
  hazardsAtLeast,
} from './hazards';
import { POLICY_VERSION, enforces, policyFor, safetyPolicySchema } from './policy';
import { safetyVerdictSchema, isAllowed, isRepairable, worstViolation } from './verdict';

describe('hazard taxonomy', () => {
  it('covers every hazard class the product promised to check', () => {
    // Mirrors the list in SAFETY.md. If a category is added or renamed, this
    // assertion forces the document and the code to move together.
    expect([...HAZARD_CATEGORY_IDS].sort()).toEqual(
      [
        'climbing-and-heights',
        'dangerous-objects',
        'dangerous-physical-challenge',
        'darkness-and-visibility',
        'fire-and-heat',
        'forced-physical-contact',
        'ingestion',
        'isolation-and-separation',
        'restricted-and-private-property',
        'roads-and-traffic',
        'sensory-deprivation',
        'strangers',
        'water',
        'weapons',
        'wildlife-and-plants',
      ].sort(),
    );
  });

  it('has one entry per id, with no duplicates', () => {
    expect(HAZARD_CATEGORIES).toHaveLength(HAZARD_CATEGORY_IDS.length);
    const ids = HAZARD_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(HAZARD_CATEGORIES)('$id explains why it exists', (category) => {
    // A hazard without a rationale cannot be defended in review or to a parent,
    // and tends to be the one that gets quietly deleted to fix a false positive.
    expect(category.rationale.length).toBeGreaterThan(40);
    expect(category.description.length).toBeGreaterThan(20);
    expect(category.exampleSignals.length).toBeGreaterThanOrEqual(4);
  });

  it('treats the lethal categories as critical', () => {
    for (const id of ['roads-and-traffic', 'water', 'climbing-and-heights'] as const) {
      expect(getHazardCategory(id).severity).toBe('critical');
    }
  });

  it('derives the non-negotiable list from severity rather than a second hand-list', () => {
    const expected = HAZARD_CATEGORIES.filter((c) => c.severity === 'critical').map((c) => c.id);
    expect([...NON_NEGOTIABLE_HAZARDS]).toEqual(expected);
    expect(NON_NEGOTIABLE_HAZARDS.length).toBeGreaterThan(0);
  });

  it('filters by minimum severity', () => {
    const critical = hazardsAtLeast('critical');
    expect(critical.every((category) => category.severity === 'critical')).toBe(true);
    expect(hazardsAtLeast('moderate')).toHaveLength(HAZARD_CATEGORIES.length);
    expect(critical.length).toBeLessThan(HAZARD_CATEGORIES.length);
  });

  it('throws on an unknown id rather than returning undefined', () => {
    // @ts-expect-error -- exercising the runtime guard with an off-contract id.
    expect(() => getHazardCategory('dragons')).toThrow(/Unknown hazard category/);
  });
});

describe('policyFor', () => {
  it.each(listGameDefinitions())('$id derives a valid policy', (definition) => {
    const policy = policyFor(definition);
    expect(safetyPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy.gameId).toBe(definition.id);
    expect(policy.version).toBe(POLICY_VERSION);
  });

  it.each(listGameDefinitions())(
    '$id mirrors its own contact and intensity limits',
    (definition) => {
      const policy = policyFor(definition);
      expect(policy.contactPolicy).toBe(definition.safety.contactPolicy);
      expect(policy.maxIntensity).toBe(definition.safety.maxIntensity);
      expect(policy.separationExpected).toBe(definition.safety.involvesSeparation);
    },
  );

  it.each(listGameDefinitions())('$id enforces every critical hazard', (definition) => {
    const policy = policyFor(definition);
    for (const hazard of NON_NEGOTIABLE_HAZARDS) {
      expect(enforces(policy, hazard)).toBe(true);
    }
  });

  it('assumes no adult supervision unless the host says otherwise', () => {
    expect(policyFor(getGameDefinition('tag')).supervisedByAdult).toBe(false);
    expect(policyFor(getGameDefinition('tag'), { supervisedByAdult: true }).supervisedByAdult).toBe(
      true,
    );
  });

  it('gives high-intensity games shorter rule durations than low-intensity ones', () => {
    const chase = policyFor(getGameDefinition('tag'));
    const nature = policyFor(getGameDefinition('nature-challenge'));
    expect(chase.maxRuleDurationSeconds).toBeLessThan(nature.maxRuleDurationSeconds);
  });

  it('lets a host shorten the rule duration', () => {
    const policy = policyFor(getGameDefinition('tag'), { maxRuleDurationSeconds: 30 });
    expect(policy.maxRuleDurationSeconds).toBe(30);
  });

  it('refuses to let a host lengthen it past the game ceiling', () => {
    const base = policyFor(getGameDefinition('tag'));
    const stretched = policyFor(getGameDefinition('tag'), { maxRuleDurationSeconds: 9_999 });
    expect(stretched.maxRuleDurationSeconds).toBe(base.maxRuleDurationSeconds);
  });

  it('rejects a hand-built policy that drops a critical hazard', () => {
    const valid = policyFor(getGameDefinition('tag'));
    const tampered = {
      ...valid,
      enforcedHazards: valid.enforcedHazards.filter((hazard) => hazard !== 'water'),
    };
    const result = safetyPolicySchema.safeParse(tampered);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/may not omit a critical hazard/);
  });

  it('rejects a policy carrying unexpected keys', () => {
    const valid = policyFor(getGameDefinition('tag'));
    expect(safetyPolicySchema.safeParse({ ...valid, allowEverything: true }).success).toBe(false);
  });
});

describe('verdict contract', () => {
  const violation = {
    hazard: 'roads-and-traffic' as const,
    severity: 'critical' as const,
    field: 'rule',
    evidence: 'cross the road',
    explanation: 'The twist would send players across a road.',
  };

  it('accepts an allow verdict with no violations', () => {
    const verdict = {
      disposition: 'allow' as const,
      violations: [],
      policyVersion: POLICY_VERSION,
      durationMs: 0.4,
    };
    expect(safetyVerdictSchema.safeParse(verdict).success).toBe(true);
    expect(isAllowed(safetyVerdictSchema.parse(verdict))).toBe(true);
  });

  it('requires evidence and an explanation on every violation', () => {
    expect(
      safetyVerdictSchema.safeParse({
        disposition: 'reject',
        violations: [{ ...violation, evidence: '' }],
        policyVersion: POLICY_VERSION,
        durationMs: 1,
      }).success,
    ).toBe(false);

    expect(
      safetyVerdictSchema.safeParse({
        disposition: 'reject',
        violations: [{ hazard: 'water', severity: 'critical', field: 'rule' }],
        policyVersion: POLICY_VERSION,
        durationMs: 1,
      }).success,
    ).toBe(false);
  });

  it('has no disposition for "do not know"', () => {
    expect(
      safetyVerdictSchema.safeParse({
        disposition: 'unknown',
        violations: [],
        policyVersion: POLICY_VERSION,
        durationMs: 1,
      }).success,
    ).toBe(false);
  });

  it('distinguishes a repairable verdict from a terminal one', () => {
    const revise = safetyVerdictSchema.parse({
      disposition: 'revise',
      violations: [{ ...violation, severity: 'moderate', hazard: 'darkness-and-visibility' }],
      policyVersion: POLICY_VERSION,
      durationMs: 1,
    });
    const reject = safetyVerdictSchema.parse({
      disposition: 'reject',
      violations: [violation],
      policyVersion: POLICY_VERSION,
      durationMs: 1,
    });
    expect(isRepairable(revise)).toBe(true);
    expect(isRepairable(reject)).toBe(false);
    expect(isAllowed(reject)).toBe(false);
  });

  it('surfaces the most severe violation first', () => {
    const verdict = safetyVerdictSchema.parse({
      disposition: 'reject',
      violations: [
        { ...violation, hazard: 'darkness-and-visibility', severity: 'moderate' },
        { ...violation, hazard: 'dangerous-objects', severity: 'high' },
        violation,
      ],
      policyVersion: POLICY_VERSION,
      durationMs: 2,
    });
    expect(worstViolation(verdict)?.hazard).toBe('roads-and-traffic');
  });

  it('returns undefined when there is nothing to report', () => {
    const verdict = safetyVerdictSchema.parse({
      disposition: 'allow',
      violations: [],
      policyVersion: POLICY_VERSION,
      durationMs: 0,
    });
    expect(worstViolation(verdict)).toBeUndefined();
  });
});
