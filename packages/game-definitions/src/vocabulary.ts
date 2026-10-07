import { z } from 'zod';

/**
 * The closed vocabularies shared by game definitions and the engine.
 *
 * They live here, rather than in the engine, because a definition has to name
 * them (which events a game supports, which actions its players may report) and
 * the engine depends on definitions, not the other way round.
 */

/**
 * Every kind of game event the engine can apply. An unknown kind is a validation
 * failure; nothing outside this list can change a game.
 */
export const GAME_EVENT_KINDS = [
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
] as const;
export const gameEventKindSchema = z.enum(GAME_EVENT_KINDS);
export type GameEventKind = z.infer<typeof gameEventKindSchema>;

/** Events that drive the lifecycle. Every game supports them; a definition cannot opt out. */
export const LIFECYCLE_EVENT_KINDS = ['ROUND_START', 'ROUND_END', 'GAME_END'] as const;
export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number];

/** Events a definition must opt in to. Anything not listed by a game is rejected for it. */
export const OPTIONAL_EVENT_KINDS = [
  'ZONE_CHANGE',
  'CHALLENGE',
  'POWER_UP',
  'RULE_MODIFIER',
  'BONUS_OBJECTIVE',
  'TIME_EXTENSION',
  'ROLE_CHANGE',
] as const;
export const optionalEventKindSchema = z.enum(OPTIONAL_EVENT_KINDS);
export type OptionalEventKind = z.infer<typeof optionalEventKindSchema>;

/**
 * Events only the engine produces, as the result of a validated player action.
 * They exist because the ten kinds above cannot state these facts: a player is
 * out, a held power was activated, an objective was completed. They are never
 * accepted from outside the engine.
 */
export const DERIVED_EVENT_KINDS = [
  'PLAYER_OUT',
  'POWER_ACTIVATED',
  'OBJECTIVE_COMPLETED',
] as const;
export type DerivedEventKind = (typeof DERIVED_EVENT_KINDS)[number];

export function isDerivedEventKind(kind: GameEventKind): kind is DerivedEventKind {
  return (DERIVED_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isOptionalEventKind(kind: GameEventKind): kind is OptionalEventKind {
  return (OPTIONAL_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isLifecycleEventKind(kind: GameEventKind): kind is LifecycleEventKind {
  return (LIFECYCLE_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The modifiers a game can allow. Each has engine-defined behaviour; none is free text. */
export const GAME_MODIFIER_KINDS = [
  /** A named place where the game's contact rule does not apply. */
  'SAFE_ZONE',
  /** A named playable area that replaces the previous one. */
  'MOVING_ZONE',
  /** An extra objective open to every player. */
  'BONUS_OBJECTIVE',
  /** A power a player holds and can activate for a fixed time. */
  'TEMPORARY_POWER_UP',
  /** Extra seconds added to the running round. */
  'TIME_EXTENSION',
  /** Players moved between the roles the definition declares. */
  'ROLE_SWAP',
  /** A period in which the named roles may not act. */
  'FREEZE_PERIOD',
] as const;
export const gameModifierKindSchema = z.enum(GAME_MODIFIER_KINDS);
export type GameModifierKind = z.infer<typeof gameModifierKindSchema>;

/**
 * Which modifiers each optional event introduces. A definition that allows an
 * event must allow at least one of its modifiers, and may not allow a modifier
 * whose event it does not allow. CHALLENGE introduces no modifier.
 */
export const MODIFIERS_BY_EVENT: Readonly<Record<OptionalEventKind, readonly GameModifierKind[]>> =
  {
    ZONE_CHANGE: ['SAFE_ZONE', 'MOVING_ZONE'],
    CHALLENGE: [],
    POWER_UP: ['TEMPORARY_POWER_UP'],
    RULE_MODIFIER: ['FREEZE_PERIOD'],
    BONUS_OBJECTIVE: ['BONUS_OBJECTIVE'],
    TIME_EXTENSION: ['TIME_EXTENSION'],
    ROLE_CHANGE: ['ROLE_SWAP'],
  };

/** What a player can report. An action is a request; the engine decides what it means. */
export const PLAYER_ACTION_KINDS = [
  'PLAYER_READY',
  'PLAYER_TAGGED',
  'PLAYER_FOUND',
  'PLAYER_ACTIVATED_POWER',
  'PLAYER_COMPLETED_CHALLENGE',
  'PLAYER_ACCEPTED_EVENT',
] as const;
export const playerActionKindSchema = z.enum(PLAYER_ACTION_KINDS);
export type PlayerActionKind = z.infer<typeof playerActionKindSchema>;
