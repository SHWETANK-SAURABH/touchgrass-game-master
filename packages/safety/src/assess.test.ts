import { describe, expect, it } from 'vitest';
import { getGameDefinition } from '@touchgrass/game-definitions';
import type { ExternalGameEvent } from '@touchgrass/game-engine';
import { assessEventSafety } from './assess';
import { HAZARD_CATEGORY_IDS, type HazardCategoryId } from './hazards';
import { POLICY_VERSION, policyFor } from './policy';
import { LEXICAL_RULES } from './rules';
import { challengeEvent, deepFreeze, objectiveEvent, zoneEvent } from './test-support';
import { normalise, unreadableReason } from './text';
import { safetyVerdictSchema } from './verdict';

const tag = policyFor(getGameDefinition('tag'));
const hideAndSeek = policyFor(getGameDefinition('hide-and-seek'));
const nature = policyFor(getGameDefinition('nature-challenge'));

const hazardsOf = (event: ExternalGameEvent, policy = tag) =>
  assessEventSafety(event, policy).violations.map((entry) => entry.hazard);

describe('safe events are allowed', () => {
  it.each([
    'Touch the gate and shout your name.',
    'First to touch the big oak scores.',
    'Collected all 5 hidden gems.',
    'Find three different leaves on the ground.',
    'Do five star jumps on the grass.',
    'Spot something yellow and point at it.',
    'Freeze like a statue for ten seconds.',
    'Run to the big oak and back.',
    'Name three birds you can hear.',
  ])('objective: %s', (description) => {
    const verdict = assessEventSafety(objectiveEvent(description), tag);
    expect(verdict.violations).toEqual([]);
    expect(verdict.disposition).toBe('allow');
  });

  it.each([
    'the bench',
    'the bench by the gate',
    'the old oak tree',
    'the current playing area',
    'The area around Ada.',
    'the big open grass',
  ])('zone: %s', (zone) => {
    expect(assessEventSafety(zoneEvent(zone), tag).disposition).toBe('allow');
    expect(assessEventSafety(zoneEvent(zone), hideAndSeek).disposition).toBe('allow');
  });

  it.each<ExternalGameEvent>([
    { type: 'POWER_UP', playerId: 'p1', powerId: 'shield' },
    { type: 'TIME_EXTENSION', seconds: 60 },
    {
      type: 'ROLE_CHANGE',
      assignments: [
        { playerId: 'p1', roleId: 'tagger' },
        { playerId: 'p0', roleId: 'runner' },
      ],
    },
    { type: 'RULE_MODIFIER', modifier: 'FREEZE_PERIOD', roleIds: ['seeker'], durationSeconds: 30 },
  ])('an event with no player-facing text: $type', (event) => {
    const verdict = assessEventSafety(event, hideAndSeek);
    expect(verdict.disposition).toBe('allow');
    expect(verdict.checkedFields).not.toContain('description');
  });

  it('says which fields it examined', () => {
    expect(assessEventSafety(objectiveEvent('Touch the big oak.'), tag).checkedFields).toEqual([
      'description',
      'objectiveId',
      'durationSeconds',
    ]);
    expect(assessEventSafety(zoneEvent('the bench'), tag).checkedFields).toEqual(['zone']);
    expect(assessEventSafety({ type: 'TIME_EXTENSION', seconds: 30 }, tag).checkedFields).toEqual(
      [],
    );
  });

  it('produces a verdict that matches the verdict schema and carries the policy version', () => {
    for (const event of [objectiveEvent('Touch the big oak.'), zoneEvent('the car park')]) {
      const verdict = assessEventSafety(event, tag);
      expect(safetyVerdictSchema.safeParse(verdict).success).toBe(true);
      expect(verdict.policyVersion).toBe(POLICY_VERSION);
    }
  });
});

describe('unsafe instructions are rejected', () => {
  const cases: [string, HazardCategoryId][] = [
    // Physical hazards
    ['Run across the road and touch the lamp post.', 'roads-and-traffic'],
    ['Race to the car park and back.', 'roads-and-traffic'],
    ['Stand on the railway tracks.', 'roads-and-traffic'],
    ['Climb the big tree and wave.', 'climbing-and-heights'],
    ['Jump off the wall.', 'climbing-and-heights'],
    ['Get up on the roof.', 'climbing-and-heights'],
    ['Wade into the pond to fetch the ball.', 'water'],
    ['Swim to the far bank.', 'water'],
    ['Light a small fire with sticks.', 'fire-and-heat'],
    ['Find a piece of glass on the ground.', 'dangerous-objects'],
    ['Throw stones at the target.', 'dangerous-objects'],
    ['Look through the rubbish for a bottle top.', 'dangerous-objects'],
    ['Use a stick as a sword.', 'weapons'],
    ['Do a backflip.', 'dangerous-physical-challenge'],
    ['Hold your breath as long as you can.', 'dangerous-physical-challenge'],
    ['Run with your eyes closed.', 'sensory-deprivation'],
    ['Put on a blindfold and find the tree.', 'sensory-deprivation'],
    ['Eat a berry from the bush.', 'ingestion'],
    ['Catch a squirrel.', 'wildlife-and-plants'],
    ['Pick five flowers.', 'wildlife-and-plants'],
    ['Play this round in the dark.', 'darkness-and-visibility'],
    // Property
    ['Climb the abandoned building.', 'restricted-and-private-property'],
    ['Hop over the fence into the garden.', 'restricted-and-private-property'],
    ['Hide inside the shed.', 'restricted-and-private-property'],
    ['Go onto the construction site.', 'restricted-and-private-property'],
    ['Knock over the sign.', 'restricted-and-private-property'],
    ['Smash the flower pot.', 'restricted-and-private-property'],
    // Human safety
    ['Tackle the tagger to the ground.', 'forced-physical-contact'],
    ['Carry your partner to the tree.', 'forced-physical-contact'],
    ['Push the nearest runner.', 'forced-physical-contact'],
    ['Punch the slowest player.', 'aggression-and-harassment'],
    ['Mock the last player to arrive.', 'aggression-and-harassment'],
    ['Threaten the seeker until they give up.', 'aggression-and-harassment'],
    ['Ask a stranger for the time.', 'strangers'],
    ['Follow someone walking a dog.', 'strangers'],
    ['Get a passer-by to join in.', 'strangers'],
    ['Go off on your own and wait.', 'isolation-and-separation'],
    ['Hide where nobody can see you.', 'isolation-and-separation'],
    // Privacy
    ['Take a photo of another player.', 'privacy'],
    ['Shout your home address.', 'privacy'],
    ['Record a video of the tagger.', 'privacy'],
    ['Tell everyone your phone number.', 'privacy'],
    // Ambiguous or open-ended
    ['Go anywhere you like.', 'unassessable-instruction'],
    ['Do whatever it takes to win.', 'unassessable-instruction'],
    ['Run as far as possible.', 'unassessable-instruction'],
    ['Leave the park and come back.', 'unassessable-instruction'],
  ];

  it.each(cases)('%s → %s', (description, hazard) => {
    const verdict = assessEventSafety(objectiveEvent(description), tag);
    expect(verdict.disposition).toBe('reject');
    expect(verdict.violations.map((entry) => entry.hazard)).toContain(hazard);
  });

  it.each(cases)('the same instruction as a challenge: %s', (description, hazard) => {
    expect(hazardsOf(challengeEvent(description), nature)).toContain(hazard);
  });

  it.each([
    ['the car park', 'roads-and-traffic'],
    ['the pond', 'water'],
    ['behind the fence', 'restricted-and-private-property'],
    ['the roof of the shed', 'climbing-and-heights'],
    ['the other side of the road', 'roads-and-traffic'],
    ['anywhere you like', 'unassessable-instruction'],
  ] as const)('zone "%s" → %s', (zone, hazard) => {
    const verdict = assessEventSafety(zoneEvent(zone), tag);
    expect(verdict.disposition).toBe('reject');
    expect(verdict.violations.map((entry) => entry.hazard)).toContain(hazard);
    expect(verdict.violations.every((entry) => entry.field === 'zone')).toBe(true);
  });

  it('reports the rule, the field and the words that matched', () => {
    const verdict = assessEventSafety(objectiveEvent('Run across the road.'), tag);
    expect(verdict.violations).toEqual([
      {
        hazard: 'roads-and-traffic',
        severity: 'critical',
        rule: 'road-places',
        field: 'description',
        evidence: 'road',
        explanation: 'It refers to a road, vehicles, or somewhere traffic moves.',
      },
    ]);
  });

  it('reports every hazard an instruction touches', () => {
    const hazards = hazardsOf(objectiveEvent('Climb the fence by the road and jump in the pond.'));
    expect(hazards).toEqual(
      expect.arrayContaining([
        'roads-and-traffic',
        'climbing-and-heights',
        'water',
        'restricted-and-private-property',
      ]),
    );
  });

  it('checks an id the model chose, because it is model-written text too', () => {
    const verdict = assessEventSafety(
      objectiveEvent('Touch the big oak.', { objectiveId: 'climb-the-roof' }),
      tag,
    );
    expect(verdict.disposition).toBe('reject');
    expect(verdict.violations[0]?.field).toBe('objectiveId');

    expect(hazardsOf(challengeEvent('Touch the big oak.', 'cross_the_road'), nature)).toContain(
      'roads-and-traffic',
    );
  });

  it('does not accept a mention of a hazard just because the sentence says to avoid it', () => {
    // A deliberate false positive: the rules do not understand sentences.
    expect(assessEventSafety(objectiveEvent('Stay away from the road.'), tag).disposition).toBe(
      'reject',
    );
  });
});

describe('the game definition shapes the policy', () => {
  it('holds a contact-free game to no contact, and allows a tag in a tag game', () => {
    const highFive = objectiveEvent('High five another player.');
    expect(assessEventSafety(highFive, tag).disposition).toBe('allow');

    const verdict = assessEventSafety(highFive, hideAndSeek);
    expect(verdict.disposition).toBe('reject');
    expect(verdict.violations[0]).toMatchObject({
      hazard: 'forced-physical-contact',
      rule: 'player-contact-in-contact-free-game',
    });
  });

  it('refuses contact beyond a tag in every game', () => {
    for (const policy of [tag, hideAndSeek, nature]) {
      expect(hazardsOf(objectiveEvent('Grab the nearest player.'), policy)).toContain(
        'forced-physical-contact',
      );
    }
  });

  it('refuses a demand that lasts longer than the game allows', () => {
    // Tag is high intensity: 120 seconds. Hide & Seek is moderate: 180.
    const long = objectiveEvent('Touch the big oak.', { durationSeconds: 150 });
    const verdict = assessEventSafety(long, tag);
    expect(verdict.disposition).toBe('reject');
    expect(verdict.violations).toEqual([
      expect.objectContaining({
        hazard: 'dangerous-physical-challenge',
        severity: 'moderate',
        rule: 'rule-duration',
        field: 'durationSeconds',
        evidence: '150s > 120s',
      }),
    ]);
    expect(assessEventSafety(long, hideAndSeek).disposition).toBe('allow');

    const freeze: ExternalGameEvent = {
      type: 'RULE_MODIFIER',
      modifier: 'FREEZE_PERIOD',
      roleIds: ['seeker'],
      durationSeconds: 200,
    };
    expect(assessEventSafety(freeze, hideAndSeek).disposition).toBe('reject');
  });

  it('does not treat the length of a zone or a time extension as a demand', () => {
    const longZone: ExternalGameEvent = {
      type: 'ZONE_CHANGE',
      modifier: 'SAFE_ZONE',
      zone: 'the bench',
      durationSeconds: 600,
    };
    expect(assessEventSafety(longZone, tag).disposition).toBe('allow');
    expect(assessEventSafety({ type: 'TIME_EXTENSION', seconds: 300 }, tag).disposition).toBe(
      'allow',
    );
  });

  it('lets a host shorten the limit but never lengthen it', () => {
    const event = objectiveEvent('Touch the big oak.', { durationSeconds: 60 });
    const strict = policyFor(getGameDefinition('tag'), { maxRuleDurationSeconds: 30 });
    expect(assessEventSafety(event, strict).disposition).toBe('reject');

    const long = objectiveEvent('Touch the big oak.', { durationSeconds: 150 });
    const loose = policyFor(getGameDefinition('tag'), { maxRuleDurationSeconds: 9_999 });
    expect(assessEventSafety(long, loose).disposition).toBe('reject');
  });
});

describe('dispositions', () => {
  const supervised = policyFor(getGameDefinition('tag'), { supervisedByAdult: true });
  const dark = objectiveEvent('Play this round in the dark.');

  it('rejects a moderate violation by default', () => {
    expect(assessEventSafety(dark, tag).disposition).toBe('reject');
  });

  it('marks a moderate-only violation "revise" under adult supervision, which is still not allow', () => {
    const verdict = assessEventSafety(dark, supervised);
    expect(verdict.disposition).toBe('revise');
    expect(verdict.violations).toHaveLength(1);
  });

  it('rejects a serious violation whatever the supervision', () => {
    expect(assessEventSafety(objectiveEvent('Run across the road.'), supervised).disposition).toBe(
      'reject',
    );
    expect(
      assessEventSafety(objectiveEvent('Cross the road in the dark.'), supervised).disposition,
    ).toBe('reject');
  });

  it('never allows an event that has a violation', () => {
    const texts = ['Run across the road.', 'Play in the dark.', 'Touch the big oak.', '!!!'];
    for (const policy of [tag, supervised, hideAndSeek, nature]) {
      for (const text of texts) {
        for (const durationSeconds of [30, 600]) {
          const verdict = assessEventSafety(objectiveEvent(text, { durationSeconds }), policy);
          expect(verdict.disposition === 'allow').toBe(verdict.violations.length === 0);
        }
      }
    }
  });
});

describe('fail closed: text that cannot be assessed is refused', () => {
  it.each([
    ['another script', 'Залезь на крышу'],
    ['another script, mixed', 'Go to the 屋根 now'],
    ['emoji only', '🔥🔥🔥'],
    ['punctuation only', '!!! ???'],
    ['digits only', '12345'],
    ['a zero-width character inside a word', 'cl​imb the wall'],
    ['words spelled out letter by letter', 'c l i m b the wall'],
    ['a control character', 'touch the oak\u0007'],
  ])('%s', (_label, text) => {
    for (const event of [objectiveEvent(text), zoneEvent(text)]) {
      const verdict = assessEventSafety(event, tag);
      expect(verdict.disposition).toBe('reject');
      expect(verdict.violations[0]).toMatchObject({
        hazard: 'unassessable-instruction',
        rule: 'unreadable-text',
      });
    }
  });

  it('accepts an id with no words in it, but not an unreadable one', () => {
    expect(
      assessEventSafety(objectiveEvent('Touch the big oak.', { objectiveId: '17' }), tag)
        .disposition,
    ).toBe('allow');
    for (const objectiveId of ['крыша', 'c-l-i-m-b']) {
      const verdict = assessEventSafety(objectiveEvent('Touch the big oak.', { objectiveId }), tag);
      expect(verdict.disposition).toBe('reject');
      expect(verdict.violations[0]).toMatchObject({
        hazard: 'unassessable-instruction',
        field: 'objectiveId',
      });
    }
  });

  it.each([
    'CLIMB THE WALL!',
    'Clímb the wall',
    'climb-the_wall',
    'ｃｌｉｍｂ the wall',
    '  climb,   the... wall  ',
    'Climb\nthe\twall',
  ])('sees through case, accents, punctuation and width: %s', (text) => {
    expect(hazardsOf(objectiveEvent(text))).toContain('climbing-and-heights');
  });

  it('normalises text to plain lower-case words', () => {
    expect(normalise('Climb  the WALL!')).toBe('climb the wall');
    expect(normalise("Don't-stop_now")).toBe('dont stop now');
    expect(unreadableReason('Touch the big oak.')).toBeNull();
    expect(unreadableReason('café by the oak')).toBeNull();
  });
});

describe('the assessment is pure and deterministic', () => {
  it('gives the same verdict for the same event and policy', () => {
    for (const event of [objectiveEvent('Run across the road.'), zoneEvent('the bench')]) {
      const first = assessEventSafety(event, tag);
      const second = assessEventSafety(event, tag);
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it('does not depend on what was assessed before', () => {
    const alone = assessEventSafety(objectiveEvent('Run across the road.'), tag);
    assessEventSafety(objectiveEvent('Touch the big oak.'), tag);
    assessEventSafety(objectiveEvent('Cross the road, then the road again.'), tag);
    expect(assessEventSafety(objectiveEvent('Run across the road.'), tag)).toEqual(alone);
  });

  it('changes neither the event nor the policy', () => {
    const event = deepFreeze(objectiveEvent('Climb the fence by the road.'));
    const policy = deepFreeze(policyFor(getGameDefinition('tag')));
    const snapshot = structuredClone(event);
    expect(() => assessEventSafety(event, policy)).not.toThrow();
    expect(event).toEqual(snapshot);
  });

  it('carries no timing or other run-dependent value', () => {
    expect(Object.keys(assessEventSafety(zoneEvent('the bench'), tag)).sort()).toEqual([
      'checkedFields',
      'disposition',
      'policyVersion',
      'violations',
    ]);
  });
});

describe('the rule table', () => {
  it('has unique rule ids', () => {
    const ids = LEXICAL_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has at least one rule for every hazard category', () => {
    const covered = new Set<string>(LEXICAL_RULES.map((rule) => rule.hazard));
    for (const id of HAZARD_CATEGORY_IDS) expect(covered.has(id), id).toBe(true);
  });

  it('uses stateless patterns', () => {
    // A global or sticky pattern remembers where it last matched, which would
    // make a verdict depend on the previous call.
    for (const rule of LEXICAL_RULES) expect(rule.pattern.flags, rule.id).toBe('');
  });

  it.each(LEXICAL_RULES)('$id explains itself', (rule) => {
    expect(rule.explanation.length).toBeGreaterThan(20);
  });
});
