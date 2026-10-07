import { type Result, err, ok } from '@touchgrass/shared';
import { getGameDefinition } from '@touchgrass/game-definitions';
import { type EngineContext, applyEvent } from './apply-event';
import { type EngineError, engineError } from './errors';
import type { GameState } from './state';

/**
 * Deterministic time.
 *
 * The engine has no timers and never reads a clock. Time passes only when a
 * caller tells it what time it is, through `ctx.now`. `advanceTime` then does
 * everything that should have happened by that moment, in order:
 *
 *   while the running round's end time has been reached:
 *     ROUND_END  (round scoring happens as it is applied)
 *     if there are more rounds: ROUND_START for the next one
 *     otherwise:                GAME_END  (winners are decided as it is applied)
 *   then drop modifiers and objectives whose time is up
 *
 * Each of those events is stamped with the moment it was due, not the moment the
 * caller happened to notice. So advancing in one large step or many small ones
 * produces exactly the same state, and a test can run a whole game by supplying
 * clock values.
 *
 * Every other entry point (commands, actions, external events) calls this first,
 * so nothing is ever processed against a round that has already run out.
 */

/** The latest time the state has already seen. Time may not move backwards past it. */
function lastSeen(state: GameState): number {
  return state.history.at(-1)?.at ?? state.createdAt;
}

export function advanceTime(state: GameState, ctx: EngineContext): Result<GameState, EngineError> {
  if (ctx.now < lastSeen(state)) {
    return err(
      engineError('INVALID_STATE_TRANSITION', 'Time cannot move backwards.', {
        now: ctx.now,
        lastSeen: lastSeen(state),
      }),
    );
  }

  // A paused game's clock is frozen; a game that has not started or has ended has none.
  if (state.status !== 'active') return ok(state);

  const definition = getGameDefinition(state.gameId);
  let current = state;

  while (
    current.status === 'active' &&
    current.timer.endsAt !== null &&
    current.timer.endsAt <= ctx.now
  ) {
    const due: EngineContext = { now: current.timer.endsAt, nextEntryId: ctx.nextEntryId };

    const ended = applyEvent(
      current,
      definition,
      { type: 'ROUND_END', round: current.currentRound },
      'engine',
      due,
    );
    if (!ended.ok) return ended;
    current = ended.value;

    const next =
      current.currentRound < current.settings.totalRounds
        ? applyEvent(
            current,
            definition,
            {
              type: 'ROUND_START',
              round: current.currentRound + 1,
              durationSeconds: current.settings.roundDurationSeconds,
            },
            'engine',
            due,
          )
        : applyEvent(
            current,
            definition,
            { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
            'engine',
            due,
          );
    if (!next.ok) return next;
    current = next.value;
  }

  return ok(dropExpired(current, ctx.now));
}

/** Removes modifiers and objectives whose expiry has passed. */
function dropExpired(state: GameState, now: number): GameState {
  const activeModifiers = state.activeModifiers.filter((modifier) => modifier.expiresAt > now);
  const activeObjectives = state.activeObjectives.filter((objective) => objective.expiresAt > now);
  if (
    activeModifiers.length === state.activeModifiers.length &&
    activeObjectives.length === state.activeObjectives.length
  ) {
    return state;
  }
  return { ...state, activeModifiers, activeObjectives };
}
