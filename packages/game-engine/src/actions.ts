import { z } from 'zod';
import { err, ok, type Result } from '@touchgrass/shared';
import { type EngineError, engineError } from './errors';

/**
 * Player actions.
 *
 * A PlayerAction is something a player reports: "I tagged Sam", "I found Priya".
 * It states intent and names who was involved. It never says what the result
 * should be — there is no score, role, or status field in any action, so a
 * client cannot use one to write state. The engine validates the claim against
 * the game's rules and decides what, if anything, changes.
 *
 * The engine cannot see the field. It does not verify that a tag physically
 * happened; it verifies that the report is one the rules allow from that player
 * at that moment.
 */

const id = z.string().min(1).max(64);

/** The player is ready for the game or round to begin. */
export const playerReadyActionSchema = z
  .object({
    type: z.literal('PLAYER_READY'),
    playerId: id,
  })
  .strict();

const differentPlayers = (action: { playerId: string; targetPlayerId: string }): boolean =>
  action.playerId !== action.targetPlayerId;

/** `playerId` reports having tagged `targetPlayerId`. */
export const playerTaggedActionSchema = z
  .object({
    type: z.literal('PLAYER_TAGGED'),
    playerId: id,
    targetPlayerId: id,
  })
  .strict()
  .refine(differentPlayers, {
    message: 'a player cannot tag themselves',
    path: ['targetPlayerId'],
  });

/** `playerId` reports having found `targetPlayerId`. */
export const playerFoundActionSchema = z
  .object({
    type: z.literal('PLAYER_FOUND'),
    playerId: id,
    targetPlayerId: id,
  })
  .strict()
  .refine(differentPlayers, {
    message: 'a player cannot find themselves',
    path: ['targetPlayerId'],
  });

/** The player uses a power they hold. */
export const playerActivatedPowerActionSchema = z
  .object({
    type: z.literal('PLAYER_ACTIVATED_POWER'),
    playerId: id,
    powerId: id,
  })
  .strict();

/** The player reports completing a challenge or bonus objective. */
export const playerCompletedChallengeActionSchema = z
  .object({
    type: z.literal('PLAYER_COMPLETED_CHALLENGE'),
    playerId: id,
    /** The id of an active challenge or bonus objective. */
    challengeId: id,
  })
  .strict();

/** The player acknowledges an event that was announced to them. */
export const playerAcceptedEventActionSchema = z
  .object({
    type: z.literal('PLAYER_ACCEPTED_EVENT'),
    playerId: id,
    /** The id of the history entry that recorded the event. */
    eventId: id,
  })
  .strict();

export const playerActionSchema = z.discriminatedUnion('type', [
  playerReadyActionSchema,
  playerTaggedActionSchema,
  playerFoundActionSchema,
  playerActivatedPowerActionSchema,
  playerCompletedChallengeActionSchema,
  playerAcceptedEventActionSchema,
]);

export type PlayerAction = z.infer<typeof playerActionSchema>;
export type PlayerReadyAction = z.infer<typeof playerReadyActionSchema>;
export type PlayerTaggedAction = z.infer<typeof playerTaggedActionSchema>;
export type PlayerFoundAction = z.infer<typeof playerFoundActionSchema>;
export type PlayerActivatedPowerAction = z.infer<typeof playerActivatedPowerActionSchema>;
export type PlayerCompletedChallengeAction = z.infer<typeof playerCompletedChallengeActionSchema>;
export type PlayerAcceptedEventAction = z.infer<typeof playerAcceptedEventActionSchema>;

/**
 * Schema validation for an action from a client. Whether the action is legal in
 * the current game is domain validation, in validate.ts.
 */
export function parsePlayerAction(input: unknown): Result<PlayerAction, EngineError> {
  const parsed = playerActionSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err(
    engineError('INVALID_ACTION', 'The action does not match the player action schema.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }),
  );
}

// --- intents ------------------------------------------------------------------

/**
 * A player intent is what a client is allowed to send: an action with no actor.
 *
 * A PlayerAction names the player who is acting. If a client supplied that
 * field, any client could act as any player by typing a different id. So a
 * client message has no `playerId` at all, and because every schema here is
 * strict, a message that includes one is refused rather than ignored. Whoever
 * holds the connection knows which player it belongs to and passes that id
 * separately; `submitPlayerAction` joins the two.
 *
 * One schema per action kind, with the same payload fields as the action.
 */
export const playerIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PLAYER_READY') }).strict(),
  z.object({ type: z.literal('PLAYER_TAGGED'), targetPlayerId: id }).strict(),
  z.object({ type: z.literal('PLAYER_FOUND'), targetPlayerId: id }).strict(),
  z.object({ type: z.literal('PLAYER_ACTIVATED_POWER'), powerId: id }).strict(),
  z.object({ type: z.literal('PLAYER_COMPLETED_CHALLENGE'), challengeId: id }).strict(),
  z.object({ type: z.literal('PLAYER_ACCEPTED_EVENT'), eventId: id }).strict(),
]);
export type PlayerIntent = z.infer<typeof playerIntentSchema>;

/** Schema validation for a message from a client. */
export function parsePlayerIntent(input: unknown): Result<PlayerIntent, EngineError> {
  const parsed = playerIntentSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err(
    engineError('INVALID_ACTION', 'The message is not a valid player intent.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }),
  );
}
