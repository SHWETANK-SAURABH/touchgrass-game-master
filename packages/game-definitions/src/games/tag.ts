import { defineGame } from '../schema';

export const tag = defineGame({
  id: 'tag',
  name: 'Tag',
  tagline: 'One chaser, everyone else running — until the Game Master changes the rules.',
  description:
    'The oldest game there is. One tagger chases everyone else; a tagged runner becomes the tagger. On its own a round of tag lasts about ninety seconds before it gets boring. The Game Master is what keeps it alive: every so often it rewrites one rule mid-chase, so the shape of the game keeps shifting under the players feet.',
  minPlayers: 2,
  maxPlayers: 4,
  recommendedDurationMinutes: 15,
  spaceRequirement: 'medium',
  intensity: 'high',
  equipment: [],
  roles: [
    {
      id: 'tagger',
      label: 'Tagger',
      description: 'Chases the runners. Tags with an open hand, on the back or shoulder only.',
      min: 1,
      max: 1,
    },
    {
      id: 'runner',
      label: 'Runner',
      description: 'Stays untagged for as long as possible.',
      min: 1,
      isDefault: true,
    },
  ],
  phases: [
    {
      id: 'briefing',
      label: 'Briefing',
      description:
        'Players agree the boundary out loud, point at the four edges, and the taggers count to ten.',
      typicalDurationSeconds: 90,
    },
    {
      id: 'chase',
      label: 'Chase',
      description:
        'Open play. The Game Master injects modifiers and announcements while the round runs.',
      typicalDurationSeconds: 600,
    },
    {
      id: 'final-round',
      label: 'Final Round',
      description: 'Last ninety seconds. Points are doubled and no new modifiers are introduced.',
      typicalDurationSeconds: 90,
    },
  ],
  allowedEventKinds: [
    'ZONE_CHANGE',
    'POWER_UP',
    'BONUS_OBJECTIVE',
    'TIME_EXTENSION',
    'ROLE_CHANGE',
  ],
  allowedModifiers: [
    'SAFE_ZONE',
    'MOVING_ZONE',
    'TEMPORARY_POWER_UP',
    'BONUS_OBJECTIVE',
    'TIME_EXTENSION',
    'ROLE_SWAP',
  ],
  allowedActionKinds: [
    'PLAYER_READY',
    'PLAYER_TAGGED',
    'PLAYER_ACTIVATED_POWER',
    'PLAYER_COMPLETED_CHALLENGE',
    'PLAYER_ACCEPTED_EVENT',
  ],
  rules: [
    {
      id: 'tag-passes-it',
      description: 'When the tagger tags a runner, the runner becomes the tagger.',
      action: 'PLAYER_TAGGED',
      actorRoleId: 'tagger',
      targetRoleId: 'runner',
      outcome: 'SWAP_ROLES',
    },
  ],
  powers: [
    {
      id: 'shield',
      label: 'Shield',
      description: 'The holder cannot be tagged while the shield is up.',
      effect: 'TAG_IMMUNITY',
      durationSeconds: 20,
    },
  ],
  scoring: [
    { trigger: 'TAG_MADE', points: 2 },
    { trigger: 'ROUND_SURVIVED', points: 1 },
  ],
  winConditions: [{ type: 'HIGHEST_SCORE' }],
  settings: { totalRounds: 3, roundDurationSeconds: 180 },
  modifierThemes: [
    'movement constraints',
    'animal mimicry',
    'sound and silence',
    'temporary safe spots',
    'role reversals',
  ],
  safety: {
    contactPolicy: 'tag-only',
    maxIntensity: 'high',
    involvesSeparation: false,
    requiresDaylight: true,
    inherentRisks: [
      'Sprinting players collide with each other or with fixed obstacles.',
      'Attention is on the chaser, not on the ground, so trip hazards go unseen.',
      'Players drift past the agreed boundary while focused on the chase.',
      'A tag can escalate into a grab or a shove when the chase is close.',
    ],
  },
  gameMaster: {
    persona:
      'A fast-talking sports commentator who announces rule changes like breaking news. Short sentences. High energy. Never more than two sentences at a time, because players are out of breath and moving.',
    encourage: [
      'Change how bodies may move: hopping, side-stepping, walking only, hands behind the back.',
      'Introduce short-lived safe spots tied to things players can already see.',
      'Flip the chase: make a runner into a tagger at a dramatic moment.',
      'Use silence and sound as rules, since they cost no space and no equipment.',
    ],
    avoid: [
      'Anything that sends players toward a road, car park, or boundary they cannot see.',
      'Climbing, jumping down from height, or getting onto anything above knee height.',
      'Grabbing, tackling, holding, pushing, or any contact beyond an open-handed tag.',
      'Blindfolds or closed eyes while anyone is running.',
      'Objects picked up off the ground and thrown.',
    ],
    exampleTwists: [
      'Taggers may only move by hopping on one foot for the next sixty seconds.',
      'Anyone standing perfectly still with both arms raised cannot be tagged, but only for five seconds at a time.',
      'From now on, a tagger must announce their target by name before the tag counts.',
      'Everyone must move silently. The first player to make a noise joins the taggers.',
    ],
  },
});
