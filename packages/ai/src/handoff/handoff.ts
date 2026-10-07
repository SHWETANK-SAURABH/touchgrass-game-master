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
import type { GameMaster, GameMasterError } from '../game-master/game-master';
import { type GameMasterProposal, parseGameMasterProposal } from '../game-master/proposal';

/**
 * The hand-off from a Game Master proposal to the deterministic engine.
 *
 *   raw proposal
 *     → schema validation           parseGameMasterProposal   (this package)
 *     → state-aware validation      validateExternalEvent     (the engine)
 *     → ValidatedGameEvent
 *     → deterministic application   applyValidatedEvent       (the engine)
 *     → new GameState
 *
 * AI proposes; deterministic validation decides; the game engine executes.
 *
 * This module owns no game rules. It decides nothing about what is legal: it
 * passes the proposed event to the engine's own validator and then to the
 * engine's own apply function. It is kept apart from the Game Master so that the
 * model-facing code still has no access to anything that can change a game.
 *
 * The game definition is never taken from the caller. It is looked up from the
 * state's game id, here and again inside the engine, so a modified definition
 * cannot be used to widen what is accepted.
 *
 * "Validated" in this module means legal in the game. It does not mean safe: no
 * safety validation exists yet, and an applied proposal has not been through one.
 *
 * Nothing is repaired here. A proposal that names a player, role or power that
 * does not exist is refused, the state is returned to the caller unchanged, and
 * the model is not asked again.
 */

/** A proposal the engine has accepted for a particular game state, or a decision to do nothing. */
export type ValidatedProposal =
  | {
      readonly kind: 'EVENT';
      readonly proposal: GameMasterProposal;
      readonly validated: ValidatedGameEvent;
    }
  | { readonly kind: 'NO_EVENT'; readonly proposal: GameMasterProposal };

export type ProposalRejection =
  /** The proposal is not a well-formed proposal for this game, or the game is unknown. */
  | { readonly stage: 'SCHEMA'; readonly issues: readonly string[] }
  /** The proposal is well formed but not legal in this game right now. */
  | { readonly stage: 'STATE'; readonly error: EngineError; readonly proposal: GameMasterProposal };

/**
 * Validates a proposal against the game as it stands. Reads the state and
 * changes nothing.
 *
 * `proposal` is treated as untrusted even when it came from `GameMaster.propose`,
 * which has already checked its shape: the schema is checked again here so this
 * function is safe to call with a proposal from anywhere.
 *
 * `event: null` is a legitimate answer and is returned as NO_EVENT. The
 * rationale is explanatory text from a model. It is carried along for the record
 * and is never read as a fact about the game.
 */
export function validateGameMasterProposal(
  proposal: unknown,
  state: GameState,
  ctx: EngineContext,
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
  return ok({ kind: 'EVENT', proposal: parsed.value, validated: validated.value });
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
 * Validates a proposal and, if the engine accepts it, has the engine apply it.
 * Deterministic: no model is involved. On any failure nothing is applied and the
 * caller's state is exactly as it was.
 */
export function handOffProposal(
  proposal: unknown,
  state: GameState,
  ctx: EngineContext,
): Result<HandoffOutcome, HandoffFailure> {
  const validated = validateGameMasterProposal(proposal, state, ctx);
  if (!validated.ok) return validated;

  if (validated.value.kind === 'NO_EVENT') {
    return ok({ outcome: 'NO_EVENT', state, proposal: validated.value.proposal });
  }

  const applied = applyValidatedEvent(state, validated.value.validated, ctx);
  if (!applied.ok) {
    return err({ stage: 'APPLICATION', error: applied.error, proposal: validated.value.proposal });
  }
  return ok({ outcome: 'APPLIED', state: applied.value, proposal: validated.value.proposal });
}

/**
 * One Game Master turn: ask for a proposal, then hand it off.
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

  return handOffProposal(proposed.value.proposal, state, ctx);
}
