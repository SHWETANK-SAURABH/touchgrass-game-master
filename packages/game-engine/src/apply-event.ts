import { type Result, ok } from '@touchgrass/shared';
import type { GameDefinition } from '@touchgrass/game-definitions';
import type { EngineError } from './errors';
import type { GameEvent } from './events';
import { applyAwards, awardsForEvent } from './scoring';
import type { GameState, HistorySource } from './state';
import { validateGameEvent } from './validate';
import { evaluateWinners } from './win-conditions';

/**
 * Event application.
 *
 * `applyEvent` is where gameplay changes happen: scores, roles once play has
 * begun, who is out, what is in force, rounds and the timer. It takes a state and
 * a game event and returns the next state, or a refusal. It is a pure function:
 * the time and the id of the history entry are passed in, and nothing else is
 * read.
 *
 * Every event is validated first, whoever produced it. Then, in order:
 *
 *   1. the event's own change is made (round, timer, roles, modifiers, ...)
 *   2. the points that follow from it are added (scoring.ts)
 *   3. if the game has ended, the winners are decided (win-conditions.ts)
 *   4. the event is appended to history, with the awards it caused
 */

/** Non-deterministic inputs, supplied by the caller rather than read ambiently. */
export interface EngineContext {
  /** The engine's clock for this step, in epoch ms. */
  readonly now: number;
  /** Id generator for history entries. Injected so replay produces stable ids. */
  readonly nextEntryId: (sequence: number) => string;
}

const seconds = (value: number): number => value * 1000;

/** The event's own state change, without scoring, winners, or history. */
function transition(state: GameState, event: GameEvent, at: number, entryId: string): GameState {
  switch (event.type) {
    case 'ROUND_START':
      return {
        ...state,
        status: 'active',
        currentRound: event.round,
        timer: { endsAt: at + seconds(event.durationSeconds), pausedAt: null },
        // Players who were out last round are back in for this one.
        players: state.players.map((player) =>
          player.status === 'out' ? { ...player, status: 'active' as const } : player,
        ),
      };

    case 'ROUND_END':
      return { ...state, status: 'round_end', timer: { endsAt: null, pausedAt: null } };

    case 'GAME_END':
      return {
        ...state,
        status: 'completed',
        endedAt: at,
        timer: { endsAt: null, pausedAt: null },
      };

    case 'ZONE_CHANGE':
      return {
        ...state,
        activeModifiers: [
          ...state.activeModifiers,
          {
            id: entryId,
            kind: event.modifier,
            zone: event.zone,
            expiresAt: at + seconds(event.durationSeconds),
          },
        ],
      };

    case 'RULE_MODIFIER':
      return {
        ...state,
        activeModifiers: [
          ...state.activeModifiers,
          {
            id: entryId,
            kind: event.modifier,
            roleIds: event.roleIds,
            expiresAt: at + seconds(event.durationSeconds),
          },
        ],
      };

    case 'CHALLENGE':
      return {
        ...state,
        activeObjectives: [
          ...state.activeObjectives,
          {
            id: event.challengeId,
            source: 'CHALLENGE',
            description: event.description,
            points: event.points,
            eligiblePlayerIds: event.playerIds,
            completedByPlayerIds: [],
            expiresAt: at + seconds(event.durationSeconds),
          },
        ],
      };

    case 'BONUS_OBJECTIVE':
      return {
        ...state,
        activeObjectives: [
          ...state.activeObjectives,
          {
            id: event.objectiveId,
            source: 'BONUS_OBJECTIVE',
            description: event.description,
            points: event.points,
            eligiblePlayerIds: [],
            completedByPlayerIds: [],
            expiresAt: at + seconds(event.durationSeconds),
          },
        ],
      };

    case 'OBJECTIVE_COMPLETED':
      return {
        ...state,
        activeObjectives: state.activeObjectives.map((objective) =>
          objective.id === event.objectiveId
            ? {
                ...objective,
                completedByPlayerIds: [...objective.completedByPlayerIds, event.playerId],
              }
            : objective,
        ),
      };

    case 'POWER_UP':
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === event.playerId
            ? { ...player, powers: [...player.powers, event.powerId] }
            : player,
        ),
      };

    case 'POWER_ACTIVATED':
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === event.playerId
            ? { ...player, powers: player.powers.filter((powerId) => powerId !== event.powerId) }
            : player,
        ),
        activeModifiers: [
          ...state.activeModifiers,
          {
            id: entryId,
            kind: 'TEMPORARY_POWER_UP',
            playerId: event.playerId,
            powerId: event.powerId,
            expiresAt: at + seconds(event.durationSeconds),
          },
        ],
      };

    case 'TIME_EXTENSION':
      return {
        ...state,
        timer: {
          ...state.timer,
          endsAt: state.timer.endsAt === null ? null : state.timer.endsAt + seconds(event.seconds),
        },
      };

    case 'ROLE_CHANGE': {
      const next = new Map(event.assignments.map((entry) => [entry.playerId, entry.roleId]));
      return {
        ...state,
        players: state.players.map((player) =>
          next.has(player.id) ? { ...player, roleId: next.get(player.id) ?? null } : player,
        ),
      };
    }

    case 'PLAYER_OUT':
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === event.playerId ? { ...player, status: 'out' as const } : player,
        ),
      };
  }
}

function nameOf(state: GameState, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.displayName ?? playerId;
}

/** A one-line description of an event, safe to show players. */
function summarise(state: GameState, event: GameEvent): string {
  switch (event.type) {
    case 'ROUND_START':
      return `Round ${event.round} started (${event.durationSeconds}s).`;
    case 'ROUND_END':
      return `Round ${event.round} ended.`;
    case 'GAME_END':
      return 'Game over.';
    case 'ZONE_CHANGE':
      return event.modifier === 'SAFE_ZONE'
        ? `Safe zone: ${event.zone} (${event.durationSeconds}s).`
        : `The play area is now ${event.zone} (${event.durationSeconds}s).`;
    case 'RULE_MODIFIER':
      return `Freeze period for ${event.roleIds.join(', ')} (${event.durationSeconds}s).`;
    case 'CHALLENGE':
      return `Challenge: ${event.description}`;
    case 'BONUS_OBJECTIVE':
      return `Bonus objective: ${event.description}`;
    case 'OBJECTIVE_COMPLETED':
      return `${nameOf(state, event.playerId)} completed "${event.objectiveId}".`;
    case 'POWER_UP':
      return `${nameOf(state, event.playerId)} received ${event.powerId}.`;
    case 'POWER_ACTIVATED':
      return `${nameOf(state, event.playerId)} activated ${event.powerId} (${event.durationSeconds}s).`;
    case 'TIME_EXTENSION':
      return `${event.seconds}s added to the round.`;
    case 'ROLE_CHANGE':
      return event.cause
        ? `${nameOf(state, event.cause.byPlayerId)} ${event.cause.reason === 'TAGGED' ? 'tagged' : 'found'} ${nameOf(state, event.cause.targetPlayerId)}.`
        : `Roles changed: ${event.assignments
            .map((entry) => `${nameOf(state, entry.playerId)} is now ${entry.roleId}`)
            .join(', ')}.`;
    case 'PLAYER_OUT':
      return `${nameOf(state, event.byPlayerId)} ${event.reason === 'TAGGED' ? 'tagged' : 'found'} ${nameOf(state, event.playerId)}, who is out for the round.`;
  }
}

export function applyEvent(
  state: GameState,
  definition: GameDefinition,
  event: GameEvent,
  source: HistorySource,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const validated = validateGameEvent(event, definition, state);
  if (!validated.ok) return validated;

  const sequence = state.history.length;
  const entryId = ctx.nextEntryId(sequence);

  // Awards are read from the state before the event changes it: who held which
  // role and who was still in when the round ended.
  const awards = awardsForEvent(definition, state, event);
  const changed = transition(state, event, ctx.now, entryId);
  const scored = { ...changed, players: applyAwards(changed.players, awards) };
  const decided =
    event.type === 'GAME_END'
      ? { ...scored, winnerIds: evaluateWinners(definition, scored) }
      : scored;

  return ok({
    ...decided,
    history: [
      ...state.history,
      {
        id: entryId,
        sequence,
        at: ctx.now,
        source,
        summary: summarise(state, event),
        record: { kind: 'EVENT', event },
        ...(awards.length > 0 ? { awards } : {}),
      },
    ],
  });
}
