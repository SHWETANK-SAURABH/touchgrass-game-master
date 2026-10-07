import type { GameDefinition } from './schema';
import {
  isLifecycleEventKind,
  isOptionalEventKind,
  type GameEventKind,
  type GameModifierKind,
  type PlayerActionKind,
} from './vocabulary';
import { hideAndSeek } from './games/hide-and-seek';
import { iceAndFire } from './games/ice-and-fire';
import { natureChallenge } from './games/nature-challenge';
import { tag } from './games/tag';
import { treasureHunt } from './games/treasure-hunt';

/**
 * Every bundled game, keyed by id.
 *
 * Each value was already validated by `defineGame` at module load, so anything
 * reachable from here is a parsed `GameDefinition` — the registry never holds a
 * half-checked object.
 */
const DEFINITIONS = [tag, hideAndSeek, iceAndFire, treasureHunt, natureChallenge] as const;

export const GAME_IDS = DEFINITIONS.map((definition) => definition.id);

const BY_ID = new Map<string, GameDefinition>(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

/** Returns every bundled definition, in presentation order. */
export function listGameDefinitions(): readonly GameDefinition[] {
  return DEFINITIONS;
}

/** Returns a definition, or `undefined` for an unknown id. */
export function findGameDefinition(gameId: string): GameDefinition | undefined {
  return BY_ID.get(gameId);
}

/**
 * Returns a definition or throws. Use at trust boundaries that have already
 * validated the id — a miss here is a bug, not bad input.
 */
export function getGameDefinition(gameId: string): GameDefinition {
  const definition = BY_ID.get(gameId);
  if (!definition) {
    throw new Error(`Unknown game id "${gameId}". Known ids: ${GAME_IDS.join(', ')}`);
  }
  return definition;
}

/**
 * True when this game supports that kind of event.
 *
 * Lifecycle events are always supported. Optional events must be listed by the
 * definition. Engine-derived events follow from what the definition already
 * declares: a rule that puts a player out, powers, or objectives.
 */
export function permitsEventKind(definition: GameDefinition, kind: GameEventKind): boolean {
  if (isLifecycleEventKind(kind)) return true;
  if (isOptionalEventKind(kind)) return definition.allowedEventKinds.includes(kind);
  switch (kind) {
    case 'PLAYER_OUT':
      return definition.rules.some((rule) => rule.outcome === 'TARGET_OUT');
    case 'POWER_ACTIVATED':
      return definition.allowedEventKinds.includes('POWER_UP');
    case 'OBJECTIVE_COMPLETED':
      return (
        definition.allowedEventKinds.includes('CHALLENGE') ||
        definition.allowedEventKinds.includes('BONUS_OBJECTIVE')
      );
  }
}

export function permitsModifier(definition: GameDefinition, kind: GameModifierKind): boolean {
  return definition.allowedModifiers.includes(kind);
}

export function permitsActionKind(definition: GameDefinition, kind: PlayerActionKind): boolean {
  return definition.allowedActionKinds.includes(kind);
}

/** The role that soaks up players left over after every other role meets its minimum. */
export function defaultRoleOf(definition: GameDefinition): GameDefinition['roles'][number] {
  const role = definition.roles.find((candidate) => candidate.isDefault);
  if (!role) {
    // Unreachable: the schema enforces exactly one default role.
    throw new Error(`Game "${definition.id}" has no default role`);
  }
  return role;
}

export { tag, hideAndSeek, iceAndFire, treasureHunt, natureChallenge };
