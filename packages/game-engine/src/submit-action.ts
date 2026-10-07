import { type Result, err, ok } from '@touchgrass/shared';
import { findGameDefinition } from '@touchgrass/game-definitions';
import { type PlayerAction, parsePlayerIntent } from './actions';
import type { EngineContext } from './apply-event';
import { type EngineError, engineError } from './errors';
import { processPlayerAction } from './process-action';
import type { GameState, HistoryEntry } from './state';

/**
 * The multiplayer command boundary.
 *
 *   client message (an intent: what, never who)
 *     + the actor the caller resolved for that client
 *     → PlayerAction
 *     → processPlayerAction: validation → the events it causes → application
 *     → new GameState, and the history entries that were added
 *
 * Two things arrive separately and are never mixed:
 *
 *  - `actorId` comes from the caller. A future realtime server knows which
 *    player a connection belongs to and passes that id. It is not read from the
 *    client's message.
 *  - `intent` is the client's message, untrusted. It has no field that names the
 *    actor, so it cannot claim to be someone else.
 *
 * This is domain authorisation, not authentication. The engine checks that the
 * actor is a player in this game who may do this now; it does not know or check
 * how the caller decided which player a client is.
 *
 * Like every entry point, this is a pure function of the state, the input and
 * `ctx`. It reads no clock, starts no timer and calls nothing outside the
 * engine. It does not change the state it is given: it returns a new one, or a
 * refusal and nothing else.
 *
 * One game has one authoritative state. Whoever holds it gives the engine one
 * input at a time and keeps the state that comes back. Two inputs that arrive
 * together are processed one after the other; the second is judged against the
 * state the first produced, and is refused if it is no longer legal there.
 * Calling this twice with the same state gives two separate results, of which a
 * caller may keep only one.
 */

/** What an accepted action did. */
export interface PlayerActionOutcome {
  /** The state to continue with. */
  readonly state: GameState;
  /** The action as the engine recorded it, with the actor filled in. */
  readonly action: PlayerAction;
  /**
   * The history entries this step added, in order: any round that ended because
   * time had passed, the action itself, the events it caused and their awards.
   * `sequence` gives each entry its position in the game, so a caller that
   * announces them can keep them in order.
   */
  readonly entries: readonly HistoryEntry[];
}

function isPlayerId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64;
}

/**
 * Processes one client intent on behalf of `actorId`.
 *
 * On a refusal the caller's state is exactly as it was: no entry is recorded,
 * no event applied, no point awarded and no time advanced.
 */
export function submitPlayerAction(
  state: GameState,
  actorId: string,
  intent: unknown,
  ctx: EngineContext,
): Result<PlayerActionOutcome, EngineError> {
  if (!findGameDefinition(state.gameId)) {
    return err(
      engineError('INVALID_GAME_CONFIGURATION', `No game definition for "${state.gameId}".`, {
        gameId: state.gameId,
      }),
    );
  }
  if (!isPlayerId(actorId)) {
    return err(engineError('INVALID_PLAYER', 'The acting player is not identified.'));
  }

  const parsed = parsePlayerIntent(intent);
  if (!parsed.ok) return parsed;

  // The actor is attached here and nowhere else. The action then goes through
  // the same schema and domain validation as any other action.
  const next = processPlayerAction(state, { ...parsed.value, playerId: actorId }, ctx);
  if (!next.ok) return next;

  const entries = next.value.history.slice(state.history.length);
  const recorded = entries.find((entry) => entry.record.kind === 'ACTION')?.record;
  if (recorded?.kind !== 'ACTION') {
    return err(engineError('INVALID_GAME_STATE', 'An accepted action was not recorded.'));
  }
  return ok({ state: next.value, action: recorded.action, entries });
}
