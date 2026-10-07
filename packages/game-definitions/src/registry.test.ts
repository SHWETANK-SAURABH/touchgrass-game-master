import { describe, expect, it } from 'vitest';
import { gameDefinitionSchema, type GameDefinitionInput } from './schema';
import {
  DERIVED_EVENT_KINDS,
  GAME_EVENT_KINDS,
  GAME_MODIFIER_KINDS,
  LIFECYCLE_EVENT_KINDS,
  MODIFIERS_BY_EVENT,
  OPTIONAL_EVENT_KINDS,
  PLAYER_ACTION_KINDS,
} from './vocabulary';
import {
  GAME_IDS,
  defaultRoleOf,
  findGameDefinition,
  getGameDefinition,
  listGameDefinitions,
  permitsActionKind,
  permitsEventKind,
  permitsModifier,
} from './registry';

/**
 * A minimal valid definition, cloned and broken per assertion. Keeping it here
 * rather than in the shipped games means the schema tests cannot be weakened by
 * someone "fixing" a real game to make a test pass.
 */
function draft(): GameDefinitionInput {
  return {
    id: 'test-game',
    name: 'Test Game',
    tagline: 'A fixture.',
    description: 'A fixture used by the schema tests.',
    minPlayers: 3,
    maxPlayers: 10,
    recommendedDurationMinutes: 10,
    spaceRequirement: 'medium',
    intensity: 'moderate',
    equipment: [],
    roles: [
      { id: 'chaser', label: 'Chaser', description: 'Chases.', min: 1, max: 2 },
      { id: 'runner', label: 'Runner', description: 'Runs.', min: 2, isDefault: true },
    ],
    phases: [{ id: 'play', label: 'Play', description: 'Open play.' }],
    allowedEventKinds: ['ZONE_CHANGE', 'ROLE_CHANGE'],
    allowedModifiers: ['SAFE_ZONE', 'ROLE_SWAP'],
    allowedActionKinds: ['PLAYER_READY', 'PLAYER_TAGGED'],
    rules: [
      {
        id: 'chaser-tags-runner',
        description: 'A tagged runner becomes the chaser.',
        action: 'PLAYER_TAGGED',
        actorRoleId: 'chaser',
        targetRoleId: 'runner',
        outcome: 'SWAP_ROLES',
      },
    ],
    powers: [],
    scoring: [{ trigger: 'TAG_MADE', points: 1 }],
    winConditions: [{ type: 'HIGHEST_SCORE' }],
    settings: { totalRounds: 3, roundDurationSeconds: 120 },
    modifierThemes: ['movement'],
    safety: {
      contactPolicy: 'tag-only',
      maxIntensity: 'moderate',
      involvesSeparation: false,
      requiresDaylight: true,
      inherentRisks: ['Players collide.'],
    },
    gameMaster: {
      persona: 'A referee.',
      encourage: ['Change how players move.'],
      avoid: ['Anything near a road.'],
      exampleTwists: ['Hop only.', 'Walk only.'],
    },
  };
}

describe('bundled game definitions', () => {
  it('ships the five games the product promises', () => {
    expect(GAME_IDS).toEqual([
      'tag',
      'hide-and-seek',
      'ice-and-fire',
      'treasure-hunt',
      'nature-challenge',
    ]);
  });

  it('has unique ids', () => {
    expect(new Set(GAME_IDS).size).toBe(GAME_IDS.length);
  });

  it.each(listGameDefinitions())('$id re-validates against the schema', (definition) => {
    expect(gameDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it.each(listGameDefinitions())('$id declares exactly one default role', (definition) => {
    expect(definition.roles.filter((role) => role.isDefault)).toHaveLength(1);
    expect(defaultRoleOf(definition).isDefault).toBe(true);
  });

  it.each(listGameDefinitions())('$id can seat its own role minimums', (definition) => {
    const required = definition.roles.reduce((sum, role) => sum + role.min, 0);
    expect(required).toBeLessThanOrEqual(definition.minPlayers);
  });

  it.each(listGameDefinitions())('$id only allows optional event kinds', (definition) => {
    for (const kind of definition.allowedEventKinds) {
      expect(OPTIONAL_EVENT_KINDS).toContain(kind);
    }
  });

  it.each(listGameDefinitions())(
    '$id allows exactly the modifiers its events introduce',
    (definition) => {
      const introduced = new Set(
        definition.allowedEventKinds.flatMap((kind) => MODIFIERS_BY_EVENT[kind]),
      );
      for (const modifier of definition.allowedModifiers) {
        expect(introduced.has(modifier)).toBe(true);
      }
    },
  );

  it.each(listGameDefinitions())(
    '$id declares settings, scoring and a win condition',
    (definition) => {
      expect(definition.settings.totalRounds).toBeGreaterThanOrEqual(1);
      expect(definition.winConditions.length).toBeGreaterThanOrEqual(1);
      expect(definition.allowedActionKinds).toContain('PLAYER_READY');
    },
  );

  it.each(listGameDefinitions())('$id gives the Game Master a prohibition list', (definition) => {
    // Every game must tell the model what it may never propose. A game with an
    // empty `avoid` list would silently widen what the safety layer has to catch.
    expect(definition.gameMaster.avoid.length).toBeGreaterThan(0);
    expect(definition.gameMaster.exampleTwists.length).toBeGreaterThanOrEqual(2);
  });

  it.each(listGameDefinitions())('$id names at least one inherent risk', (definition) => {
    expect(definition.safety.inherentRisks.length).toBeGreaterThan(0);
  });

  it('marks the two games where players leave each others sight', () => {
    const separated = listGameDefinitions()
      .filter((definition) => definition.safety.involvesSeparation)
      .map((definition) => definition.id);
    expect(separated).toEqual(['hide-and-seek', 'treasure-hunt']);
  });

  it('keeps every contact-free game below high intensity', () => {
    for (const definition of listGameDefinitions()) {
      if (definition.safety.contactPolicy === 'none') {
        expect(definition.intensity).not.toBe('high');
      }
    }
  });

  it('plays Tag with two to four players, one of them the tagger', () => {
    const tag = getGameDefinition('tag');
    expect([tag.minPlayers, tag.maxPlayers]).toEqual([2, 4]);
    expect(tag.roles.find((role) => role.id === 'tagger')).toMatchObject({ min: 1, max: 1 });
    expect(tag.allowedEventKinds).toEqual([
      'ZONE_CHANGE',
      'POWER_UP',
      'BONUS_OBJECTIVE',
      'TIME_EXTENSION',
      'ROLE_CHANGE',
    ]);
    expect(tag.rules).toEqual([
      expect.objectContaining({
        action: 'PLAYER_TAGGED',
        actorRoleId: 'tagger',
        targetRoleId: 'runner',
        outcome: 'SWAP_ROLES',
      }),
    ]);
  });

  it('gives Tag the approved rules, scoring, power and settings', () => {
    const tag = getGameDefinition('tag');
    expect(tag.scoring).toEqual([
      { trigger: 'TAG_MADE', points: 2 },
      { trigger: 'ROUND_SURVIVED', points: 1 },
    ]);
    expect(tag.powers).toEqual([
      expect.objectContaining({ id: 'shield', effect: 'TAG_IMMUNITY', durationSeconds: 20 }),
    ]);
    expect(tag.settings).toEqual({ totalRounds: 3, roundDurationSeconds: 180 });
    expect(tag.winConditions).toEqual([{ type: 'HIGHEST_SCORE' }]);
  });

  it('gives Hide & Seek the approved scoring and settings', () => {
    const game = getGameDefinition('hide-and-seek');
    expect(game.scoring).toEqual([
      { trigger: 'FOUND_PLAYER', points: 2 },
      { trigger: 'STAYED_HIDDEN', points: 3 },
      { trigger: 'ALL_FOUND', points: 2 },
    ]);
    expect(game.settings).toEqual({ totalRounds: 3, roundDurationSeconds: 300 });
    expect(game.winConditions).toEqual([{ type: 'HIGHEST_SCORE' }]);
  });

  it.each(listGameDefinitions())('$id is won by highest score', (definition) => {
    expect(definition.winConditions).toEqual([{ type: 'HIGHEST_SCORE' }]);
  });

  it('plays Hide & Seek with two to four players, one of them the seeker', () => {
    const game = getGameDefinition('hide-and-seek');
    expect([game.minPlayers, game.maxPlayers]).toEqual([2, 4]);
    expect(game.roles.find((role) => role.id === 'seeker')).toMatchObject({ min: 1, max: 1 });
    expect(game.rules).toEqual([
      expect.objectContaining({
        action: 'PLAYER_FOUND',
        actorRoleId: 'seeker',
        targetRoleId: 'hider',
        outcome: 'TARGET_OUT',
      }),
    ]);
    expect(game.allowedActionKinds).not.toContain('PLAYER_TAGGED');
  });
});

describe('registry lookup', () => {
  it('finds a known game', () => {
    expect(getGameDefinition('tag').name).toBe('Tag');
    expect(findGameDefinition('ice-and-fire')?.id).toBe('ice-and-fire');
  });

  it('returns undefined rather than throwing for unknown ids', () => {
    expect(findGameDefinition('quidditch')).toBeUndefined();
  });

  it('throws with a useful message when a required game is missing', () => {
    expect(() => getGameDefinition('quidditch')).toThrow(/Unknown game id "quidditch"/);
    expect(() => getGameDefinition('quidditch')).toThrow(/tag/);
  });

  it('reports which events, modifiers and actions a game permits', () => {
    const tag = getGameDefinition('tag');
    expect(permitsEventKind(tag, 'POWER_UP')).toBe(true);
    expect(permitsEventKind(tag, 'CHALLENGE')).toBe(false);
    // Lifecycle events are never listed and always permitted.
    expect(permitsEventKind(tag, 'ROUND_START')).toBe(true);
    expect(permitsEventKind(getGameDefinition('nature-challenge'), 'ZONE_CHANGE')).toBe(false);

    // Derived events follow from what a definition declares.
    const hideAndSeek = getGameDefinition('hide-and-seek');
    expect(permitsEventKind(hideAndSeek, 'PLAYER_OUT')).toBe(true);
    expect(permitsEventKind(tag, 'PLAYER_OUT')).toBe(false);
    expect(permitsEventKind(tag, 'POWER_ACTIVATED')).toBe(true);
    expect(permitsEventKind(hideAndSeek, 'POWER_ACTIVATED')).toBe(false);
    expect(permitsEventKind(tag, 'OBJECTIVE_COMPLETED')).toBe(true);
    expect(permitsEventKind(getGameDefinition('ice-and-fire'), 'OBJECTIVE_COMPLETED')).toBe(false);

    expect(permitsModifier(tag, 'SAFE_ZONE')).toBe(true);
    expect(permitsModifier(tag, 'FREEZE_PERIOD')).toBe(false);

    expect(permitsActionKind(tag, 'PLAYER_TAGGED')).toBe(true);
    expect(permitsActionKind(tag, 'PLAYER_FOUND')).toBe(false);
  });
});

describe('gameDefinitionSchema invariants', () => {
  it('accepts the fixture', () => {
    expect(gameDefinitionSchema.safeParse(draft()).success).toBe(true);
  });

  it('rejects maxPlayers below minPlayers', () => {
    const result = gameDefinitionSchema.safeParse({ ...draft(), minPlayers: 8, maxPlayers: 4 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/maxPlayers/);
  });

  it('rejects duplicate role ids', () => {
    const input = draft();
    input.roles = [
      { id: 'runner', label: 'A', description: 'a', min: 1 },
      { id: 'runner', label: 'B', description: 'b', min: 2, isDefault: true },
    ];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects zero default roles', () => {
    const input = draft();
    input.roles = [
      { id: 'chaser', label: 'Chaser', description: 'c', min: 1 },
      { id: 'runner', label: 'Runner', description: 'r', min: 2 },
    ];
    const result = gameDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/exactly one role/);
  });

  it('rejects two default roles', () => {
    const input = draft();
    input.roles = [
      { id: 'chaser', label: 'Chaser', description: 'c', min: 1, isDefault: true },
      { id: 'runner', label: 'Runner', description: 'r', min: 2, isDefault: true },
    ];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects roles that need more players than minPlayers provides', () => {
    const input = draft();
    input.minPlayers = 2;
    input.roles = [
      { id: 'chaser', label: 'Chaser', description: 'c', min: 2 },
      { id: 'runner', label: 'Runner', description: 'r', min: 3, isDefault: true },
    ];
    const result = gameDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/roles require at least 5 players/);
  });

  it('rejects a role whose max is below its min', () => {
    const input = draft();
    input.roles = [
      { id: 'chaser', label: 'Chaser', description: 'c', min: 3, max: 1 },
      { id: 'runner', label: 'Runner', description: 'r', min: 0, isDefault: true },
    ];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects ROLE_CHANGE in a single-role game', () => {
    const input = draft();
    input.roles = [{ id: 'solo', label: 'Solo', description: 's', min: 2, isDefault: true }];
    input.allowedEventKinds = ['ROLE_CHANGE'];
    input.allowedModifiers = ['ROLE_SWAP'];
    input.allowedActionKinds = ['PLAYER_READY'];
    input.rules = [];
    const result = gameDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/ROLE_CHANGE requires at least two roles/);
  });

  it('rejects duplicate event kinds', () => {
    const input = draft();
    input.allowedEventKinds = ['ZONE_CHANGE', 'ZONE_CHANGE', 'ROLE_CHANGE'];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an unknown event kind', () => {
    const input = draft();
    // Deliberately bypassing the type to simulate a hand-edited definition file.
    (input as { allowedEventKinds: string[] }).allowedEventKinds = ['SUMMON_RAIN'];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a safety ceiling below the games own intensity', () => {
    const input = draft();
    input.intensity = 'high';
    input.safety.maxIntensity = 'low';
    const result = gameDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/maxIntensity cannot be lower/);
  });

  it('rejects non-kebab-case ids', () => {
    expect(gameDefinitionSchema.safeParse({ ...draft(), id: 'Test Game' }).success).toBe(false);
  });

  it('rejects an empty prohibition list', () => {
    const input = draft();
    input.gameMaster.avoid = [];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });
});

describe('vocabulary', () => {
  it('has the ten event kinds of the brief plus three engine-derived ones', () => {
    expect([...GAME_EVENT_KINDS]).toEqual([
      'ROUND_START',
      'ROUND_END',
      'ZONE_CHANGE',
      'CHALLENGE',
      'POWER_UP',
      'RULE_MODIFIER',
      'BONUS_OBJECTIVE',
      'TIME_EXTENSION',
      'ROLE_CHANGE',
      'GAME_END',
      'PLAYER_OUT',
      'POWER_ACTIVATED',
      'OBJECTIVE_COMPLETED',
    ]);
  });

  it('splits event kinds into lifecycle, optional and derived with nothing left over', () => {
    expect(
      [...LIFECYCLE_EVENT_KINDS, ...OPTIONAL_EVENT_KINDS, ...DERIVED_EVENT_KINDS].sort(),
    ).toEqual([...GAME_EVENT_KINDS].sort());
  });

  it('has the six player actions', () => {
    expect([...PLAYER_ACTION_KINDS]).toEqual([
      'PLAYER_READY',
      'PLAYER_TAGGED',
      'PLAYER_FOUND',
      'PLAYER_ACTIVATED_POWER',
      'PLAYER_COMPLETED_CHALLENGE',
      'PLAYER_ACCEPTED_EVENT',
    ]);
  });

  it('introduces every modifier through exactly one event', () => {
    for (const modifier of GAME_MODIFIER_KINDS) {
      const sources = OPTIONAL_EVENT_KINDS.filter((kind) =>
        MODIFIERS_BY_EVENT[kind].includes(modifier),
      );
      expect(sources).toHaveLength(1);
    }
  });
});

describe('engine-facing definition invariants', () => {
  const issuesOf = (input: GameDefinitionInput): string =>
    JSON.stringify(gameDefinitionSchema.safeParse(input).error?.issues ?? []);

  it('rejects a lifecycle event listed as optional', () => {
    const input = draft();
    (input as { allowedEventKinds: string[] }).allowedEventKinds = ['ROUND_START'];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an event whose modifiers are all disallowed', () => {
    const input = draft();
    input.allowedModifiers = ['ROLE_SWAP'];
    expect(issuesOf(input)).toMatch(/ZONE_CHANGE is allowed but none of its modifiers/);
  });

  it('rejects a modifier that no allowed event introduces', () => {
    const input = draft();
    input.allowedModifiers = ['SAFE_ZONE', 'ROLE_SWAP', 'FREEZE_PERIOD'];
    expect(issuesOf(input)).toMatch(/FREEZE_PERIOD is allowed but no allowed event introduces it/);
  });

  it('rejects POWER_UP without any declared power', () => {
    const input = draft();
    input.allowedEventKinds = ['ZONE_CHANGE', 'ROLE_CHANGE', 'POWER_UP'];
    input.allowedModifiers = ['SAFE_ZONE', 'ROLE_SWAP', 'TEMPORARY_POWER_UP'];
    input.allowedActionKinds = ['PLAYER_READY', 'PLAYER_TAGGED', 'PLAYER_ACTIVATED_POWER'];
    expect(issuesOf(input)).toMatch(/powers must be declared if and only if POWER_UP is allowed/);
  });

  it('rejects powers in a game that does not allow POWER_UP', () => {
    const input = draft();
    input.powers = [
      {
        id: 'shield',
        label: 'Shield',
        description: 'd',
        effect: 'TAG_IMMUNITY',
        durationSeconds: 20,
      },
    ];
    expect(issuesOf(input)).toMatch(/powers must be declared if and only if POWER_UP is allowed/);
  });

  it('rejects POWER_UP when players cannot activate a power', () => {
    const input = draft();
    input.allowedEventKinds = ['ZONE_CHANGE', 'ROLE_CHANGE', 'POWER_UP'];
    input.allowedModifiers = ['SAFE_ZONE', 'ROLE_SWAP', 'TEMPORARY_POWER_UP'];
    input.powers = [
      {
        id: 'shield',
        label: 'Shield',
        description: 'd',
        effect: 'TAG_IMMUNITY',
        durationSeconds: 20,
      },
    ];
    expect(issuesOf(input)).toMatch(/POWER_UP requires the PLAYER_ACTIVATED_POWER action/);
  });

  it('rejects an objective nobody can report as completed', () => {
    const input = draft();
    input.allowedEventKinds = ['ZONE_CHANGE', 'ROLE_CHANGE', 'BONUS_OBJECTIVE'];
    input.allowedModifiers = ['SAFE_ZONE', 'ROLE_SWAP', 'BONUS_OBJECTIVE'];
    expect(issuesOf(input)).toMatch(/require the PLAYER_COMPLETED_CHALLENGE action/);
  });

  it('rejects a rule that names an unknown role', () => {
    const input = draft();
    input.rules[0]!.targetRoleId = 'ghost';
    expect(issuesOf(input)).toMatch(/names unknown role \\"ghost\\"/);
  });

  it('rejects a rule for an action the game does not allow', () => {
    const input = draft();
    input.rules[0]!.action = 'PLAYER_FOUND';
    expect(issuesOf(input)).toMatch(/PLAYER_FOUND, which is not an allowed action/);
  });

  it('rejects a reportable action that no rule gives an outcome', () => {
    const input = draft();
    input.rules = [];
    expect(issuesOf(input)).toMatch(/PLAYER_TAGGED is allowed but no rule says what it does/);
  });

  it('rejects a scoring trigger listed twice', () => {
    const input = draft();
    input.scoring = [
      { trigger: 'TAG_MADE', points: 1 },
      { trigger: 'TAG_MADE', points: 5 },
    ];
    expect(issuesOf(input)).toMatch(/each scoring trigger may appear once/);
  });

  it('rejects non-positive or fractional points', () => {
    for (const points of [0, -1, 1.5]) {
      const input = draft();
      input.scoring = [{ trigger: 'TAG_MADE', points }];
      expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
    }
  });

  it('requires at least one win condition and rejects repeats', () => {
    const none = draft();
    none.winConditions = [];
    expect(gameDefinitionSchema.safeParse(none).success).toBe(false);

    const twice = draft();
    twice.winConditions = [{ type: 'HIGHEST_SCORE' }, { type: 'HIGHEST_SCORE' }];
    expect(issuesOf(twice)).toMatch(/each win condition may appear once/);
  });

  it('rejects an unknown win condition', () => {
    const input = draft();
    (input as { winConditions: { type: string }[] }).winConditions = [{ type: 'ASK_THE_MODEL' }];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it('bounds the settings', () => {
    for (const settings of [
      { totalRounds: 0, roundDurationSeconds: 120 },
      { totalRounds: 11, roundDurationSeconds: 120 },
      { totalRounds: 3, roundDurationSeconds: 5 },
      { totalRounds: 3, roundDurationSeconds: 99_999 },
    ]) {
      expect(gameDefinitionSchema.safeParse({ ...draft(), settings }).success).toBe(false);
    }
  });

  it('accepts a solo game', () => {
    const input = draft();
    input.minPlayers = 1;
    input.maxPlayers = 1;
    input.roles = [
      { id: 'explorer', label: 'Explorer', description: 'e', min: 1, isDefault: true },
    ];
    input.allowedEventKinds = ['CHALLENGE'];
    input.allowedModifiers = [];
    input.allowedActionKinds = ['PLAYER_READY', 'PLAYER_COMPLETED_CHALLENGE'];
    input.rules = [];
    input.scoring = [];
    expect(gameDefinitionSchema.safeParse(input).success).toBe(true);
  });
});
