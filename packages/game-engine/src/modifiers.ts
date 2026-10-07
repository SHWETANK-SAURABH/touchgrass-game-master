import { z } from 'zod';

/**
 * Modifiers and objectives currently in force.
 *
 * Only modifiers that last for a period are stored: a zone, a power in use, a
 * freeze. TIME_EXTENSION and ROLE_SWAP take effect at once and leave nothing
 * behind, and a BONUS_OBJECTIVE is stored as an objective rather than a
 * modifier, because it can be completed.
 *
 * Every entry carries an absolute `expiresAt` in epoch milliseconds. Expiry is
 * decided by comparing it with the clock value supplied to the engine, so it is
 * the same on every host and in every replay.
 */

const id = z.string().min(1).max(64);
const expiresAt = z.int().min(0);

export const safeZoneModifierSchema = z
  .object({ id, kind: z.literal('SAFE_ZONE'), zone: z.string().min(1), expiresAt })
  .strict();

export const movingZoneModifierSchema = z
  .object({ id, kind: z.literal('MOVING_ZONE'), zone: z.string().min(1), expiresAt })
  .strict();

/** A power a player has activated. A power merely held sits on the player instead. */
export const temporaryPowerUpModifierSchema = z
  .object({
    id,
    kind: z.literal('TEMPORARY_POWER_UP'),
    playerId: id,
    powerId: id,
    expiresAt,
  })
  .strict();

export const freezePeriodModifierSchema = z
  .object({
    id,
    kind: z.literal('FREEZE_PERIOD'),
    roleIds: z.array(id).min(1),
    expiresAt,
  })
  .strict();

export const activeModifierSchema = z.discriminatedUnion('kind', [
  safeZoneModifierSchema,
  movingZoneModifierSchema,
  temporaryPowerUpModifierSchema,
  freezePeriodModifierSchema,
]);
export type ActiveModifier = z.infer<typeof activeModifierSchema>;

/** A challenge or bonus objective players can still complete. */
export const activeObjectiveSchema = z
  .object({
    id,
    /** Which event created it. */
    source: z.enum(['CHALLENGE', 'BONUS_OBJECTIVE']),
    description: z.string().min(1),
    points: z.int().min(1),
    /** Players who may complete it. Empty means every player. */
    eligiblePlayerIds: z.array(id),
    completedByPlayerIds: z.array(id),
    expiresAt,
  })
  .strict();
export type ActiveObjective = z.infer<typeof activeObjectiveSchema>;
