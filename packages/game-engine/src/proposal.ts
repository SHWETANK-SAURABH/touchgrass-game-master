import { z } from 'zod';

/**
 * The contract between the Game Master and the engine.
 *
 * This file is the single most important boundary in the codebase, so it is worth
 * being explicit about what it is and is not.
 *
 * It IS: the complete set of shapes a model is allowed to emit. The engine owns
 * this schema — the AI package depends on it, never the other way round. That
 * direction means the engine can be understood, tested, and trusted without
 * reading a line of AI code.
 *
 * It is NOT: a state mutation. A proposal is an *intent*. Nothing in this file
 * can change a session. The model fills in one of these shapes; the engine then
 * decides, deterministically, whether to apply it and what applying it means.
 *
 * Deliberately conservative choices, because every field here is attacker- and
 * hallucination-facing:
 *
 *  - No free-form `data` bag. Each kind has named, typed fields.
 *  - Strings are length-bounded. A twist has to be shoutable across a field.
 *  - Durations are bounded. A model cannot propose a rule lasting an hour.
 *  - Scores are bounded. A model cannot hand out a thousand points.
 *  - `.strict()` everywhere, so an unexpected key is a rejection, not a shrug.
 */

/** A twist read aloud mid-game has to be short enough to shout and remember. */
const spokenText = z.string().trim().min(4).max(240);

export const PROPOSAL_LIMITS = {
  /** Longest a modifier, objective, or zone rule may stay in force. */
  maxDurationSeconds: 300,
  /** Largest single score change in either direction. */
  maxScoreDelta: 10,
  /** Most players a single ROLE_ASSIGN may move at once. */
  maxRoleReassignments: 4,
  /** Longest a TIMER may run. */
  maxTimerSeconds: 600,
} as const;

const durationSeconds = z.int().min(5).max(PROPOSAL_LIMITS.maxDurationSeconds);

/**
 * Who a proposal applies to.
 *
 * Expressed as role ids or player ids, never as free text, so the engine can
 * resolve the audience without parsing a sentence.
 */
export const proposalTargetSchema = z
  .object({
    /** Role ids the rule applies to. Empty array plus no playerIds means everyone. */
    roleIds: z.array(z.string().min(1).max(40)).max(8).default([]),
    /** Specific players, for a rule aimed at individuals. */
    playerIds: z.array(z.string().min(1).max(64)).max(32).default([]),
  })
  .strict();
export type ProposalTarget = z.infer<typeof proposalTargetSchema>;

const baseFields = {
  /**
   * One sentence of reasoning, for the audit log and for the host UI. Required so
   * a rejected proposal is debuggable: we keep the model's own justification
   * alongside the rule that rejected it.
   */
  rationale: z.string().trim().min(8).max(300),
};

export const announceProposalSchema = z
  .object({
    kind: z.literal('ANNOUNCE'),
    ...baseFields,
    /** Read aloud verbatim. */
    message: spokenText,
  })
  .strict();

export const objectiveProposalSchema = z
  .object({
    kind: z.literal('OBJECTIVE'),
    ...baseFields,
    /** What players must do, phrased as an instruction. */
    instruction: spokenText,
    target: proposalTargetSchema,
    durationSeconds,
    /** Points awarded on completion. */
    points: z.int().min(0).max(PROPOSAL_LIMITS.maxScoreDelta),
  })
  .strict();

export const modifierProposalSchema = z
  .object({
    kind: z.literal('MODIFIER'),
    ...baseFields,
    /** The rule change, phrased so it can be shouted once and understood. */
    rule: spokenText,
    target: proposalTargetSchema,
    durationSeconds,
  })
  .strict();

export const zoneRuleProposalSchema = z
  .object({
    kind: z.literal('ZONE_RULE'),
    ...baseFields,
    /**
     * A landmark described in words the players can resolve themselves.
     *
     * No coordinates. The system has no map, no GPS, and no knowledge of what is
     * on the far side of a hedge, so it must never claim spatial authority it does
     * not have. Players own the boundary; the Game Master only references it.
     */
    landmark: z.string().trim().min(3).max(120),
    effect: z.enum(['safe', 'out-of-bounds', 'objective-site']),
    /** Spelled out for players, e.g. "nobody can be tagged while touching it". */
    rule: spokenText,
    durationSeconds,
  })
  .strict();

export const timerProposalSchema = z
  .object({
    kind: z.literal('TIMER'),
    ...baseFields,
    label: z.string().trim().min(2).max(60),
    seconds: z.int().min(5).max(PROPOSAL_LIMITS.maxTimerSeconds),
    /** Announced when the timer reaches zero. */
    onExpireMessage: spokenText,
  })
  .strict();

export const scoreAdjustProposalSchema = z
  .object({
    kind: z.literal('SCORE_ADJUST'),
    ...baseFields,
    target: proposalTargetSchema,
    delta: z
      .int()
      .min(-PROPOSAL_LIMITS.maxScoreDelta)
      .max(PROPOSAL_LIMITS.maxScoreDelta)
      .refine((value) => value !== 0, 'a score adjustment of zero is not a proposal'),
    reason: z.string().trim().min(4).max(160),
  })
  .strict();

export const roleAssignProposalSchema = z
  .object({
    kind: z.literal('ROLE_ASSIGN'),
    ...baseFields,
    assignments: z
      .array(
        z
          .object({
            playerId: z.string().min(1).max(64),
            roleId: z.string().min(1).max(40),
          })
          .strict(),
      )
      .min(1)
      .max(PROPOSAL_LIMITS.maxRoleReassignments),
    /** Announced to the group when the swap happens. */
    announcement: spokenText,
  })
  .strict();

/**
 * The discriminated union the model must produce.
 *
 * `z.discriminatedUnion` on `kind` gives precise, per-branch error messages,
 * which matters a great deal for the repair loop in packages/ai: telling a 4B
 * model "modifier.durationSeconds must be at most 300" produces a usable retry,
 * whereas "invalid union" does not.
 */
export const gameEventProposalSchema = z.discriminatedUnion('kind', [
  announceProposalSchema,
  objectiveProposalSchema,
  modifierProposalSchema,
  zoneRuleProposalSchema,
  timerProposalSchema,
  scoreAdjustProposalSchema,
  roleAssignProposalSchema,
]);

export type GameEventProposal = z.infer<typeof gameEventProposalSchema>;
export type AnnounceProposal = z.infer<typeof announceProposalSchema>;
export type ObjectiveProposal = z.infer<typeof objectiveProposalSchema>;
export type ModifierProposal = z.infer<typeof modifierProposalSchema>;
export type ZoneRuleProposal = z.infer<typeof zoneRuleProposalSchema>;
export type TimerProposal = z.infer<typeof timerProposalSchema>;
export type ScoreAdjustProposal = z.infer<typeof scoreAdjustProposalSchema>;
export type RoleAssignProposal = z.infer<typeof roleAssignProposalSchema>;

/**
 * A batch of proposals from one Game Master turn.
 *
 * Capped at three because a turn that rewrites five rules at once is unplayable:
 * players cannot hold that many changes in their heads while running.
 */
export const gameMasterTurnSchema = z
  .object({
    proposals: z.array(gameEventProposalSchema).min(1).max(3),
  })
  .strict();
export type GameMasterTurn = z.infer<typeof gameMasterTurnSchema>;

/** Every human-readable string a proposal carries, for the safety layer to scan. */
export function proposalTextFragments(proposal: GameEventProposal): string[] {
  const fragments: string[] = [proposal.rationale];
  switch (proposal.kind) {
    case 'ANNOUNCE':
      fragments.push(proposal.message);
      break;
    case 'OBJECTIVE':
      fragments.push(proposal.instruction);
      break;
    case 'MODIFIER':
      fragments.push(proposal.rule);
      break;
    case 'ZONE_RULE':
      fragments.push(proposal.landmark, proposal.rule);
      break;
    case 'TIMER':
      fragments.push(proposal.label, proposal.onExpireMessage);
      break;
    case 'SCORE_ADJUST':
      fragments.push(proposal.reason);
      break;
    case 'ROLE_ASSIGN':
      fragments.push(proposal.announcement);
      break;
  }
  return fragments;
}

/** How long a proposal stays in force, or null for kinds with no duration. */
export function proposalDurationSeconds(proposal: GameEventProposal): number | null {
  switch (proposal.kind) {
    case 'OBJECTIVE':
    case 'MODIFIER':
    case 'ZONE_RULE':
      return proposal.durationSeconds;
    case 'TIMER':
      return proposal.seconds;
    case 'ANNOUNCE':
    case 'SCORE_ADJUST':
    case 'ROLE_ASSIGN':
      return null;
  }
}
