import { type Result, err, ok } from '@touchgrass/shared';
import { findGameDefinition } from '@touchgrass/game-definitions';
import {
  type ExternalGameEvent,
  type GameState,
  type ValidatedGameEvent,
  isValidatedGameEvent,
} from '@touchgrass/game-engine';
import { assessEventSafety } from './assess';
import { type PolicyOptions, policyFor } from './policy';
import type { SafetyVerdict } from './verdict';

/**
 * The safety boundary.
 *
 *   ValidatedGameEvent   (the engine says: legal in this game, now)
 *     → validateSafety   (this package says: no safety rule matched)
 *     → SafetyClearedEvent
 *     → releaseClearedEvent → the engine applies it
 *
 * Domain-valid does not mean safe. The engine's validated event is the input
 * here, not the output: an event has to be legal before its safety is worth
 * assessing, and it has to pass here as well before anything applies it.
 *
 * This module decides and hands back a value. It does not apply events, award
 * points, advance time or write history, and it never changes the state, the
 * definition, or the event. Execution stays with the engine.
 *
 * A `SafetyClearedEvent` can only be obtained from `validateSafety`. It stands
 * for one specific validated event, which the engine has in turn bound to one
 * specific game state, so a clearance cannot be carried over to a different
 * event or a different state.
 */

declare const clearedBrand: unique symbol;

/**
 * An event that passed the safety policy.
 *
 * It shows what was cleared and why. It does not expose the engine's validated
 * event: the only way to get that back, in order to apply it, is
 * `releaseClearedEvent`, which refuses anything this module did not issue.
 */
export interface SafetyClearedEvent {
  readonly event: ExternalGameEvent;
  /** The game it was cleared for. */
  readonly gameId: string;
  readonly verdict: SafetyVerdict;
  readonly [clearedBrand]: true;
}

export type SafetyRejection =
  /** The event was assessed and is not allowed. `verdict` says why. */
  | { readonly kind: 'UNSAFE'; readonly verdict: SafetyVerdict }
  /** The input could not be assessed at all. Nothing was cleared. */
  | { readonly kind: 'NOT_EVALUATED'; readonly reason: string };

/** Every clearance this module has issued, with the validated event it stands for. */
const issued = new WeakMap<
  SafetyClearedEvent,
  { readonly validated: ValidatedGameEvent; readonly fingerprint: string }
>();

const fingerprintOf = (event: unknown): string => JSON.stringify(event);

/**
 * Assesses an engine-validated event against the safety policy of its game.
 *
 * The policy is derived here from the registered definition the engine validated
 * the event under, never taken from the caller; `options` can only make it
 * stricter. Anything that is not
 * `allow` is returned as UNSAFE. Input that cannot be assessed — an object the
 * engine did not issue, a different game, a state that names a different game
 * definition, an unknown game — is NOT_EVALUATED.
 * In neither case is anything cleared.
 */
export function validateSafety(
  validated: ValidatedGameEvent,
  state: GameState,
  options: PolicyOptions = {},
): Result<SafetyClearedEvent, SafetyRejection> {
  if (!isValidatedGameEvent(validated)) {
    return err({
      kind: 'NOT_EVALUATED',
      reason: 'The event was not validated by the game engine.',
    });
  }
  if (validated.gameId !== state.id) {
    return err({ kind: 'NOT_EVALUATED', reason: 'The event was validated for a different game.' });
  }
  // The policy comes from the definition the engine validated the event under.
  // A state that names another game cannot select that game's policy instead.
  if (validated.definitionId !== state.gameId) {
    return err({
      kind: 'NOT_EVALUATED',
      reason: 'The event was validated under a different game definition.',
    });
  }
  const definition = findGameDefinition(validated.definitionId);
  if (!definition) {
    return err({
      kind: 'NOT_EVALUATED',
      reason: `No game definition for "${validated.definitionId}".`,
    });
  }

  const verdict = assessEventSafety(validated.event, policyFor(definition, options));
  if (verdict.disposition !== 'allow') return err({ kind: 'UNSAFE', verdict });

  const cleared = Object.freeze({
    event: validated.event,
    gameId: validated.gameId,
    verdict,
  }) as SafetyClearedEvent;
  issued.set(cleared, { validated, fingerprint: fingerprintOf(validated.event) });
  return ok(cleared);
}

/**
 * Returns the engine's validated event behind a clearance, so that the engine
 * can apply it.
 *
 * It refuses an object this module did not issue, including a copy or one built
 * to look the same, and it refuses a clearance whose event no longer reads as it
 * did when it was assessed.
 */
export function releaseClearedEvent(
  cleared: SafetyClearedEvent,
): Result<ValidatedGameEvent, SafetyRejection> {
  const record = issued.get(cleared);
  if (!record) {
    return err({
      kind: 'NOT_EVALUATED',
      reason: 'This event was not cleared by the safety validator.',
    });
  }
  if (fingerprintOf(record.validated.event) !== record.fingerprint) {
    return err({
      kind: 'NOT_EVALUATED',
      reason: 'The event has changed since it was safety checked.',
    });
  }
  return ok(record.validated);
}
