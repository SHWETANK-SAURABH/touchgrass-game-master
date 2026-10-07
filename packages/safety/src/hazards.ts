import { z } from 'zod';

/**
 * The hazard taxonomy.
 *
 * This is the vocabulary the safety layer reasons in. It exists in this phase,
 * ahead of the validator itself, because the taxonomy is the hard part: deciding
 * *what* counts as a hazard, how severe it is, and what evidence would show it, is
 * a product and judgement exercise. Writing matching rules afterwards is
 * mechanical.
 *
 * Nothing here consults a model. A hazard is identified by deterministic means —
 * lexical matching over proposal text, plus structural checks against the game
 * definition — so that two identical proposals always receive the same verdict,
 * and so a verdict can be explained to a parent in one sentence.
 *
 * `severity` decides the disposition the validator will take:
 *
 *   critical  reject the whole turn, log it, and never show it to players
 *   high      reject this proposal, let the rest of the turn through
 *   moderate  reject this proposal, and allow one repair attempt
 */

export const hazardSeveritySchema = z.enum(['moderate', 'high', 'critical']);
export type HazardSeverity = z.infer<typeof hazardSeveritySchema>;

export const HAZARD_CATEGORY_IDS = [
  'roads-and-traffic',
  'climbing-and-heights',
  'water',
  'restricted-and-private-property',
  'dangerous-objects',
  'weapons',
  'fire-and-heat',
  'forced-physical-contact',
  'strangers',
  'dangerous-physical-challenge',
  'sensory-deprivation',
  'ingestion',
  'wildlife-and-plants',
  'isolation-and-separation',
  'darkness-and-visibility',
] as const;

export const hazardCategoryIdSchema = z.enum(HAZARD_CATEGORY_IDS);
export type HazardCategoryId = z.infer<typeof hazardCategoryIdSchema>;

export interface HazardCategory {
  readonly id: HazardCategoryId;
  readonly label: string;
  /** What the category covers, in one sentence. */
  readonly description: string;
  readonly severity: HazardSeverity;
  /** Why this is on the list at all — the real-world failure it prevents. */
  readonly rationale: string;
  /**
   * Illustrative phrasings a generated proposal might contain. These are
   * documentation and test fixtures for the planned rule set, not the rule set:
   * the validator will combine lexical signals with structural checks, because a
   * word list alone is trivially evaded and also over-triggers.
   */
  readonly exampleSignals: readonly string[];
}

export const HAZARD_CATEGORIES: readonly HazardCategory[] = [
  {
    id: 'roads-and-traffic',
    label: 'Roads and traffic',
    description:
      'Anything that routes a player toward or across a road, car park, driveway, cycle path, or tram or rail line.',
    severity: 'critical',
    rationale:
      'A running child who is watching a chaser is not watching for a car. This is the single most likely way an outdoor game kills someone, and it is the one hazard the system can never see for itself, because it has no map of what is past the hedge.',
    exampleSignals: [
      'cross the road',
      'to the car park',
      'the far pavement',
      'past the traffic lights',
      'the bus stop on the other side',
    ],
  },
  {
    id: 'climbing-and-heights',
    label: 'Climbing and heights',
    description:
      'Climbing trees, walls, fences, play equipment, or structures; standing on anything raised; jumping down from height.',
    severity: 'critical',
    rationale:
      'Falls are the most common cause of serious injury in outdoor play. A twist that rewards getting higher turns the whole group into competitive climbers within seconds.',
    exampleSignals: [
      'climb the tree',
      'get on top of',
      'jump down from',
      'over the wall',
      'as high as you can',
    ],
  },
  {
    id: 'water',
    label: 'Water',
    description:
      'Ponds, lakes, rivers, streams, canals, fountains, drainage ditches, culverts, and flooded ground.',
    severity: 'critical',
    rationale:
      'Drowning is silent and fast, and shallow water is not safe water. The system has no way to know the depth, the bank, or the current, so no proposal may send anyone toward water at all.',
    exampleSignals: [
      'the edge of the pond',
      'wade across',
      'in the stream',
      'by the riverbank',
      'through the fountain',
    ],
  },
  {
    id: 'restricted-and-private-property',
    label: 'Restricted areas and trespassing',
    description:
      'Private gardens, fenced or gated ground, building sites, car parks, buildings, vehicles, and anywhere marked as off-limits.',
    severity: 'critical',
    rationale:
      'Beyond the legal problem, a fence usually exists because of a hazard on the other side. A game that sends players over one has lost both its safety model and its welcome.',
    exampleSignals: [
      'over the fence',
      'through the gate marked',
      'into the garden',
      'inside the building',
      'behind the site hoarding',
    ],
  },
  {
    id: 'dangerous-objects',
    label: 'Dangerous objects',
    description:
      'Litter, broken glass, needles, scrap metal, tools, heavy objects, and anything to be thrown, dug up, or reached for blind.',
    severity: 'high',
    rationale:
      'Scavenger-style objectives are the natural place for this to appear: "find five interesting things" is one short step from a child picking up a syringe.',
    exampleSignals: [
      'pick up anything metal',
      'throw it at',
      'dig up',
      'reach into the hole',
      'collect five objects',
    ],
  },
  {
    id: 'weapons',
    label: 'Weapons',
    description:
      'Sticks as swords, stones as projectiles, and any object repurposed to strike or be thrown at a person.',
    severity: 'critical',
    rationale:
      'A model asked to make tag more exciting will reach for combat metaphors. Those metaphors have to stop at the schema, because children act them out literally.',
    exampleSignals: ['use a stick', 'throw stones', 'sword fight', 'hit them with', 'as a weapon'],
  },
  {
    id: 'fire-and-heat',
    label: 'Fire and heat',
    description:
      'Actual flame, matches, lighters, barbecues, hot surfaces, and anything burned or lit.',
    severity: 'critical',
    rationale:
      'Ice & Fire names an element in its title. That is exactly the kind of thematic pull that produces a literal suggestion, so the elemental metaphor must be enforced as metaphor.',
    exampleSignals: ['light a', 'set it on fire', 'matches', 'a real flame', 'burn the'],
  },
  {
    id: 'forced-physical-contact',
    label: 'Forced physical contact',
    description:
      'Grabbing, holding, tackling, pushing, pulling, lifting, carrying, wrestling, or any contact beyond what the game declared.',
    severity: 'critical',
    rationale:
      'Consent and contact limits are what separate tag from a fight. Each game declares its own contact policy, and no proposal may widen it — not even to make a round more dramatic.',
    exampleSignals: [
      'hold them down',
      'tackle',
      'pick up your teammate',
      'wrestle for',
      'drag them back',
    ],
  },
  {
    id: 'strangers',
    label: 'Strangers',
    description:
      'Approaching, following, talking to, photographing, touching, or taking anything from people outside the game.',
    severity: 'critical',
    rationale:
      'A scavenger hunt will cheerfully suggest asking a passer-by for a clue. That is a safeguarding failure and a harassment risk in the same sentence.',
    exampleSignals: [
      'ask a stranger',
      'follow someone',
      'take a photo of a person',
      'get a passer-by to',
      'borrow something from someone nearby',
    ],
  },
  {
    id: 'dangerous-physical-challenge',
    label: 'Dangerous physical challenge',
    description:
      'Exertion or body positions beyond the game declared intensity: sprint races on unknown ground, holding painful poses, breath-holding, spinning, piggybacks, crawling on hard surfaces.',
    severity: 'high',
    rationale:
      'Each game declares a maximum intensity. A proposal that exceeds it is unsafe for the least able player present, who is also the one least likely to say so in front of the group.',
    exampleSignals: [
      'hold your breath',
      'spin ten times',
      'piggyback',
      'sprint flat out',
      'hold the position until',
    ],
  },
  {
    id: 'sensory-deprivation',
    label: 'Sensory deprivation',
    description:
      'Blindfolds, closed eyes, covered ears, or hands over the face while anyone is moving.',
    severity: 'critical',
    rationale:
      'Blindfold variants are a classic party-game twist and are genuinely dangerous outdoors, where the ground is uneven and other players are running.',
    exampleSignals: [
      'blindfolded',
      'close your eyes and run',
      'cover your eyes',
      'eyes shut while',
    ],
  },
  {
    id: 'ingestion',
    label: 'Tasting and eating',
    description: 'Eating, tasting, licking, chewing, or drinking anything found outdoors.',
    severity: 'critical',
    rationale:
      'Nature Challenge invites sensory exploration, and taste is a sense. Berries, mushrooms, and sap make that a poisoning route, so taste is removed from the game entirely.',
    exampleSignals: ['taste it', 'eat one', 'lick the', 'chew on', 'try the berries'],
  },
  {
    id: 'wildlife-and-plants',
    label: 'Wildlife and plants',
    description:
      'Touching or approaching animals, nests, burrows, hives, or droppings; handling mushrooms, berries, sap, thorns, or nettles; picking or uprooting living plants.',
    severity: 'high',
    rationale:
      'Two risks in one category: harm to the player from stings, bites, and irritants, and harm to the place from a group that strips it. A game about touching grass should leave the grass there.',
    exampleSignals: [
      'pick the flowers',
      'catch an insect',
      'touch the mushroom',
      'reach into the nest',
      'pull up a plant',
    ],
  },
  {
    id: 'isolation-and-separation',
    label: 'Isolation and separation',
    description:
      'Sending a player out of sight or earshot of the group, splitting the group beyond the agreed area, or any instruction to go somewhere alone.',
    severity: 'high',
    rationale:
      'Hide & Seek and Treasure Hunt declare separation as inherent, so the rule is not "never separate" but "never widen the separation the game already declared". A player nobody can see is a player nobody can help.',
    exampleSignals: [
      'go alone to',
      'out of sight of everyone',
      'leave the group and',
      'where nobody can hear you',
    ],
  },
  {
    id: 'darkness-and-visibility',
    label: 'Darkness and poor visibility',
    description: 'Play in the dark, in heavy weather, or anywhere players cannot see the ground.',
    severity: 'moderate',
    rationale:
      'Every bundled game declares `requiresDaylight`. This category is moderate rather than critical because the mitigation is usually to stop and reschedule, not to reject a single rule.',
    exampleSignals: ['after dark', 'with the lights off', 'in the dark', 'once the sun is down'],
  },
];

const BY_ID = new Map<HazardCategoryId, HazardCategory>(
  HAZARD_CATEGORIES.map((category) => [category.id, category]),
);

export function getHazardCategory(id: HazardCategoryId): HazardCategory {
  const category = BY_ID.get(id);
  if (!category) throw new Error(`Unknown hazard category "${id}"`);
  return category;
}

/** Categories at or above a severity, for building a policy's active rule set. */
export function hazardsAtLeast(severity: HazardSeverity): readonly HazardCategory[] {
  const rank: Record<HazardSeverity, number> = { moderate: 1, high: 2, critical: 3 };
  return HAZARD_CATEGORIES.filter((category) => rank[category.severity] >= rank[severity]);
}

/**
 * Hazards that must always be enforced regardless of game, policy, or player age.
 * Nothing in the eventual configuration surface may switch these off.
 */
export const NON_NEGOTIABLE_HAZARDS: readonly HazardCategoryId[] = HAZARD_CATEGORIES.filter(
  (category) => category.severity === 'critical',
).map((category) => category.id);
