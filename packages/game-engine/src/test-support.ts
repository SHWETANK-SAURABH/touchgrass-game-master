import { type Result, fixedClock } from '@touchgrass/shared';
import type { EngineContext } from './apply-event';
import { contextAt } from './engine';
import type { EngineError } from './errors';
import { processPlayerAction } from './process-action';
import { createSession, reduce } from './reduce';
import type { GameState } from './state';

/**
 * Helpers shared by the engine's tests. Not exported from the package.
 *
 * Time in tests is always a fixed clock at `T0 + ms`. Nothing here, and nothing
 * in the engine, reads the real clock.
 */

export const T0 = 1_700_000_000_000;

/** An engine context at `ms` milliseconds after T0. */
export function at(ms: number): EngineContext {
  return contextAt(fixedClock(T0 + ms));
}

/** Unwraps a result the test expects to succeed. */
export function must<T>(result: Result<T, EngineError>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The error code of a result the test expects to fail, or 'ok'. */
export function codeOf<T>(result: Result<T, EngineError>): string {
  return result.ok ? 'ok' : result.error.code;
}

export type TestGameId = 'tag' | 'hide-and-seek';

/** A lobby with players p0..p(n-1), created at T0. Nobody is ready. */
export function lobby(gameId: TestGameId, playerCount: number, randomSeed = 7): GameState {
  let state = must(
    createSession(
      { type: 'CREATE_SESSION', sessionId: 'g1', gameId, joinCode: 'GRASS7', randomSeed },
      at(0),
    ),
  );
  for (let index = 0; index < playerCount; index += 1) {
    state = must(
      reduce(
        state,
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  return state;
}

/** When `started()` games begin their first round, in ms after T0. */
export const START = 1_000;

/** A game whose players have all reported ready at START, so round 1 is running. */
export function started(gameId: TestGameId, playerCount: number, randomSeed = 7): GameState {
  let state = lobby(gameId, playerCount, randomSeed);
  for (const player of state.players) {
    state = must(
      processPlayerAction(state, { type: 'PLAYER_READY', playerId: player.id }, at(START)),
    );
  }
  return state;
}

/** Ids of the present players holding a role, in join order. */
export function holders(state: GameState, roleId: string): string[] {
  return state.players
    .filter((player) => player.status !== 'left' && player.roleId === roleId)
    .map((player) => player.id);
}

export function scoreOf(state: GameState, playerId: string): number {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`no player ${playerId}`);
  return player.score;
}

/** The event types applied so far, in order. */
export function eventTypes(state: GameState): string[] {
  return state.history.flatMap((entry) =>
    entry.record.kind === 'EVENT' ? [entry.record.event.type] : [],
  );
}
