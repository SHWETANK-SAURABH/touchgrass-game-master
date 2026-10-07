import { z } from 'zod';
import { hazardCategoryIdSchema, hazardSeveritySchema } from './hazards';

/**
 * The shape of a safety decision.
 *
 * Defined here, in this phase, because it is the interface the Phase 2 validator
 * must satisfy and the shape the engine and the host UI will consume. Fixing it
 * now means the validator is written against a known contract rather than
 * inventing one as it goes.
 *
 * Three design commitments are encoded in these types:
 *
 *  1. A verdict always carries its reasons. "Rejected" with no explanation is
 *     unusable for a host trying to understand why the Game Master went quiet,
 *     and unusable for us trying to tune prompts.
 *  2. The default disposition is rejection. The schema has no "unknown" branch —
 *     anything the validator cannot classify is a reject, because a game that
 *     fails closed is boring and a game that fails open is dangerous.
 *  3. A verdict is data, so it is logged, replayable, and testable. The same
 *     proposal and the same policy must always produce the same verdict.
 */

export const safetyDispositionSchema = z.enum([
  /** Safe to apply as written. */
  'allow',
  /** Not safe as written, but the model may be told why and asked once more. */
  'revise',
  /** Not safe, and not worth another attempt. Never shown to players. */
  'reject',
]);
export type SafetyDisposition = z.infer<typeof safetyDispositionSchema>;

export const safetyViolationSchema = z.object({
  hazard: hazardCategoryIdSchema,
  severity: hazardSeveritySchema,
  /** Which field of the proposal triggered it, e.g. "rule" or "landmark". */
  field: z.string().min(1),
  /** The exact substring or structural condition that matched. */
  evidence: z.string().min(1),
  /** One sentence a host could read aloud to explain the rejection. */
  explanation: z.string().min(1),
});
export type SafetyViolation = z.infer<typeof safetyViolationSchema>;

export const safetyVerdictSchema = z.object({
  disposition: safetyDispositionSchema,
  violations: z.array(safetyViolationSchema),
  /** Rule-set version that produced this verdict, so old logs stay interpretable. */
  policyVersion: z.string().min(1),
  /** Time spent validating, in ms. Kept because this sits in a player-facing path. */
  durationMs: z.number().min(0),
});
export type SafetyVerdict = z.infer<typeof safetyVerdictSchema>;

/**
 * The validator's signature, fixed now and implemented in Phase 2.
 *
 * Synchronous and total on purpose. A safety check that can await is a safety
 * check that can hang, time out, and get skipped under load — so the contract
 * forbids I/O, which in turn forbids asking a model whether its own output was
 * safe.
 */
export type SafetyValidator<TProposal, TContext> = (
  proposal: TProposal,
  context: TContext,
) => SafetyVerdict;

export function isAllowed(verdict: SafetyVerdict): boolean {
  return verdict.disposition === 'allow';
}

/** True when the model should be told what was wrong and asked to try again. */
export function isRepairable(verdict: SafetyVerdict): boolean {
  return verdict.disposition === 'revise';
}

/** The most severe violation in a verdict, for log lines and host summaries. */
export function worstViolation(verdict: SafetyVerdict): SafetyViolation | undefined {
  const rank = { moderate: 1, high: 2, critical: 3 } as const;
  return [...verdict.violations].sort((a, b) => rank[b.severity] - rank[a.severity])[0];
}
