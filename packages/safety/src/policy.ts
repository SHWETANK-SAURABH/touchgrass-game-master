import { z } from 'zod';
import type { GameDefinition } from '@touchgrass/game-definitions';
import {
  HAZARD_CATEGORIES,
  NON_NEGOTIABLE_HAZARDS,
  hazardCategoryIdSchema,
  type HazardCategoryId,
} from './hazards';

/**
 * The configuration a safety check runs against.
 *
 * A policy is derived from the game definition, never hand-assembled at a call
 * site, so a session cannot accidentally run looser rules than its game declared.
 * `policyFor` is the only constructor, and the fields it does not derive are the
 * ones a host legitimately controls.
 *
 * What a policy cannot do: switch off a critical hazard. `enforcedHazards` always
 * contains every non-negotiable category, and the schema checks it.
 */

export const POLICY_VERSION = '2026.10-phase1';

export const safetyPolicySchema = z
  .object({
    /** Version stamp written into every verdict. */
    version: z.string().min(1),
    /** The game this policy was derived from. */
    gameId: z.string().min(1),
    /** Hazard categories this policy enforces. */
    enforcedHazards: z.array(hazardCategoryIdSchema).min(1),
    /** Contact beyond this is rejected. Mirrors the game definition. */
    contactPolicy: z.enum(['none', 'tag-only', 'cooperative']),
    /** Exertion beyond this is rejected. Mirrors the game definition. */
    maxIntensity: z.enum(['low', 'moderate', 'high']),
    /** True when the game expects players to be out of each others sight. */
    separationExpected: z.boolean(),
    /** Longest any single generated rule may stay in force, in seconds. */
    maxRuleDurationSeconds: z.int().positive(),
    /**
     * Whether the host has confirmed an adult is present and watching. Tightens
     * the moderate-severity rules when false; never loosens anything.
     */
    supervisedByAdult: z.boolean(),
  })
  .strict()
  .refine(
    (policy) => NON_NEGOTIABLE_HAZARDS.every((hazard) => policy.enforcedHazards.includes(hazard)),
    {
      message: 'a policy may not omit a critical hazard category',
      path: ['enforcedHazards'],
    },
  );

export type SafetyPolicy = z.infer<typeof safetyPolicySchema>;

export interface PolicyOptions {
  /** Defaults to false — the stricter assumption. */
  supervisedByAdult?: boolean;
  /**
   * Shortens the maximum rule duration below the game default. Cannot lengthen it:
   * a host may make a session safer, never less safe.
   */
  maxRuleDurationSeconds?: number;
}

/** Rule durations are capped per game intensity: harder games get shorter rules. */
const DURATION_CEILING_BY_INTENSITY = { low: 300, moderate: 180, high: 120 } as const;

/**
 * Derives the policy for a session from its game definition.
 *
 * Every bundled game enforces every hazard category. That is deliberate for now:
 * the categories that do not apply to a given game simply never match, and
 * starting from "enforce everything" means a new game added by a contributor is
 * safe by default rather than safe only if they remembered to opt in.
 */
export function policyFor(definition: GameDefinition, options: PolicyOptions = {}): SafetyPolicy {
  const ceiling = DURATION_CEILING_BY_INTENSITY[definition.safety.maxIntensity];
  const requested = options.maxRuleDurationSeconds;

  return safetyPolicySchema.parse({
    version: POLICY_VERSION,
    gameId: definition.id,
    enforcedHazards: HAZARD_CATEGORIES.map((category) => category.id),
    contactPolicy: definition.safety.contactPolicy,
    maxIntensity: definition.safety.maxIntensity,
    separationExpected: definition.safety.involvesSeparation,
    maxRuleDurationSeconds: requested !== undefined ? Math.min(requested, ceiling) : ceiling,
    supervisedByAdult: options.supervisedByAdult ?? false,
  });
}

export function enforces(policy: SafetyPolicy, hazard: HazardCategoryId): boolean {
  return policy.enforcedHazards.includes(hazard);
}
