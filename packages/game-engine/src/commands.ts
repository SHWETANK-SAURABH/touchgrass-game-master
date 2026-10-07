import { z } from 'zod';

/**
 * Everything that can change a session.
 *
 * Commands come from humans and from the engine itself. A model proposal is not a
 * command — it becomes one only after schema and safety validation, which is the
 * whole point of keeping the two vocabularies separate. Phase 2 adds the
 * `APPLY_GAME_MASTER_EVENT` command that carries a validated proposal across that
 * line; until then the engine handles only session lifecycle, which is enough to
 * prove determinism and replay.
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

export const startSessionCommandSchema = z
  .object({
    type: z.literal('START_SESSION'),
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

export const completeSessionCommandSchema = z
  .object({
    type: z.literal('COMPLETE_SESSION'),
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
  startSessionCommandSchema,
  advancePhaseCommandSchema,
  pauseSessionCommandSchema,
  resumeSessionCommandSchema,
  completeSessionCommandSchema,
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
