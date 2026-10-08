import { type Result, err, ok } from '@touchgrass/shared';
import { findGameDefinition } from '@touchgrass/game-definitions';
import {
  type EngineContext,
  type EngineError,
  type GameState,
  type ValidatedGameEvent,
  applyValidatedEvent,
  validateExternalEvent,
} from '@touchgrass/game-engine';
import {
  type PolicyOptions,
  type SafetyClearedEvent,
  type SafetyRejection,
  releaseClearedEvent,
  validateSafety,
} from '@touchgrass/safety';
import type { GameMaster, GameMasterError } from '../game-master/game-master';
import { type GameMasterProposal, parseGameMasterProposal } from '../game-master/proposal';

/**
 * The hand-off from a Game Master proposal to the deterministic engine.
 *
 *   raw proposal
 *     → schema validation           parseGameMasterProposal   (this package)
 *     → state-aware validation      validateExternalEvent     (the engine)
 *     → ValidatedGameEvent
 *     → safety validation           validateSafety            (the safety package)
 *     → SafetyClearedEvent
 *     → deterministic application   applyValidatedEvent       (the engine)
 *     → new GameState
 *
 * AI proposes; schema checks shape; domain validation checks legality; safety
 * validation checks real-world risk; the deterministic engine executes.
 *
 * This module owns no game rules and no safety rules. It decides nothing about
 * what is legal or what is safe: it passes the proposed event to the engine's
 * own validator, then to the safety package's validator, and only then to the
 * engine's own apply function. It is kept apart from the Game Master so that the
 * model-facing code still has no access to anything that can change a game.
 *
 * The game definition is never taken from the caller. It is looked up from the
 * state's game id, here and again inside the engine, so a modified definition
 * cannot be used to widen what is accepted.
 *
 * Legal does not mean safe. The engine's validated event is not applied from
 * here: it goes to the safety validator, and the only thing this module hands
 * the engine is what the safety package releases from a clearance it issued.
 * A safety clearance means no rule of the safety policy matched. It is not a
 * statement about the real place the game is being played.
 *
 * Nothing is repaired here. A proposal that names a player, role or power that
 * does not exist, or that the safety policy refuses, is not applied: the state
 * is returned to the caller unchanged, the event is not rewritten, and the model
 * is not asked again.
 */

/**
 * A proposal that is legal in a particular game state and passed the safety
 * policy, or a decision to do nothing.
 */
export type ValidatedProposal =
  | {
      readonly kind: 'EVENT';
      readonly proposal: GameMasterProposal;
      readonly cleared: SafetyClearedEvent;
    }
  | { readonly kind: 'NO_EVENT'; readonly proposal: GameMasterProposal };

export type ProposalRejection =
  /** The proposal is not a well-formed proposal for this game, or the game is unknown. */
  | { readonly stage: 'SCHEMA'; readonly issues: readonly string[] }
  /** The proposal is well formed but not legal in this game right now. */
  | { readonly stage: 'STATE'; readonly error: EngineError; readonly proposal: GameMasterProposal }
  /** The proposal is legal in the game but did not pass the safety policy. */
  | {
      readonly stage: 'SAFETY';
      readonly rejection: SafetyRejection;
      readonly proposal: GameMasterProposal;
    };

/**
 * Validates a proposal against the game as it stands, and then against the
 * safety policy of that game. Reads the state and changes nothing.
 *
 * `proposal` is treated as untrusted even when it came from `GameMaster.propose`,
 * which has already checked its shape: the schema is checked again here so this
 * function is safe to call with a proposal from anywhere.
 *
 * `event: null` is a legitimate answer and is returned as NO_EVENT. The
 * rationale is explanatory text from a model. It is carried along for the record
 * and is never read as a fact about the game, nor as evidence that the event is
 * safe: the safety validator is given the event only.
 *
 * `safety` can make the policy stricter or record adult supervision. It cannot
 * switch a check off.
 */
export function validateGameMasterProposal(
  proposal: unknown,
  state: GameState,
  ctx: EngineContext,
  safety: PolicyOptions = {},
): Result<ValidatedProposal, ProposalRejection> {
  const definition = findGameDefinition(state.gameId);
  if (!definition) {
    return err({ stage: 'SCHEMA', issues: [`No game definition for "${state.gameId}".`] });
  }

  const parsed = parseGameMasterProposal(proposal, definition);
  if (!parsed.ok) return err({ stage: 'SCHEMA', issues: parsed.error });

  if (parsed.value.event === null) return ok({ kind: 'NO_EVENT', proposal: parsed.value });

  const validated = validateExternalEvent(state, parsed.value.event, 'game-master', ctx);
  if (!validated.ok) {
    return err({ stage: 'STATE', error: validated.error, proposal: parsed.value });
  }

  const cleared = validateSafety(validated.value, state, safety);
  if (!cleared.ok) {
    return err({ stage: 'SAFETY', rejection: cleared.error, proposal: parsed.value });
  }
  return ok({ kind: 'EVENT', proposal: parsed.value, cleared: cleared.value });
}

/** What a hand-off did. `state` is always the state to continue with. */
export type HandoffOutcome =
  | {
      readonly outcome: 'APPLIED';
      readonly state: GameState;
      readonly proposal: GameMasterProposal;
    }
  /** The Game Master proposed nothing. `state` is the state that was passed in. */
  | {
      readonly outcome: 'NO_EVENT';
      readonly state: GameState;
      readonly proposal: GameMasterProposal;
    };

export type HandoffFailure =
  /** The Game Master did not produce a proposal (model unavailable, invalid reply, game not active). */
  | { readonly stage: 'PROPOSAL'; readonly error: GameMasterError }
  | ProposalRejection
  /** The engine refused the validated event as it was applied. */
  | {
      readonly stage: 'APPLICATION';
      readonly error: EngineError;
      readonly proposal: GameMasterProposal;
    };

/**
 * Something that holds a game and has the engine apply validated events to it:
 * a plain state, or a live session.
 */
export interface ProposalTarget {
  /** The game as it stands now. */
  readonly getState: () => GameState;
  /**
   * Has the engine apply an event it validated. It must go through the engine's
   * `applyValidatedEvent` and must leave the game untouched on a refusal.
   */
  readonly applyEvent: (
    validated: ValidatedGameEvent,
    ctx: EngineContext,
  ) => Result<{ readonly state: GameState }, EngineError>;
}

/**
 * Validates a proposal against the game a target holds and, if it is legal and
 * passes the safety policy, has the target apply it. Deterministic: no model is
 * involved. On any failure nothing is applied and the game is exactly as it was.
 *
 * The proposal is validated against the target's state at the moment of the
 * call, not against whatever state the proposal was made from. A model takes
 * time to answer, and the game may have moved on meanwhile.
 */
export function handOffProposalTo(
  target: ProposalTarget,
  proposal: unknown,
  ctx: EngineContext,
  safety: PolicyOptions = {},
): Result<HandoffOutcome, HandoffFailure> {
  const state = target.getState();
  const validated = validateGameMasterProposal(proposal, state, ctx, safety);
  if (!validated.ok) return validated;

  if (validated.value.kind === 'NO_EVENT') {
    return ok({ outcome: 'NO_EVENT', state, proposal: validated.value.proposal });
  }

  // The engine is given only what the safety package releases from a clearance
  // it issued itself.
  const released = releaseClearedEvent(validated.value.cleared);
  if (!released.ok) {
    return err({ stage: 'SAFETY', rejection: released.error, proposal: validated.value.proposal });
  }

  const applied = target.applyEvent(released.value, ctx);
  if (!applied.ok) {
    return err({ stage: 'APPLICATION', error: applied.error, proposal: validated.value.proposal });
  }
  return ok({ outcome: 'APPLIED', state: applied.value.state, proposal: validated.value.proposal });
}

/**
 * The same hand-off for a plain state. The new state is returned; the one
 * passed in is never changed.
 */
export function handOffProposal(
  proposal: unknown,
  state: GameState,
  ctx: EngineContext,
  safety: PolicyOptions = {},
): Result<HandoffOutcome, HandoffFailure> {
  return handOffProposalTo(
    {
      getState: () => state,
      applyEvent: (validated, applyCtx) => {
        const applied = applyValidatedEvent(state, validated, applyCtx);
        return applied.ok ? ok({ state: applied.value }) : applied;
      },
    },
    proposal,
    ctx,
    safety,
  );
}

/**
 * One Game Master turn: ask for a proposal, then hand it off.
 *
 * Nothing calls this on its own. There is no timer, schedule or trigger: a turn
 * happens when a caller asks for one.
 *
 * Generation and execution stay separate. The Game Master is asked for a value;
 * that value then goes through `handOffProposal` like a proposal from anywhere
 * else. The Game Master is never given the engine, and a failure at any stage
 * leaves the game as it was.
 */
export async function runGameMasterTurn(input: {
  readonly gameMaster: Pick<GameMaster, 'propose'>;
  readonly state: GameState;
  readonly ctx: EngineContext;
  readonly signal?: AbortSignal;
  /** Makes the safety policy stricter, or records adult supervision. */
  readonly safety?: PolicyOptions;
}): Promise<Result<HandoffOutcome, HandoffFailure>> {
  const { gameMaster, state, ctx } = input;
  const definition = findGameDefinition(state.gameId);
  if (!definition) {
    return err({ stage: 'SCHEMA', issues: [`No game definition for "${state.gameId}".`] });
  }

  const proposed = await gameMaster.propose(
    { state, definition, now: ctx.now },
    input.signal ? { signal: input.signal } : {},
  );
  if (!proposed.ok) return err({ stage: 'PROPOSAL', error: proposed.error });

  return handOffProposal(proposed.value.proposal, state, ctx, input.safety);
}
