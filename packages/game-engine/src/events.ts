import { z } from 'zod';
import type { OptionalEventKind } from '@touchgrass/game-definitions';
import { err, ok, type Result } from '@touchgrass/shared';
import { type EngineError, engineError } from './errors';

/**
 * Game events.
 *
 * A GameEvent is a validated, fully specified change to a game. It carries every
 * value the reducer needs, so applying one never requires asking a model, a
 * clock, or a random source what was meant: the same state and the same event
 * always give the same next state.
 *
 * Events are the only things that describe gameplay changes. A player action is
 * a request that may lead to events; a model's suggestion is a candidate event
 * that must pass the same validation. Neither is applied as it arrives.
 *
 * Every schema is strict and bounded, because events can originate from
 * untrusted sources:
 *
 *  - no free-form data bag; each kind has named, typed fields
 *  - places are text the players can resolve themselves, never coordinates
 *  - durations, points and counts have hard limits
 *  - an unexpected key is a rejection
 */

export const EVENT_LIMITS = {
  /** Longest a zone, challenge, objective or freeze may last. */
  maxDurationSeconds: 600,
  /** Longest a single round may be scheduled for. */
  maxRoundDurationSeconds: 3600,
  /** Most points one challenge or objective may award. */
  maxPoints: 10,
  /** Most seconds one TIME_EXTENSION may add. */
  maxExtensionSeconds: 300,
  /** Most players one ROLE_CHANGE may move. */
  maxRoleAssignments: 4,
  /** Highest round number. */
  maxRounds: 10,
} as const;

const id = z.string().min(1).max(64);
/** Text shown to players or read aloud; short enough to shout once. */
const spokenText = z.string().trim().min(3).max(240);
const durationSeconds = z.int().min(5).max(EVENT_LIMITS.maxDurationSeconds);
const points = z.int().min(1).max(EVENT_LIMITS.maxPoints);
const round = z.int().min(1).max(EVENT_LIMITS.maxRounds);

export const roundStartEventSchema = z
  .object({
    type: z.literal('ROUND_START'),
    round,
    durationSeconds: z.int().min(30).max(EVENT_LIMITS.maxRoundDurationSeconds),
  })
  .strict();

export const roundEndEventSchema = z
  .object({
    type: z.literal('ROUND_END'),
    round,
  })
  .strict();

export const zoneChangeEventSchema = z
  .object({
    type: z.literal('ZONE_CHANGE'),
    /** Which kind of zone is announced. The engine records it and enforces nothing. */
    modifier: z.enum(['SAFE_ZONE', 'MOVING_ZONE']),
    /** A place described in words, e.g. "the bench by the gate". */
    zone: spokenText,
    durationSeconds,
  })
  .strict();

export const challengeEventSchema = z
  .object({
    type: z.literal('CHALLENGE'),
    challengeId: id,
    description: spokenText,
    /** The players the challenge is issued to. */
    playerIds: z.array(id).min(1).max(4),
    points,
    durationSeconds,
  })
  .strict();

export const powerUpEventSchema = z
  .object({
    type: z.literal('POWER_UP'),
    /** The player who receives the power. */
    playerId: id,
    /** A power the game definition declares. */
    powerId: id,
  })
  .strict();

export const ruleModifierEventSchema = z
  .object({
    type: z.literal('RULE_MODIFIER'),
    modifier: z.literal('FREEZE_PERIOD'),
    /** Roles the freeze is announced for. The engine records it and blocks no action. */
    roleIds: z.array(id).min(1).max(8),
    durationSeconds,
  })
  .strict();

export const bonusObjectiveEventSchema = z
  .object({
    type: z.literal('BONUS_OBJECTIVE'),
    objectiveId: id,
    /** Open to every player, unlike a CHALLENGE. */
    description: spokenText,
    points,
    durationSeconds,
  })
  .strict();

export const timeExtensionEventSchema = z
  .object({
    type: z.literal('TIME_EXTENSION'),
    seconds: z.int().min(5).max(EVENT_LIMITS.maxExtensionSeconds),
  })
  .strict();

export const roleChangeEventSchema = z
  .object({
    type: z.literal('ROLE_CHANGE'),
    assignments: z
      .array(z.object({ playerId: id, roleId: id }).strict())
      .min(1)
      .max(EVENT_LIMITS.maxRoleAssignments),
    /**
     * Set by the engine when the change is the outcome of a player action, so
     * scoring can tell a tag from an ordinary role change. Never accepted from
     * outside the engine.
     */
    cause: z
      .object({
        reason: z.enum(['TAGGED', 'FOUND']),
        byPlayerId: id,
        targetPlayerId: id,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (event) =>
      new Set(event.assignments.map((entry) => entry.playerId)).size === event.assignments.length,
    { message: 'a player may appear once in a ROLE_CHANGE', path: ['assignments'] },
  );

export const gameEndEventSchema = z
  .object({
    type: z.literal('GAME_END'),
    reason: z.literal('ROUNDS_COMPLETE'),
  })
  .strict();

// --- engine-derived events ----------------------------------------------------
// Produced only by the engine, from a validated player action.

/** A player is out for the rest of the round. */
export const playerOutEventSchema = z
  .object({
    type: z.literal('PLAYER_OUT'),
    playerId: id,
    /** The player whose action caused it. */
    byPlayerId: id,
    reason: z.enum(['TAGGED', 'FOUND']),
  })
  .strict();

/** A player activated a power they held. Distinct from POWER_UP, which grants one. */
export const powerActivatedEventSchema = z
  .object({
    type: z.literal('POWER_ACTIVATED'),
    playerId: id,
    powerId: id,
    /** Copied from the game definition so the event is complete on its own. */
    durationSeconds,
  })
  .strict();

/** A player completed an active challenge or bonus objective. */
export const objectiveCompletedEventSchema = z
  .object({
    type: z.literal('OBJECTIVE_COMPLETED'),
    playerId: id,
    objectiveId: id,
    /** The objective's points, copied so the event is complete on its own. */
    points,
  })
  .strict();

/**
 * The complete event vocabulary. A discriminated union gives per-branch error
 * messages ("durationSeconds: too big") instead of "invalid union".
 */
export const gameEventSchema = z.discriminatedUnion('type', [
  roundStartEventSchema,
  roundEndEventSchema,
  zoneChangeEventSchema,
  challengeEventSchema,
  powerUpEventSchema,
  ruleModifierEventSchema,
  bonusObjectiveEventSchema,
  timeExtensionEventSchema,
  roleChangeEventSchema,
  gameEndEventSchema,
  playerOutEventSchema,
  powerActivatedEventSchema,
  objectiveCompletedEventSchema,
]);

export type GameEvent = z.infer<typeof gameEventSchema>;
export type RoundStartEvent = z.infer<typeof roundStartEventSchema>;
export type RoundEndEvent = z.infer<typeof roundEndEventSchema>;
export type ZoneChangeEvent = z.infer<typeof zoneChangeEventSchema>;
export type ChallengeEvent = z.infer<typeof challengeEventSchema>;
export type PowerUpEvent = z.infer<typeof powerUpEventSchema>;
export type RuleModifierEvent = z.infer<typeof ruleModifierEventSchema>;
export type BonusObjectiveEvent = z.infer<typeof bonusObjectiveEventSchema>;
export type TimeExtensionEvent = z.infer<typeof timeExtensionEventSchema>;
export type RoleChangeEvent = z.infer<typeof roleChangeEventSchema>;
export type GameEndEvent = z.infer<typeof gameEndEventSchema>;
export type PlayerOutEvent = z.infer<typeof playerOutEventSchema>;
export type PowerActivatedEvent = z.infer<typeof powerActivatedEventSchema>;
export type ObjectiveCompletedEvent = z.infer<typeof objectiveCompletedEventSchema>;

// --- external events ----------------------------------------------------------

/**
 * ROLE_CHANGE as an outside source may send it: without a `cause`. Only the
 * engine may say that a role change was the result of a tag.
 */
export const externalRoleChangeEventSchema = z
  .object({
    type: z.literal('ROLE_CHANGE'),
    assignments: z
      .array(z.object({ playerId: id, roleId: id }).strict())
      .min(1)
      .max(EVENT_LIMITS.maxRoleAssignments),
  })
  .strict()
  .refine(
    (event) =>
      new Set(event.assignments.map((entry) => entry.playerId)).size === event.assignments.length,
    { message: 'a player may appear once in a ROLE_CHANGE', path: ['assignments'] },
  );

/**
 * The schema for each event kind that may come from outside the engine — a host
 * today, the Game Master's proposals in Phase 3. Lifecycle events and the events
 * derived from player actions have no entry, so they cannot be expressed here.
 * This is the same boundary `submitGameEvent` enforces.
 */
export const EXTERNAL_EVENT_SCHEMAS = {
  ZONE_CHANGE: zoneChangeEventSchema,
  CHALLENGE: challengeEventSchema,
  POWER_UP: powerUpEventSchema,
  RULE_MODIFIER: ruleModifierEventSchema,
  BONUS_OBJECTIVE: bonusObjectiveEventSchema,
  TIME_EXTENSION: timeExtensionEventSchema,
  ROLE_CHANGE: externalRoleChangeEventSchema,
} as const satisfies Record<OptionalEventKind, z.ZodType>;

export const externalGameEventSchema = z.discriminatedUnion('type', [
  zoneChangeEventSchema,
  challengeEventSchema,
  powerUpEventSchema,
  ruleModifierEventSchema,
  bonusObjectiveEventSchema,
  timeExtensionEventSchema,
  externalRoleChangeEventSchema,
]);
export type ExternalGameEvent = z.infer<typeof externalGameEventSchema>;

/**
 * Schema validation for an event from any source. This only answers "is it the
 * right shape"; whether it is legal for a particular game in its current state
 * is domain validation, in validate.ts.
 */
export function parseGameEvent(input: unknown): Result<GameEvent, EngineError> {
  const parsed = gameEventSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err(
    engineError('INVALID_EVENT', 'The event does not match the game event schema.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }),
  );
}
