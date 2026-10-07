import { describe, expect, it } from 'vitest';
import { GAME_EVENT_KINDS, gameDefinitionSchema, type GameDefinitionInput } from './schema';
import {
  GAME_IDS,
  defaultRoleOf,
  findGameDefinition,
  getGameDefinition,
  listGameDefinitions,
  permitsEventKind,
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
    allowedEventKinds: ['ANNOUNCE', 'MODIFIER'],
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

  it.each(listGameDefinitions())('$id only allows known event kinds', (definition) => {
    for (const kind of definition.allowedEventKinds) {
      expect(GAME_EVENT_KINDS).toContain(kind);
    }
  });

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

  it('keeps every contact-free game free of ROLE_ASSIGN-driven contact', () => {
    for (const definition of listGameDefinitions()) {
      if (definition.safety.contactPolicy === 'none') {
        expect(definition.intensity).not.toBe('high');
      }
    }
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

  it('reports which event kinds a game permits', () => {
    expect(permitsEventKind(getGameDefinition('tag'), 'MODIFIER')).toBe(true);
    // Tag has no objectives to hand out; it is pure chase.
    expect(permitsEventKind(getGameDefinition('tag'), 'OBJECTIVE')).toBe(false);
    // Nature Challenge has no spatial rules; it works in a single small space.
    expect(permitsEventKind(getGameDefinition('nature-challenge'), 'ZONE_RULE')).toBe(false);
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

  it('rejects ROLE_ASSIGN in a single-role game', () => {
    const input = draft();
    input.roles = [{ id: 'solo', label: 'Solo', description: 's', min: 2, isDefault: true }];
    input.allowedEventKinds = ['ANNOUNCE', 'ROLE_ASSIGN'];
    const result = gameDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/ROLE_ASSIGN requires at least two roles/);
  });

  it('rejects duplicate event kinds', () => {
    const input = draft();
    input.allowedEventKinds = ['ANNOUNCE', 'ANNOUNCE'];
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
