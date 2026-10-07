import { defineGame } from '../schema';

export const treasureHunt = defineGame({
  id: 'treasure-hunt',
  name: 'Treasure Hunt',
  tagline: 'Riddles written for the park you are actually standing in.',
  description:
    'Teams race to solve a chain of riddles, each pointing at something physically present in the play area. The reason this game needs a generative model rather than a fixed list is that the riddles have to describe *this* park: the bench with the missing slat, the tree with the split trunk, the third lamp post from the gate. A pre-written hunt is stale on the second play; a generated one is new every time and can be seeded from landmarks the players themselves describe at the start.',
  minPlayers: 2,
  maxPlayers: 24,
  recommendedDurationMinutes: 30,
  spaceRequirement: 'large',
  intensity: 'low',
  equipment: ['one phone per team'],
  roles: [
    {
      id: 'hunter',
      label: 'Hunter',
      description: 'Solves riddles and finds the landmark they describe. Moves with their team.',
      min: 2,
      isDefault: true,
    },
    {
      id: 'navigator',
      label: 'Navigator',
      description:
        'Holds the phone, reads riddles aloud, and confirms finds. Keeps eyes up for the team.',
      min: 0,
      max: 4,
    },
  ],
  phases: [
    {
      id: 'landmark-survey',
      label: 'Landmark Survey',
      description:
        'Before any riddle is generated, players walk the area and name five to ten fixed landmarks. These become the only legal riddle answers, which is what keeps the hunt inside a space the players have actually seen.',
      typicalDurationSeconds: 300,
    },
    {
      id: 'hunt',
      label: 'Hunt',
      description: 'Riddles are issued one at a time per team. The Game Master escalates hints.',
      typicalDurationSeconds: 1200,
    },
    {
      id: 'final-cache',
      label: 'Final Cache',
      description: 'All teams receive the same last riddle. First to the landmark wins the round.',
      typicalDurationSeconds: 300,
    },
  ],
  allowedEventKinds: ['ANNOUNCE', 'OBJECTIVE', 'MODIFIER', 'ZONE_RULE', 'TIMER', 'SCORE_ADJUST'],
  modifierThemes: [
    'riddle difficulty',
    'escalating hints',
    'observation challenges',
    'team routing',
    'bonus objectives',
  ],
  safety: {
    contactPolicy: 'none',
    maxIntensity: 'low',
    involvesSeparation: true,
    requiresDaylight: true,
    inherentRisks: [
      'Teams read a screen while walking and stop watching where they are going.',
      'A riddle can be solved correctly and still point somewhere unsafe to reach.',
      'Teams spread far apart and out of contact with the group while searching.',
      'The competitive clock encourages running and shortcuts across unknown ground.',
      'Reaching a landmark may tempt players over a fence or into private ground.',
    ],
  },
  gameMaster: {
    persona:
      'A wry riddle-keeper. Writes four lines at most, in plain words, with one concrete physical detail per riddle. Never rhymes at the cost of clarity, because an ambiguous riddle sends players somewhere nobody intended.',
    encourage: [
      'Build every riddle from a landmark the players named themselves during the survey.',
      'Escalate hints on a timer so no team is ever stuck and standing still.',
      'Reward observation over distance: counting, reading, noticing colour and texture.',
      'Add bonus objectives that work anywhere, like finding three different leaf shapes.',
    ],
    avoid: [
      'Any answer that requires crossing a road, car park, cycle path, or tram line.',
      'Any answer reached by climbing, reaching up high, or getting down a slope or bank.',
      'Any answer in, over, or beside water: ponds, streams, fountains, drains, riverbanks.',
      'Any answer on private property, inside a building, or past a fence, gate, or sign.',
      'Any answer that involves digging, moving heavy objects, or reaching into a hole.',
      'Picking up litter, glass, needles, or anything sharp, and touching anything unknown.',
      'Asking players to interact with, follow, or ask directions from strangers.',
      'Any landmark that was not in the survey list.',
    ],
    exampleTwists: [
      'Your next landmark has four legs but never walks, and it has been sat on more than it has been noticed. Find it.',
      'Hint unlocked: it is within sight of where you solved the last one.',
      'Bonus objective, worth five points to the first team only: find three leaves with three different shapes and hold them up together.',
      'All teams freeze. Your next riddle is the same one. Read it now.',
    ],
  },
});
