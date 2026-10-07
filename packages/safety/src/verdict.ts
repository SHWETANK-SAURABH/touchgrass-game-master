import { z } from 'zod';
import { hazardCategoryIdSchema, hazardSeveritySchema } from './hazards';

/**
 * The shape of a safety decision.
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
 *     event and the same policy always produce the same verdict; it carries no
 *     timing or other value that differs between runs.
 *
 * How the three dispositions read:
 *
 *   allow    SAFE under the policy: no rule matched. Not a guarantee about the
 *            real place the game is played in, which the system cannot see.
 *   revise   UNSAFE as written, for a moderate reason only. Not executed.
 *   reject   UNSAFE. Not executed.
 *
 * Only `allow` lets an event through. Nothing in this project rewrites an event
 * or asks a model to try again after `revise`; the distinction is recorded for
 * whoever reads the verdict.
 */

export const safetyDispositionSchema = z.enum([
  /** No rule of the policy matched. */
  'allow',
  /** Not safe as written, for a moderate reason only. Not executed. */
  'revise',
  /** Not safe. Not executed. */
  'reject',
]);
export type SafetyDisposition = z.infer<typeof safetyDispositionSchema>;

export const safetyViolationSchema = z.object({
  hazard: hazardCategoryIdSchema,
  severity: hazardSeveritySchema,
  /** Which rule matched, e.g. "road-places" or "rule-duration". */
  rule: z.string().min(1),
  /** Which field of the event triggered it, e.g. "description" or "zone". */
  field: z.string().min(1),
  /** The exact words or the structural condition that matched. */
  evidence: z.string().min(1),
  /** One sentence a host could read aloud to explain the rejection. */
  explanation: z.string().min(1),
});
export type SafetyViolation = z.infer<typeof safetyViolationSchema>;

export const safetyVerdictSchema = z.object({
  disposition: safetyDispositionSchema,
  violations: z.array(safetyViolationSchema),
  /** The event fields that were examined, so a reader can see what was and was not checked. */
  checkedFields: z.array(z.string().min(1)),
  /** Rule-set version that produced this verdict, so old logs stay interpretable. */
  policyVersion: z.string().min(1),
});
export type SafetyVerdict = z.infer<typeof safetyVerdictSchema>;

/**
 * The validator's signature.
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

/** True when the verdict is unsafe for a moderate reason only. Nothing retries on it today. */
export function isRepairable(verdict: SafetyVerdict): boolean {
  return verdict.disposition === 'revise';
}

/** The most severe violation in a verdict, for log lines and host summaries. */
export function worstViolation(verdict: SafetyVerdict): SafetyViolation | undefined {
  const rank = { moderate: 1, high: 2, critical: 3 } as const;
  return [...verdict.violations].sort((a, b) => rank[b.severity] - rank[a.severity])[0];
}
