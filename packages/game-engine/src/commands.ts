import { z } from 'zod';

/**
 * Host commands: the session-level operations that are not gameplay.
 *
 * Creating a session, letting players in and out, pausing and stopping are done
 * through these commands. They are a separate vocabulary from PlayerAction (what
 * a player reports, actions.ts) and GameEvent (a validated gameplay change,
 * events.ts).
 *
 * There is no "start" or "complete" command. A game starts when its players are
 * ready, and completes when its last round ends; neither needs a host.
 */

export const createSessionCommandSchema = z
  .object({
    type: z.literal('CREATE_SESSION'),
    sessionId: z.string().min(1),
    gameId: z.string().min(1),
    joinCode: z.string().min(1),
    randomSeed: z.int(),
  })
  .strict();

export const addPlayerCommandSchema = z
  .object({
    type: z.literal('ADD_PLAYER'),
    playerId: z.string().min(1),
    displayName: z.string().trim().min(1).max(40),
  })
  .strict();

export const removePlayerCommandSchema = z
  .object({
    type: z.literal('REMOVE_PLAYER'),
    playerId: z.string().min(1),
  })
  .strict();

export const advancePhaseCommandSchema = z
  .object({
    type: z.literal('ADVANCE_PHASE'),
  })
  .strict();

export const pauseSessionCommandSchema = z
  .object({
    type: z.literal('PAUSE_SESSION'),
    reason: z.string().trim().min(1).max(160),
  })
  .strict();

export const resumeSessionCommandSchema = z
  .object({
    type: z.literal('RESUME_SESSION'),
  })
  .strict();

export const abortSessionCommandSchema = z
  .object({
    type: z.literal('ABORT_SESSION'),
    reason: z.string().trim().min(1).max(160),
  })
  .strict();

export const engineCommandSchema = z.discriminatedUnion('type', [
  createSessionCommandSchema,
  addPlayerCommandSchema,
  removePlayerCommandSchema,
  advancePhaseCommandSchema,
  pauseSessionCommandSchema,
  resumeSessionCommandSchema,
  abortSessionCommandSchema,
]);

export type EngineCommand = z.infer<typeof engineCommandSchema>;
export type CreateSessionCommand = z.infer<typeof createSessionCommandSchema>;
export type AddPlayerCommand = z.infer<typeof addPlayerCommandSchema>;
export type RemovePlayerCommand = z.infer<typeof removePlayerCommandSchema>;
export type PauseSessionCommand = z.infer<typeof pauseSessionCommandSchema>;
export type AbortSessionCommand = z.infer<typeof abortSessionCommandSchema>;

/** Commands that apply to an existing session (everything except creation). */
export type SessionCommand = Exclude<EngineCommand, CreateSessionCommand>;
