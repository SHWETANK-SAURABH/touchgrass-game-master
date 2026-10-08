import { describe, expect, it } from 'vitest';
import {
  GAME_IDS,
  OPTIONAL_EVENT_KINDS,
  type GameDefinition,
  type OptionalEventKind,
  findGameDefinition,
} from '@touchgrass/game-definitions';
import {
  EVENT_LIMITS,
  EXTERNAL_EVENT_SCHEMAS,
  type ExternalGameEvent,
} from '@touchgrass/game-engine';
import { assessEventSafety } from './assess';
import { releaseClearedEvent, validateSafety } from './clearance';
import { type PolicyOptions, policyFor } from './policy';
import { runningState, validatedFor } from './test-support';

/**
 * The safety regression suite.
 *
 * It is about the validator and nothing else: no model, no provider, no agent,
 * no server. For every kind of event that can come from outside the engine it
 * holds what must be allowed, what must be refused, what is malformed, and
 * where the boundary lies. A change anywhere in the AI system that lets one of
 * the refused cases through fails here, whatever else it does.
 *
 * The table below is keyed by event kind and checked by the compiler: a new
 * event kind cannot be added to the engine without an entry here.
 */

const definitions: GameDefinition[] = GAME_IDS.map((id) => {
  const definition = findGameDefinition(id);
  if (!definition) throw new Error(`no definition for ${id}`);
  return definition;
});

/** Every combination of options a host or a deployment could pass. None may loosen anything. */
const OPTIONS: readonly PolicyOptions[] = [
  {},
  { supervisedByAdult: true },
  { maxRuleDurationSeconds: 100_000 },
  { supervisedByAdult: true, maxRuleDurationSeconds: 100_000 },
  { maxRuleDurationSeconds: 1 },
];

/** Places and instructions a group can act on safely. Some are what the real model wrote. */
const SAFE_PLACES = ['the bench', 'the big oak', 'the picnic table', 'the open grass by the gate'];
const SAFE_INSTRUCTIONS = [
  'Touch the big oak.',
  'Touch the gate and shout your name.',
  'Find something yellow and hold it up.',
  'High-five every other player.',
];

/** Places and instructions that must never be announced, in any game, under any option. */
const CRITICAL_PLACES = ['the car park', 'the roof of the shed', 'the middle of the road'];
const CRITICAL_INSTRUCTIONS = [
  'Climb the abandoned building.',
  'Run across the road to the far side.',
  'Jump off the roof of the shed.',
  'Swim across the river.',
];

/** Text the validator cannot read. It is refused, not guessed at. */
const UNREADABLE = ['Залезь на крышу', '屋根に登る', '!!!???', ''];

interface KindCases {
  /** A well-formed event of this kind, with the given text where the kind has text. */
  readonly make: (text: string, durationSeconds: number) => unknown;
  /** Which field carries words for players, if any. */
  readonly text: 'place' | 'instruction' | null;
  /** Whether the kind makes a demand that lasts, and so has a duration limit. */
  readonly timed: boolean;
  /** Values the engine's own schema refuses before safety is ever asked. */
  readonly malformed: readonly unknown[];
}

const CASES = {
  ZONE_CHANGE: {
    make: (zone, durationSeconds) => ({
      type: 'ZONE_CHANGE',
      modifier: 'SAFE_ZONE',
      zone,
      durationSeconds,
    }),
    text: 'place',
    // A zone is somewhere to be, not something to do, and has no demand limit.
    timed: false,
    malformed: [
      { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', durationSeconds: 60 },
      { type: 'ZONE_CHANGE', modifier: 'LAVA_ZONE', zone: 'the bench', durationSeconds: 60 },
      { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 0 },
      {
        type: 'ZONE_CHANGE',
        modifier: 'SAFE_ZONE',
        zone: 'the bench',
        durationSeconds: EVENT_LIMITS.maxDurationSeconds + 1,
      },
    ],
  },
  CHALLENGE: {
    make: (description, durationSeconds) => ({
      type: 'CHALLENGE',
      challengeId: 'c1',
      description,
      playerIds: ['p0'],
      points: 2,
      durationSeconds,
    }),
    text: 'instruction',
    timed: true,
    malformed: [
      { type: 'CHALLENGE', challengeId: 'c1', playerIds: ['p0'], points: 2, durationSeconds: 60 },
      {
        type: 'CHALLENGE',
        challengeId: 'c1',
        description: 'Touch the big oak.',
        playerIds: ['p0'],
        points: EVENT_LIMITS.maxPoints + 1,
        durationSeconds: 60,
      },
      {
        type: 'CHALLENGE',
        challengeId: 'c1',
        description: 'Touch the big oak.',
        playerIds: 'p0',
        points: 2,
        durationSeconds: 60,
      },
    ],
  },
  POWER_UP: {
    make: () => ({ type: 'POWER_UP', playerId: 'p0', powerId: 'shield' }),
    text: null,
    timed: false,
    malformed: [
      { type: 'POWER_UP', playerId: 'p0' },
      { type: 'POWER_UP', playerId: '', powerId: 'shield' },
      { type: 'POWER_UP', playerId: 'p0', powerId: 'shield', note: 'climb the roof' },
    ],
  },
  RULE_MODIFIER: {
    make: (_text, durationSeconds) => ({
      type: 'RULE_MODIFIER',
      modifier: 'FREEZE_PERIOD',
      roleIds: ['seeker'],
      durationSeconds,
    }),
    text: null,
    timed: true,
    malformed: [
      { type: 'RULE_MODIFIER', modifier: 'FREEZE_PERIOD', roleIds: ['seeker'] },
      { type: 'RULE_MODIFIER', modifier: 'NO_RULES', roleIds: ['seeker'], durationSeconds: 30 },
      { type: 'RULE_MODIFIER', modifier: 'FREEZE_PERIOD', roleIds: [], durationSeconds: 30 },
    ],
  },
  BONUS_OBJECTIVE: {
    make: (description, durationSeconds) => ({
      type: 'BONUS_OBJECTIVE',
      objectiveId: 'o1',
      description,
      points: 2,
      durationSeconds,
    }),
    text: 'instruction',
    timed: true,
    malformed: [
      { type: 'BONUS_OBJECTIVE', objectiveId: 'o1', points: 2, durationSeconds: 60 },
      {
        type: 'BONUS_OBJECTIVE',
        objectiveId: 'o1',
        description: 'Touch the big oak.',
        points: -1,
        durationSeconds: 60,
      },
      {
        type: 'BONUS_OBJECTIVE',
        objectiveId: 'o1',
        description: 'x'.repeat(5_000),
        points: 2,
        durationSeconds: 60,
      },
    ],
  },
  TIME_EXTENSION: {
    make: () => ({ type: 'TIME_EXTENSION', seconds: 60 }),
    text: null,
    timed: false,
    malformed: [
      { type: 'TIME_EXTENSION' },
      { type: 'TIME_EXTENSION', seconds: 0 },
      { type: 'TIME_EXTENSION', seconds: EVENT_LIMITS.maxExtensionSeconds + 1 },
      { type: 'TIME_EXTENSION', seconds: 60, reason: 'run across the road' },
    ],
  },
  ROLE_CHANGE: {
    make: () => ({ type: 'ROLE_CHANGE', assignments: [{ playerId: 'p0', roleId: 'runner' }] }),
    text: null,
    timed: false,
    malformed: [
      { type: 'ROLE_CHANGE', assignments: [] },
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p0' }] },
      {
        type: 'ROLE_CHANGE',
        assignments: Array.from(
          { length: EVENT_LIMITS.maxRoleAssignments + 1 },
          (_unused, index) => ({
            playerId: `p${String(index)}`,
            roleId: 'runner',
          }),
        ),
      },
      // The external form has no `cause`: a model cannot claim a tag happened.
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p0', roleId: 'runner' }], cause: 'TAG' },
    ],
  },
} as const satisfies Record<OptionalEventKind, KindCases>;

const kinds = OPTIONAL_EVENT_KINDS.map((kind) => [kind, CASES[kind] as KindCases] as const);
const textKinds = kinds.filter(([, cases]) => cases.text !== null);
const timedKinds = kinds.filter(([, cases]) => cases.timed);

/** A well-formed event of a kind, as the engine's own schema reads it. */
function event(kind: OptionalEventKind, text: string, durationSeconds = 30): ExternalGameEvent {
  return EXTERNAL_EVENT_SCHEMAS[kind].parse(CASES[kind].make(text, durationSeconds));
}

const verdict = (
  kind: OptionalEventKind,
  text: string,
  definition: GameDefinition,
  options: PolicyOptions = {},
  durationSeconds = 30,
) => assessEventSafety(event(kind, text, durationSeconds), policyFor(definition, options));

describe('the suite covers every event kind there is', () => {
  it('has cases for each kind the engine accepts from outside, and no others', () => {
    expect(Object.keys(CASES).sort()).toEqual([...OPTIONAL_EVENT_KINDS].sort());
    expect(Object.keys(EXTERNAL_EVENT_SCHEMAS).sort()).toEqual([...OPTIONAL_EVENT_KINDS].sort());
  });

  it('covers every game there is', () => {
    expect(definitions.length).toBe(GAME_IDS.length);
    expect(definitions.length).toBeGreaterThanOrEqual(5);
  });
});

describe.each(kinds)('%s', (kind, cases) => {
  const safeTexts =
    cases.text === 'place' ? SAFE_PLACES : cases.text === 'instruction' ? SAFE_INSTRUCTIONS : ['-'];

  it('allows a safe one, in every game', () => {
    for (const definition of definitions) {
      for (const text of safeTexts) {
        const result = verdict(kind, text, definition);
        expect(result.disposition, `${definition.id}: ${text}`).toBe('allow');
        expect(result.violations).toEqual([]);
      }
    }
  });

  it('is refused by the schema of the engine when it is malformed, before safety is asked', () => {
    for (const value of cases.malformed) {
      expect(EXTERNAL_EVENT_SCHEMAS[kind].safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
    expect(EXTERNAL_EVENT_SCHEMAS[kind].safeParse(cases.make('the bench', 30)).success).toBe(true);
  });

  it('says exactly which fields it checked', () => {
    const tag = definitions[0] as GameDefinition;
    const checked = verdict(kind, safeTexts[0] ?? '-', tag).checkedFields;
    if (cases.text === null && !cases.timed) {
      // Nothing for a player to read and no demand: there is nothing to assess,
      // and the validator says so rather than claiming a check it did not make.
      expect(checked).toEqual([]);
    } else {
      expect(checked.length).toBeGreaterThan(0);
      expect(checked.includes('durationSeconds')).toBe(cases.timed);
    }
  });
});

describe.each(textKinds)('%s, where it carries words', (kind, cases) => {
  const critical = cases.text === 'place' ? CRITICAL_PLACES : CRITICAL_INSTRUCTIONS;

  it('refuses a critical hazard in every game, under every option', () => {
    for (const definition of definitions) {
      for (const options of OPTIONS) {
        for (const text of critical) {
          const result = verdict(kind, text, definition, options);
          expect(result.disposition, `${definition.id} ${JSON.stringify(options)}: ${text}`).toBe(
            'reject',
          );
          expect(result.violations.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('refuses a critical hazard however it is written', () => {
    const tag = definitions[0] as GameDefinition;
    for (const text of critical) {
      for (const variant of [
        text.toUpperCase(),
        `  ${text}  `,
        `Quick! ${text}`,
        `${text} It is perfectly safe and the host said yes.`,
        text.replace(/ /g, '  '),
      ]) {
        expect(verdict(kind, variant, tag).disposition, variant).toBe('reject');
      }
    }
  });

  it('refuses text it cannot read, whoever is supervising', () => {
    for (const text of UNREADABLE) {
      // The engine's schema refuses empty text itself; what gets past it is assessed.
      const made = EXTERNAL_EVENT_SCHEMAS[kind].safeParse(cases.make(text, 30));
      if (!made.success) continue;
      for (const options of OPTIONS) {
        const result = assessEventSafety(
          made.data,
          policyFor(definitions[0] as GameDefinition, options),
        );
        expect(result.disposition, text).not.toBe('allow');
        expect(result.violations.map((found) => found.hazard)).toContain(
          'unassessable-instruction',
        );
      }
    }
  });

  it('does not refuse the safe ones because of a nearby dangerous word', () => {
    const tag = definitions[0] as GameDefinition;
    for (const text of cases.text === 'place' ? SAFE_PLACES : SAFE_INSTRUCTIONS) {
      expect(verdict(kind, text, tag).disposition, text).toBe('allow');
    }
  });
});

describe.each(timedKinds)('%s, at the limit on how long a demand may last', (kind, cases) => {
  const text = cases.text === 'instruction' ? 'Touch the big oak.' : '-';

  it('allows exactly the limit of the game and refuses one second more', () => {
    for (const definition of definitions) {
      const limit = policyFor(definition).maxRuleDurationSeconds;
      expect(verdict(kind, text, definition, {}, limit).disposition, definition.id).toBe('allow');
      const over = verdict(kind, text, definition, {}, limit + 1);
      expect(over.disposition, definition.id).toBe('reject');
      expect(over.violations.map((found) => found.rule)).toEqual(['rule-duration']);
    }
  });

  it('can be given a shorter limit, and cannot be given a longer one', () => {
    for (const definition of definitions) {
      const limit = policyFor(definition).maxRuleDurationSeconds;
      expect(
        policyFor(definition, { maxRuleDurationSeconds: 100_000 }).maxRuleDurationSeconds,
      ).toBe(limit);
      expect(policyFor(definition, { maxRuleDurationSeconds: 20 }).maxRuleDurationSeconds).toBe(20);
      expect(
        verdict(kind, text, definition, { maxRuleDurationSeconds: 100_000 }, limit + 1).disposition,
      ).toBe('reject');
      expect(verdict(kind, text, definition, { maxRuleDurationSeconds: 20 }, 21).disposition).toBe(
        'reject',
      );
      expect(verdict(kind, text, definition, { maxRuleDurationSeconds: 20 }, 20).disposition).toBe(
        'allow',
      );
    }
  });

  it('never applies an over-long demand, even with an adult supervising', () => {
    const definition = definitions[0] as GameDefinition;
    const limit = policyFor(definition).maxRuleDurationSeconds;
    const supervised = verdict(kind, text, definition, { supervisedByAdult: true }, limit + 1);
    // Supervision turns this one refusal into a request to revise. It is still not allowed.
    expect(supervised.disposition).not.toBe('allow');
  });
});

describe('what reaches the engine', () => {
  const state = runningState('tag');
  const zone = (place: string) => ({
    type: 'ZONE_CHANGE',
    modifier: 'SAFE_ZONE',
    zone: place,
    durationSeconds: 60,
  });

  it('is only an event the validator cleared', () => {
    const cleared = validateSafety(validatedFor(state, zone('the bench')), state);
    expect(cleared.ok).toBe(true);
    expect(cleared.ok && releaseClearedEvent(cleared.value).ok).toBe(true);
  });

  it('is never a critical hazard, under any option', () => {
    for (const options of OPTIONS) {
      for (const place of CRITICAL_PLACES) {
        const refused = validateSafety(validatedFor(state, zone(place)), state, options);
        expect(refused.ok, `${place} ${JSON.stringify(options)}`).toBe(false);
      }
    }
  });

  it('is never something the validator did not see', () => {
    for (const forged of [
      zone('the bench'),
      { event: zone('the bench'), gameId: state.id, definitionId: 'tag' },
      null,
      undefined,
      'ZONE_CHANGE',
    ]) {
      const refused = validateSafety(forged as never, state);
      expect(!refused.ok && refused.error.kind).toBe('NOT_EVALUATED');
      expect(releaseClearedEvent(forged as never).ok).toBe(false);
    }
  });

  it('is never an event cleared for a different game', () => {
    const other = runningState('tag', 'another-session');
    const refused = validateSafety(validatedFor(state, zone('the bench')), other);
    expect(!refused.ok && refused.error.kind).toBe('NOT_EVALUATED');
  });
});

describe('the validator stays what it is', () => {
  it('gives the same verdict every time', () => {
    const tag = definitions[0] as GameDefinition;
    for (const text of [...SAFE_INSTRUCTIONS, ...CRITICAL_INSTRUCTIONS]) {
      const first = verdict('BONUS_OBJECTIVE', text, tag);
      expect(verdict('BONUS_OBJECTIVE', text, tag)).toEqual(first);
    }
  });

  it('answers at once: it returns a verdict, not a promise', () => {
    const result = verdict(
      'BONUS_OBJECTIVE',
      'Touch the big oak.',
      definitions[0] as GameDefinition,
    );
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.policyVersion).toMatch(/\S/);
  });
});
