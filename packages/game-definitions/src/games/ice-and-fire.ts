import { defineGame } from '../schema';

export const iceAndFire = defineGame({
  id: 'ice-and-fire',
  name: 'Ice & Fire',
  tagline: 'Ice freezes you where you stand. Fire sets you free. Nobody wins alone.',
  description:
    'A two-force variant of freeze tag. The Ice player freezes anyone they touch; a frozen player stands still with arms out. The Fire player can thaw a frozen player by touching them. Runners survive by staying mobile and by shepherding Fire toward their frozen teammates. It is the most cooperative game in the set, which makes it the best showcase for a Game Master that tunes difficulty live: it can slow Ice down when the field is mostly frozen, or strip Fire of a hand when the runners are coasting.',
  minPlayers: 4,
  maxPlayers: 16,
  recommendedDurationMinutes: 15,
  spaceRequirement: 'medium',
  intensity: 'high',
  equipment: [],
  roles: [
    {
      id: 'ice',
      label: 'Ice',
      description: 'Freezes runners with an open-handed touch. Cannot freeze Fire.',
      min: 1,
      max: 3,
    },
    {
      id: 'fire',
      label: 'Fire',
      description: 'Thaws frozen players with an open-handed touch. Cannot be frozen.',
      min: 1,
      max: 2,
    },
    {
      id: 'runner',
      label: 'Runner',
      description: 'Stays unfrozen, and steers Fire toward teammates who are stuck.',
      min: 2,
      isDefault: true,
    },
  ],
  phases: [
    {
      id: 'briefing',
      label: 'Briefing',
      description:
        'Roles are announced, the boundary is walked, and the frozen pose is demonstrated so it is unmistakable from a distance.',
      typicalDurationSeconds: 120,
    },
    {
      id: 'open-play',
      label: 'Open Play',
      description:
        'The main round. The Game Master watches the frozen count and rebalances the two forces.',
      typicalDurationSeconds: 600,
    },
    {
      id: 'sudden-thaw',
      label: 'Sudden Thaw',
      description:
        'Endgame. Everyone thaws at once and the round resolves on who is standing free at the whistle.',
      typicalDurationSeconds: 120,
    },
  ],
  allowedEventKinds: ['ANNOUNCE', 'MODIFIER', 'ZONE_RULE', 'TIMER', 'SCORE_ADJUST', 'ROLE_ASSIGN'],
  modifierThemes: [
    'thaw economics',
    'movement constraints',
    'temperature metaphors',
    'temporary immunity',
    'force rebalancing',
  ],
  safety: {
    contactPolicy: 'tag-only',
    maxIntensity: 'high',
    involvesSeparation: false,
    requiresDaylight: true,
    inherentRisks: [
      'Frozen players are stationary obstacles that sprinting players run into.',
      'Holding a frozen pose for a long time is uncomfortable and leaves players cold.',
      'Three roles chasing in the same space means more converging paths and more collisions.',
      'The urge to reach a teammate makes players sprint without looking.',
    ],
  },
  gameMaster: {
    persona:
      'An elemental referee that speaks in temperature. Clipped, almost ceremonial lines. Always states exactly who a rule applies to, because three roles means ambiguity gets people hurt.',
    encourage: [
      'Rebalance the forces when one side is dominating, and say why out loud.',
      'Change the cost of a thaw: two Fire touches, or a thawed player must count to three before running.',
      'Cap how long anyone stays frozen, so nobody is standing still and cold for minutes.',
      'Grant brief immunity windows to keep the field moving.',
    ],
    avoid: [
      'Anything involving actual fire, heat, matches, lighters, or burning.',
      'Anything involving actual ice, cold water, or getting wet.',
      'Freezing a player for longer than about forty seconds at a time.',
      'Holding, grabbing, lifting, or carrying a frozen player.',
      'Blindfolds or closed eyes, in a game with three groups all moving at speed.',
      'Any pose that puts weight on one leg, on the knees, or on the ground.',
    ],
    exampleTwists: [
      'Ice is cooling. For the next ninety seconds Ice may only move at walking pace.',
      'Thaws now cost two touches from Fire. Call them out loud as you make them.',
      'Nobody stays frozen past a count of twenty. Count it yourself and rejoin the game.',
      'Runners who shout a frozen teammates name earn that teammate an instant thaw, once each.',
    ],
  },
});
