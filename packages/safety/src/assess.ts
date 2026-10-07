import type { ExternalGameEvent } from '@touchgrass/game-engine';
import { type HazardCategoryId, type HazardSeverity, getHazardCategory } from './hazards';
import { type SafetyPolicy, enforces } from './policy';
import { LEXICAL_RULES } from './rules';
import { NO_WORDS, normalise, unreadableReason } from './text';
import type { SafetyValidator, SafetyVerdict, SafetyViolation } from './verdict';

/**
 * The safety assessment.
 *
 * Domain validation asks whether an event is legal in the game. This asks a
 * different question: even if it is legal, is it acceptable to tell real people
 * outdoors to do it? An event can be perfectly legal — a bonus objective, for a
 * game that allows them, within every limit — and say "climb the abandoned
 * building".
 *
 * It is a pure function of the event and the policy. No model is consulted, no
 * clock is read, nothing is fetched, and the event is not changed. The same
 * event and policy always give the same verdict.
 *
 * It works in three parts:
 *
 *  1. Structure. Each event kind is taken apart explicitly: which of its fields
 *     reach players as words, and which are plain values checked against the
 *     policy.
 *  2. Text. The fields that reach players are checked with the lexical rules.
 *     A model's rationale is not one of them: it is the model talking about its
 *     proposal, not an instruction to anyone, and it is never read here.
 *  3. Fail closed. Text the rules cannot read, and instructions that leave the
 *     risky choice open, are violations. Nothing unknown is treated as safe.
 *
 * `allow` therefore means that no rule of the policy matched. It does not mean
 * the instruction is safe in the place the game is actually being played: the
 * system has no map, no camera and no knowledge of that place.
 */

/** How a piece of event text reaches players. */
type TextRole =
  /** A sentence telling players what to do. */
  | 'instruction'
  /** The name of a place. */
  | 'place'
  /** An id the model chose. Short, but it is still model-written text. */
  | 'identifier';

interface TextField {
  readonly field: string;
  readonly role: TextRole;
  readonly text: string;
}

/**
 * The text an event carries, by kind. This switch is the complete list: a new
 * event kind does not compile until someone decides which of its fields reach
 * players.
 */
function textFieldsOf(event: ExternalGameEvent): TextField[] {
  switch (event.type) {
    case 'ZONE_CHANGE':
      return [{ field: 'zone', role: 'place', text: event.zone }];
    case 'CHALLENGE':
      return [
        { field: 'description', role: 'instruction', text: event.description },
        { field: 'challengeId', role: 'identifier', text: event.challengeId },
      ];
    case 'BONUS_OBJECTIVE':
      return [
        { field: 'description', role: 'instruction', text: event.description },
        { field: 'objectiveId', role: 'identifier', text: event.objectiveId },
      ];
    // These carry no words for players: ids of things the engine has already
    // confirmed exist, and numbers the engine has already bounded.
    case 'POWER_UP':
    case 'RULE_MODIFIER':
    case 'TIME_EXTENSION':
    case 'ROLE_CHANGE':
      return [];
  }
}

/** How long an event keeps a demand on players in force, if it does. */
function demandSeconds(event: ExternalGameEvent): number | null {
  switch (event.type) {
    case 'CHALLENGE':
    case 'BONUS_OBJECTIVE':
    case 'RULE_MODIFIER':
      return event.durationSeconds;
    case 'ZONE_CHANGE':
    case 'POWER_UP':
    case 'TIME_EXTENSION':
    case 'ROLE_CHANGE':
      return null;
  }
}

function violation(
  hazard: HazardCategoryId,
  rule: string,
  field: string,
  evidence: string,
  explanation: string,
  severity?: HazardSeverity,
): SafetyViolation {
  return {
    hazard,
    severity: severity ?? getHazardCategory(hazard).severity,
    rule,
    field,
    evidence,
    explanation,
  };
}

function assessText(entry: TextField, policy: SafetyPolicy): SafetyViolation[] {
  // An id such as "c1" has no words in it and is fine. Anything else that
  // cannot be read is refused rather than waved through.
  const unreadable = unreadableReason(entry.text);
  if (unreadable && (entry.role !== 'identifier' || unreadable !== NO_WORDS)) {
    return [
      violation(
        'unassessable-instruction',
        'unreadable-text',
        entry.field,
        entry.text.slice(0, 80),
        `The ${entry.field} cannot be safety checked because ${unreadable}.`,
      ),
    ];
  }

  const text = normalise(entry.text);
  const found: SafetyViolation[] = [];
  for (const rule of LEXICAL_RULES) {
    if (!enforces(policy, rule.hazard)) continue;
    if (rule.when && !rule.when(policy)) continue;
    const match = rule.pattern.exec(text);
    if (match) {
      found.push(
        violation(rule.hazard, rule.id, entry.field, match[0], rule.explanation, rule.severity),
      );
    }
  }
  return found;
}

/**
 * Assesses one external event against a policy.
 *
 * Disposition: any critical or high violation is `reject`. If the only
 * violations are moderate, it is `revise` when the host has confirmed adult
 * supervision and `reject` otherwise — the default is the stricter one. Only an
 * event with no violations is `allow`.
 */
export const assessEventSafety: SafetyValidator<ExternalGameEvent, SafetyPolicy> = (
  event,
  policy,
): SafetyVerdict => {
  const fields = textFieldsOf(event);
  const violations = fields.flatMap((entry) => assessText(entry, policy));

  const demand = demandSeconds(event);
  if (demand !== null && demand > policy.maxRuleDurationSeconds) {
    violations.push(
      violation(
        'dangerous-physical-challenge',
        'rule-duration',
        'durationSeconds',
        `${String(demand)}s > ${String(policy.maxRuleDurationSeconds)}s`,
        `It would last ${String(demand)} seconds; this game allows a generated demand to last at most ${String(policy.maxRuleDurationSeconds)}.`,
        'moderate',
      ),
    );
  }

  const serious = violations.some((entry) => entry.severity !== 'moderate');
  const disposition =
    violations.length === 0 ? 'allow' : serious || !policy.supervisedByAdult ? 'reject' : 'revise';

  return {
    disposition,
    violations,
    checkedFields: [
      ...fields.map((entry) => entry.field),
      ...(demand === null ? [] : ['durationSeconds']),
    ],
    policyVersion: policy.version,
  };
};
