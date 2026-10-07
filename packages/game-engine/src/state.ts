import { z } from 'zod';
import { gameEventKindSchema } from '@touchgrass/game-definitions';

/**
 * The canonical shape of a live session.
 *
 * Two properties matter more than anything else here:
 *
 *  1. It is plain data. No class instances, no methods, no hidden state. A
 *     session can be serialised, stored, shipped over a socket, and replayed.
 *  2. It is append-only where it counts. `log` records every applied command in
 *     order, so the engine can prove how the session arrived at its current
 *     state — including which entries came from the model and which did not.
 */

export const sessionStatusSchema = z.enum([
  /** Created, players joining, roles not yet assigned. */
  'lobby',
  /** Running. The Game Master may propose events. */
  'active',
  /** Temporarily halted by a human. No events are applied. */
  'paused',
  /** Finished normally. */
  'completed',
  /** Stopped early — by a human, or by the engine refusing to continue. */
  'aborted',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const playerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(40),
  /** Null until the engine assigns roles at START. */
  roleId: z.string().min(1).nullable(),
  score: z.int(),
  joinedAt: z.int(),
  /**
   * A player who has stepped out but whose record stays in the session, so the
   * log remains interpretable and their score is not silently erased.
   */
  active: z.boolean(),
});
export type Player = z.infer<typeof playerSchema>;

/**
 * The provenance of a log entry.
 *
 * This field exists so the question "did a model cause this?" is answerable from
 * the data alone, without cross-referencing anything. It is what makes the audit
 * trail in SAFETY.md possible.
 */
export const eventSourceSchema = z.enum([
  /** The engine itself, e.g. role assignment at START. */
  'engine',
  /** A human: the host, or a player action reported through the UI. */
  'human',
  /** A model proposal that passed schema and safety validation. */
  'game-master',
]);
export type EventSource = z.infer<typeof eventSourceSchema>;

export const logEntrySchema = z.object({
  id: z.string().min(1),
  sequence: z.int().min(0),
  at: z.int(),
  source: eventSourceSchema,
  /** The command or event kind that produced this entry. */
  type: z.string().min(1),
  /** Human-readable summary, safe to show players and to read aloud. */
  summary: z.string().min(1),
  /** Structured detail. Kept loose because each entry type carries its own shape. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const activeModifierSchema = z.object({
  id: z.string().min(1),
  kind: gameEventKindSchema,
  description: z.string().min(1),
  /** Role ids the modifier applies to; empty means everyone. */
  appliesToRoleIds: z.array(z.string().min(1)),
  /** Epoch ms after which the modifier lapses, or null for "until removed". */
  expiresAt: z.int().nullable(),
});
export type ActiveModifier = z.infer<typeof activeModifierSchema>;

export const sessionStateSchema = z.object({
  id: z.string().min(1),
  gameId: z.string().min(1),
  joinCode: z.string().min(1),
  status: sessionStatusSchema,
  /** Index into the definition's `phases` array. */
  phaseIndex: z.int().min(0),
  players: z.array(playerSchema),
  /** Rules currently in force. Phase 2 populates this from validated proposals. */
  modifiers: z.array(activeModifierSchema),
  log: z.array(logEntrySchema),
  createdAt: z.int(),
  startedAt: z.int().nullable(),
  endedAt: z.int().nullable(),
  /**
   * Seed for this session's randomness. Stored rather than derived so a replay
   * reproduces role assignment exactly, even on a different host.
   */
  randomSeed: z.int(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/** The phase the session is currently in, given its definition's phase list. */
export function currentPhaseId(
  state: SessionState,
  phases: readonly { id: string }[],
): string | undefined {
  return phases[state.phaseIndex]?.id;
}

export function activePlayers(state: SessionState): readonly Player[] {
  return state.players.filter((player) => player.active);
}

export function findPlayer(state: SessionState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId);
}

/** Players holding a given role, used by the engine when scoping a modifier. */
export function playersInRole(state: SessionState, roleId: string): readonly Player[] {
  return state.players.filter((player) => player.active && player.roleId === roleId);
}

/** Modifiers still in force at `now`. Expiry is evaluated, never mutated in place. */
export function liveModifiers(state: SessionState, now: number): readonly ActiveModifier[] {
  return state.modifiers.filter(
    (modifier) => modifier.expiresAt === null || modifier.expiresAt > now,
  );
}
