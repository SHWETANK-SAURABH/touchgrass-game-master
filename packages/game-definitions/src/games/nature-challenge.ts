import { defineGame } from '../schema';

export const natureChallenge = defineGame({
  id: 'nature-challenge',
  name: 'Nature Challenge',
  tagline: 'Short observation challenges that only work if you are actually outside.',
  description:
    'A low-intensity, cooperative mode: the Game Master issues a stream of small observation and sensory challenges, and players complete them in the space they are standing in. Find bark with two different textures. Name four sounds you can hear right now. Find something older than you are. It is the gentlest game in the set and the one that proves the theme hardest, because none of it can be done from a sofa. It also works for two players, in a small garden, in fifteen minutes.',
  minPlayers: 2,
  maxPlayers: 30,
  recommendedDurationMinutes: 20,
  spaceRequirement: 'small',
  intensity: 'low',
  equipment: [],
  roles: [
    {
      id: 'explorer',
      label: 'Explorer',
      description: 'Completes challenges and shows the group what they found.',
      min: 2,
      isDefault: true,
    },
    {
      id: 'scribe',
      label: 'Scribe',
      description:
        'Holds the phone, reads challenges aloud, and marks them complete for the group.',
      min: 0,
      max: 2,
    },
  ],
  phases: [
    {
      id: 'warm-up',
      label: 'Warm Up',
      description:
        'Two or three easy challenges to get everyone looking around and away from the screen.',
      typicalDurationSeconds: 180,
    },
    {
      id: 'challenges',
      label: 'Challenges',
      description:
        'The main loop. The Game Master issues challenges, escalating from looking to listening to noticing.',
      typicalDurationSeconds: 900,
    },
    {
      id: 'show-and-tell',
      label: 'Show and Tell',
      description:
        'Players present their best find to the group. Nothing is scored; the group votes on a favourite.',
      typicalDurationSeconds: 180,
    },
  ],
  allowedEventKinds: ['CHALLENGE', 'BONUS_OBJECTIVE', 'TIME_EXTENSION'],
  allowedModifiers: ['BONUS_OBJECTIVE', 'TIME_EXTENSION'],
  allowedActionKinds: ['PLAYER_READY', 'PLAYER_COMPLETED_CHALLENGE', 'PLAYER_ACCEPTED_EVENT'],
  rules: [],
  powers: [],
  scoring: [],
  winConditions: [{ type: 'HIGHEST_SCORE' }],
  settings: { totalRounds: 1, roundDurationSeconds: 900 },
  modifierThemes: [
    'sight',
    'sound',
    'texture',
    'scale and age',
    'colour matching',
    'counting and patterns',
  ],
  safety: {
    contactPolicy: 'none',
    maxIntensity: 'low',
    involvesSeparation: false,
    requiresDaylight: true,
    inherentRisks: [
      'Challenges invite players to touch plants, which may sting, scratch, or irritate skin.',
      'Looking for small things at ground level means crouching near litter, glass, or waste.',
      'A challenge phrased loosely may lead a player to taste or smell something unknown.',
      'Searching while looking down means not seeing obstacles at head height.',
    ],
  },
  gameMaster: {
    persona:
      'A quietly enthusiastic field naturalist. One challenge at a time, one sentence long, phrased so a child and an adult both want to do it. Curious rather than instructional.',
    encourage: [
      'Lead with the senses: look, listen, touch bark and stone, notice temperature and shade.',
      'Use comparison and counting, which work in any outdoor space including a small garden.',
      'Ask for things that are findable in under ninety seconds, so momentum never breaks.',
      'Invite players to show each other what they found, rather than competing for points.',
    ],
    avoid: [
      'Tasting, eating, chewing, or licking anything at all.',
      'Picking, uprooting, breaking, or taking any living plant, flower, or fungus.',
      'Touching or approaching any animal, nest, burrow, hive, or droppings.',
      'Touching mushrooms, berries, sap, thorns, nettles, or any unidentified plant.',
      'Picking up litter, glass, metal, needles, or anything sharp or unknown.',
      'Reaching into holes, hollows, gaps, or anywhere the player cannot see.',
      'Water of any kind: ponds, streams, puddles, fountains, drains.',
      'Climbing, reaching above head height, or leaving the group to search alone.',
      'Interacting with strangers, or entering private gardens or fenced ground.',
    ],
    exampleTwists: [
      'Find two pieces of bark with completely different textures. Do not pick anything, just put a hand on each.',
      'Everyone stop and close your mouth. Name four separate sounds you can hear right now.',
      'Find something you are certain is older than everyone here. Be ready to argue for it.',
      'Look for the smallest living thing you can see without moving your feet.',
      'Find three greens that do not match each other. Point at all three at once.',
    ],
  },
});
