import { type Clock, type Result, ok } from '@touchgrass/shared';
import type { EngineContext } from './apply-event';
import type { CreateSessionCommand, SessionCommand } from './commands';
import type { EngineError } from './errors';
import {
  type ExternalEventSource,
  applyValidatedEvent,
  validateExternalEvent,
} from './external-events';
import { processPlayerAction } from './process-action';
import { createSession, reduce } from './reduce';
import type { GameState } from './state';
import { advanceTime } from './time';

/**
 * The engine's entry points.
 *
 * Four things can be given to a game, and each is a pure function of the state,
 * the input, and the supplied time:
 *
 *   a host command    → reduce
 *   a player action   → processPlayerAction
 *   an external event → validateExternalEvent, then applyValidatedEvent
 *                       (or submitGameEvent, which does both)
 *   the time          → advanceTime
 *
 * `step` dispatches between them, and `replay` runs a recorded list of inputs
 * from the beginning. Because nothing here reads a clock or a random source,
 * replaying the same inputs always rebuilds the same state.
 */

/** History entry ids derived from the sequence number alone, so they are reproducible. */
export const sequentialEntryId = (sequence: number): string => `entry-${sequence}`;

/** Builds a context from a Clock (see @touchgrass/shared). The clock is read once, here. */
export function contextAt(clock: Clock): EngineContext {
  return { now: clock.now(), nextEntryId: sequentialEntryId };
}

/**
 * Validates and applies an external event in one call: `validateExternalEvent`
 * followed by `applyValidatedEvent`. The input is untrusted. Callers that need to
 * see the validated event before it is applied use those two functions directly.
 */
export function submitGameEvent(
  state: GameState,
  input: unknown,
  source: ExternalEventSource,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const validated = validateExternalEvent(state, input, source, ctx);
  if (!validated.ok) return validated;
  return applyValidatedEvent(state, validated.value, ctx);
}

/** One input to a game. Actions and events are untrusted and validated on the way in. */
export type EngineInput =
  | { readonly type: 'COMMAND'; readonly command: SessionCommand }
  | { readonly type: 'ACTION'; readonly action: unknown }
  | {
      readonly type: 'EVENT';
      readonly event: unknown;
      readonly source: ExternalEventSource;
    }
  | { readonly type: 'ADVANCE_TIME' };

export function step(
  state: GameState,
  input: EngineInput,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  switch (input.type) {
    case 'COMMAND':
      return reduce(state, input.command, ctx);
    case 'ACTION':
      return processPlayerAction(state, input.action, ctx);
    case 'EVENT':
      return submitGameEvent(state, input.event, input.source, ctx);
    case 'ADVANCE_TIME':
      return advanceTime(state, ctx);
  }
}

/** A recorded input and the time it arrived. */
export interface TimedInput {
  readonly at: number;
  readonly input: EngineInput;
}

/**
 * Rebuilds a game from its creation and a list of timed inputs. Stops at the
 * first refusal. Running it twice on the same inputs gives identical states.
 */
export function replay(
  create: CreateSessionCommand,
  createdAt: number,
  inputs: readonly TimedInput[],
  nextEntryId: (sequence: number) => string = sequentialEntryId,
): Result<GameState, EngineError> {
  const created = createSession(create, { now: createdAt, nextEntryId });
  if (!created.ok) return created;

  let state = created.value;
  for (const { at, input } of inputs) {
    const next = step(state, input, { now: at, nextEntryId });
    if (!next.ok) return next;
    state = next.value;
  }
  return ok(state);
}
