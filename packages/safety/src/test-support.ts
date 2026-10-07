import { fixedClock } from '@touchgrass/shared';
import {
  type EngineContext,
  type ExternalGameEvent,
  type GameState,
  type ValidatedGameEvent,
  contextAt,
  createSession,
  processPlayerAction,
  reduce,
  validateExternalEvent,
} from '@touchgrass/game-engine';

/**
 * Helpers for the safety tests. Not exported from the package.
 *
 * The engine is used here, in test code, to build a running game and to obtain
 * genuine validated events to assess. The safety modules themselves never apply
 * anything.
 */

export const T0 = 1_700_000_000_000;
export const NOW = 61_000;

export function at(ms: number): EngineContext {
  return contextAt(fixedClock(T0 + ms));
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A three-player game with round 1 running since T0 + 1s. */
export function runningState(gameId: 'tag' | 'hide-and-seek' = 'tag', sessionId = 'g1'): GameState {
  let state = unwrap(
    createSession(
      { type: 'CREATE_SESSION', sessionId, gameId, joinCode: 'GRASS7', randomSeed: 7 },
      at(0),
    ),
  );
  for (const index of [0, 1, 2]) {
    state = unwrap(
      reduce(
        state,
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  for (const player of state.players) {
    state = unwrap(
      processPlayerAction(state, { type: 'PLAYER_READY', playerId: player.id }, at(1_000)),
    );
  }
  return state;
}

/** An event the engine has validated against `state`. */
export function validatedFor(state: GameState, event: unknown, ms = NOW): ValidatedGameEvent {
  return unwrap(validateExternalEvent(state, event, 'game-master', at(ms)));
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const zoneEvent = (zone: string): ExternalGameEvent => ({
  type: 'ZONE_CHANGE',
  modifier: 'SAFE_ZONE',
  zone,
  durationSeconds: 60,
});

export const objectiveEvent = (
  description: string,
  overrides: { objectiveId?: string; durationSeconds?: number } = {},
): ExternalGameEvent => ({
  type: 'BONUS_OBJECTIVE',
  objectiveId: overrides.objectiveId ?? 'o1',
  description,
  points: 2,
  durationSeconds: overrides.durationSeconds ?? 60,
});

export const challengeEvent = (description: string, challengeId = 'c1'): ExternalGameEvent => ({
  type: 'CHALLENGE',
  challengeId,
  description,
  playerIds: ['p0'],
  points: 2,
  durationSeconds: 60,
});
