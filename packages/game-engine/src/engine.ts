import { type Clock, type Result, err, ok } from '@touchgrass/shared';
import { getGameDefinition, isOptionalEventKind } from '@touchgrass/game-definitions';
import { type EngineContext, applyEvent } from './apply-event';
import type { CreateSessionCommand, SessionCommand } from './commands';
import { type EngineError, engineError } from './errors';
import { parseGameEvent } from './events';
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
 *   an external event → submitGameEvent
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
 * Applies a game event that came from outside the engine: a host today, the
 * Game Master in a later phase. The input is untrusted.
 *
 * Only the optional event kinds are accepted. Lifecycle events and the events
 * derived from player actions belong to the engine, and an outside event may not
 * claim a cause — otherwise it could award itself the points of a tag.
 */
export function submitGameEvent(
  state: GameState,
  input: unknown,
  source: 'human' | 'game-master',
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const parsed = parseGameEvent(input);
  if (!parsed.ok) return parsed;
  const event = parsed.value;

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

  const advanced = advanceTime(state, ctx);
  if (!advanced.ok) return advanced;
  return applyEvent(advanced.value, getGameDefinition(state.gameId), event, source, ctx);
}

/** One input to a game. Actions and events are untrusted and validated on the way in. */
export type EngineInput =
  | { readonly type: 'COMMAND'; readonly command: SessionCommand }
  | { readonly type: 'ACTION'; readonly action: unknown }
  | {
      readonly type: 'EVENT';
      readonly event: unknown;
      readonly source: 'human' | 'game-master';
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
