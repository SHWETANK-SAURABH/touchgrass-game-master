import { type Result, err, ok } from '@touchgrass/shared';
import { findGameDefinition, isOptionalEventKind } from '@touchgrass/game-definitions';
import { type EngineContext, applyEvent } from './apply-event';
import { type EngineError, engineError } from './errors';
import { type ExternalGameEvent, externalGameEventSchema, parseGameEvent } from './events';
import type { GameState, HistoryEntry } from './state';
import { advanceTime } from './time';
import { validateGameEvent } from './validate';

/**
 * The trust boundary for events that come from outside the engine.
 *
 *   untrusted input
 *     → schema validation          (is it a well-formed event?)
 *     → external-kind check        (is it a kind an outsider may send at all?)
 *     → state-aware validation     (is it legal in this game, right now?)
 *     → ValidatedGameEvent
 *     → applyValidatedEvent        (the engine applies it)
 *
 * Schema-valid does not mean game-valid. A model can produce a perfectly formed
 * POWER_UP for a player who is not in the game, or a ROLE_CHANGE to a role the
 * game does not have. Only the second and third steps catch those, and they use
 * the same rules as every other event the engine applies (validate.ts) — there
 * is no separate ruleset for AI proposals.
 *
 * A `ValidatedGameEvent` can only be obtained from `validateExternalEvent`. It is
 * tied to the state it was validated against, so it cannot be replayed against a
 * different game, a different branch of the same game, or a later state. Nothing
 * is ever repaired or guessed: an event that names something that does not exist
 * is refused.
 *
 * The game definition is always the registered one for `state.gameId`. A caller
 * cannot supply its own, so a modified copy of a definition cannot widen what
 * the engine accepts.
 *
 * "Validated" here means legal in the game. It does not mean safe: no safety
 * check exists in the engine, and none has been applied to a validated event.
 */

/** Where an external event came from. Recorded in history. */
export type ExternalEventSource = 'human' | 'game-master';

declare const validatedBrand: unique symbol;

/**
 * An external event the engine has checked against a particular game state.
 *
 * The brand cannot be named outside this module, and every genuine value is
 * also registered in a private set, so a look-alike object — even one built with
 * a type assertion — is refused by `applyValidatedEvent`.
 */
export interface ValidatedGameEvent {
  readonly event: ExternalGameEvent;
  readonly source: ExternalEventSource;
  /** The game it was validated for. */
  readonly gameId: string;
  /** The id of the game definition whose rules it was validated under. */
  readonly definitionId: string;
  /** The length of that game's history at validation. */
  readonly historyLength: number;
  readonly [validatedBrand]: true;
}

/**
 * Every validated event this module has issued, with the last history entry of
 * the state it was checked against. That entry object is the anchor: a state is
 * the one the event was validated for only if its history still ends with that
 * very entry. Two states of the same game with equally long histories that
 * diverged do not share it, and neither does a state rebuilt from JSON.
 */
const issued = new WeakMap<ValidatedGameEvent, { readonly anchor: HistoryEntry | undefined }>();

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * True for a value this module issued. It reveals nothing and changes nothing;
 * it lets a later stage (the safety boundary) refuse a look-alike before doing
 * any work on it.
 */
export function isValidatedGameEvent(value: unknown): value is ValidatedGameEvent {
  return typeof value === 'object' && value !== null && issued.has(value as ValidatedGameEvent);
}

function unknownGame(state: GameState): EngineError {
  return engineError('INVALID_GAME_CONFIGURATION', `No game definition for "${state.gameId}".`, {
    gameId: state.gameId,
  });
}

/**
 * Checks untrusted input as an external event for this game, as it stands at
 * `ctx.now`. Reads the state and changes nothing.
 */
export function validateExternalEvent(
  state: GameState,
  input: unknown,
  source: ExternalEventSource,
  ctx: EngineContext,
): Result<ValidatedGameEvent, EngineError> {
  const definition = findGameDefinition(state.gameId);
  if (!definition) return err(unknownGame(state));

  const parsed = parseGameEvent(input);
  if (!parsed.ok) return parsed;
  const event = parsed.value;

  // Lifecycle events and the events derived from player actions belong to the
  // engine. An outside event may not claim a cause either — otherwise it could
  // award itself the points of a tag.
  if (!isOptionalEventKind(event.type)) {
    return err(
      engineError('UNSUPPORTED_EVENT', `${event.type} can only be produced by the engine.`, {
        type: event.type,
      }),
    );
  }
  if (event.type === 'ROLE_CHANGE' && event.cause) {
    return err(
      engineError('INVALID_EVENT', 'An external ROLE_CHANGE may not carry a cause.', {
        type: event.type,
      }),
    );
  }
  // The two checks above give the precise refusals. Parsing with the external
  // schema then yields the narrower type without an assertion.
  const external = externalGameEventSchema.safeParse(event);
  if (!external.success) {
    return err(engineError('INVALID_EVENT', `${event.type} is not a valid external event.`));
  }

  // Validate against the game as it is at this moment: a round that has run out
  // is closed first, so an event is never accepted for a round that is over.
  const current = advanceTime(state, ctx);
  if (!current.ok) return current;

  const valid = validateGameEvent(external.data, definition, current.value);
  if (!valid.ok) return valid;

  const validated = Object.freeze({
    // Frozen all the way down: the event cannot be edited between being checked
    // and being applied.
    event: deepFreeze(external.data),
    source,
    gameId: state.id,
    definitionId: definition.id,
    historyLength: current.value.history.length,
  }) as ValidatedGameEvent;
  issued.set(validated, { anchor: current.value.history.at(-1) });
  return ok(validated);
}

/**
 * Applies an event that `validateExternalEvent` accepted.
 *
 * It refuses anything that was not issued by that function, and anything issued
 * for another game, for a different branch of the same game, or for a state that
 * has since moved on. A state restored from storage counts as a different state:
 * validate again after loading. The event is then
 * validated again as it is applied, like every event: the engine has the last
 * word. On a refusal the caller's state is untouched.
 */
export function applyValidatedEvent(
  state: GameState,
  validated: ValidatedGameEvent,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const record = issued.get(validated);
  if (!record) {
    return err(
      engineError(
        'INVALID_EVENT',
        'This event was not validated by the engine and cannot be applied.',
      ),
    );
  }
  if (validated.gameId !== state.id) {
    return err(
      engineError('INVALID_EVENT', 'This event was validated for a different game.', {
        validatedFor: validated.gameId,
        gameId: state.id,
      }),
    );
  }

  const definition = findGameDefinition(state.gameId);
  if (!definition) return err(unknownGame(state));

  const current = advanceTime(state, ctx);
  if (!current.ok) return current;
  if (
    current.value.history.length !== validated.historyLength ||
    current.value.history.at(-1) !== record.anchor
  ) {
    return err(
      engineError(
        'INVALID_EVENT',
        'The game has changed since this event was validated. Validate it again.',
        { validatedAt: validated.historyLength, now: current.value.history.length },
      ),
    );
  }

  return applyEvent(current.value, definition, validated.event, validated.source, ctx);
}
