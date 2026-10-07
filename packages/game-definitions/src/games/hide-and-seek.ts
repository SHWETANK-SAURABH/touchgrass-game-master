import { defineGame } from '../schema';

export const hideAndSeek = defineGame({
  id: 'hide-and-seek',
  name: 'Hide & Seek',
  tagline: 'Seekers count down while hiders vanish — and the Game Master keeps narrowing the map.',
  description:
    'Seekers close their eyes and count; everyone else hides inside an agreed area. The classic failure mode is a stalemate: one hider finds a perfect spot and the game stops. The Game Master fixes that by shrinking the playable area over time, forcing hiders to relocate, and issuing hot-or-cold hints that keep the seekers moving. It is the game where the screen is genuinely refereeing something the players cannot referee themselves.',
  minPlayers: 3,
  maxPlayers: 12,
  recommendedDurationMinutes: 20,
  spaceRequirement: 'large',
  intensity: 'moderate',
  equipment: [],
  roles: [
    {
      id: 'seeker',
      label: 'Seeker',
      description: 'Counts down, then searches. Must call out a found hider by name.',
      min: 1,
      max: 3,
    },
    {
      id: 'hider',
      label: 'Hider',
      description: 'Hides within the agreed area and relocates when the Game Master says so.',
      min: 2,
      isDefault: true,
    },
  ],
  phases: [
    {
      id: 'boundary-setting',
      label: 'Boundary Setting',
      description:
        'Players walk the perimeter together and name the four edges aloud before anyone hides. This is the single most important safety step in the game.',
      typicalDurationSeconds: 180,
    },
    {
      id: 'countdown',
      label: 'Countdown',
      description: 'Seekers count aloud with eyes closed while hiders disperse.',
      typicalDurationSeconds: 60,
    },
    {
      id: 'search',
      label: 'Search',
      description:
        'Open play. The Game Master shrinks the area, triggers relocations, and gives hints.',
      typicalDurationSeconds: 720,
    },
    {
      id: 'last-one-standing',
      label: 'Last One Standing',
      description: 'A single hider remains. The area shrinks to its smallest and hints go public.',
      typicalDurationSeconds: 180,
    },
  ],
  allowedEventKinds: [
    'ANNOUNCE',
    'OBJECTIVE',
    'MODIFIER',
    'ZONE_RULE',
    'TIMER',
    'SCORE_ADJUST',
    'ROLE_ASSIGN',
  ],
  modifierThemes: [
    'shrinking boundaries',
    'forced relocation',
    'hot and cold hints',
    'sound signals',
    'visibility rules',
  ],
  safety: {
    contactPolicy: 'none',
    maxIntensity: 'moderate',
    involvesSeparation: true,
    requiresDaylight: true,
    inherentRisks: [
      'Hiders deliberately move out of sight, so nobody can see if one is in trouble.',
      'The best hiding places are the dangerous ones: undergrowth, drainage ditches, sheds, vehicles.',
      'A hider who strays outside the agreed area may be missed entirely at the end of the round.',
      'Enclosed hiding spots can trap a player or cut off their air.',
      'Players hiding alone may be approached by strangers out of the groups sight.',
    ],
  },
  gameMaster: {
    persona:
      'A calm, slightly ominous narrator. Speaks in short, deliberate lines, like a lighthouse keeper counting down. Builds tension by naming how much space is left, never by implying danger is nearby.',
    encourage: [
      'Shrink the playable area in named, visible steps so hiders know exactly where the new edge is.',
      'Force relocations on a timer, so no hiding place is permanently safe.',
      'Give the seekers hot-or-cold information instead of exact positions.',
      'Require hiders to confirm they are still inside the boundary with a sound or a wave.',
    ],
    avoid: [
      'Suggesting any hiding place that is enclosed, lockable, underground, or inside a vehicle.',
      'Suggesting hiding in water, ditches, drains, culverts, or dense thorny undergrowth.',
      'Sending a hider anywhere that requires crossing a road or leaving the named area.',
      'Suggesting anyone hide on private property, in a building, or behind a fence.',
      'Encouraging players to split from the group entirely or to go somewhere out of earshot.',
      'Climbing a tree, wall, or structure to hide.',
    ],
    exampleTwists: [
      'The playable area is now everything between the bench and the gate. Anyone outside that line has sixty seconds to move inside it.',
      'Every hider must change hiding place before the count of twenty. Go now.',
      'The seeker is getting warmer. Hiders within thirty paces of the seeker must hum once.',
      'For the next two minutes, hiders may only hide in places where they can still see open sky.',
    ],
  },
});
