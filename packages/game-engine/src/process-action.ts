import { type Result, createRng, ok } from '@touchgrass/shared';
import { type GameDefinition, getGameDefinition } from '@touchgrass/game-definitions';
import { type PlayerAction, parsePlayerAction } from './actions';
import { type EngineContext, applyEvent } from './apply-event';
import type { EngineError } from './errors';
import type { GameEvent } from './events';
import { assignRoles } from './roles';
import { type GameState, type HistoryEntry, findPlayer } from './state';
import { advanceTime } from './time';
import { findRule, validatePlayerAction } from './validate';

/**
 * Action processing.
 *
 *   PlayerAction → validation → the events it causes → event application
 *
 * An action is a player's report. This module decides what a valid report means
 * by turning it into game events, using the rules in the game definition. It
 * never edits scores, roles or statuses itself: those change only when the
 * events are applied.
 *
 * Two actions are control actions and cause no event:
 *  - PLAYER_READY marks the player ready, and starts the game once everyone is.
 *  - PLAYER_ACCEPTED_EVENT is recorded as an acknowledgement and changes nothing.
 */

const REASON_BY_ACTION = { PLAYER_TAGGED: 'TAGGED', PLAYER_FOUND: 'FOUND' } as const;

/** The events a validated action causes. Pure: reads state, changes nothing. */
export function eventsForAction(
  action: PlayerAction,
  definition: GameDefinition,
  state: GameState,
): GameEvent[] {
  switch (action.type) {
    case 'PLAYER_TAGGED':
    case 'PLAYER_FOUND': {
      const actor = findPlayer(state, action.playerId);
      const target = findPlayer(state, action.targetPlayerId);
      const rule = actor && target ? findRule(definition, action.type, actor, target) : undefined;
      if (!actor || !target || !rule) return [];
      const reason = REASON_BY_ACTION[action.type];

      if (rule.outcome === 'SWAP_ROLES') {
        return [
          {
            type: 'ROLE_CHANGE',
            assignments: [
              { playerId: target.id, roleId: rule.actorRoleId },
              { playerId: actor.id, roleId: rule.targetRoleId },
            ],
            cause: { reason, byPlayerId: actor.id, targetPlayerId: target.id },
          },
        ];
      }
      return [{ type: 'PLAYER_OUT', playerId: target.id, byPlayerId: actor.id, reason }];
    }

    case 'PLAYER_ACTIVATED_POWER': {
      const power = definition.powers.find((candidate) => candidate.id === action.powerId);
      if (!power) return [];
      return [
        {
          type: 'POWER_ACTIVATED',
          playerId: action.playerId,
          powerId: power.id,
          durationSeconds: power.durationSeconds,
        },
      ];
    }

    case 'PLAYER_COMPLETED_CHALLENGE': {
      const objective = state.activeObjectives.find(
        (candidate) => candidate.id === action.challengeId,
      );
      if (!objective) return [];
      return [
        {
          type: 'OBJECTIVE_COMPLETED',
          playerId: action.playerId,
          objectiveId: objective.id,
          points: objective.points,
        },
      ];
    }

    case 'PLAYER_READY':
    case 'PLAYER_ACCEPTED_EVENT':
      return [];
  }
}

function describe(action: PlayerAction, state: GameState): string {
  const name = (playerId: string): string => findPlayer(state, playerId)?.displayName ?? playerId;
  switch (action.type) {
    case 'PLAYER_READY':
      return `${name(action.playerId)} is ready.`;
    case 'PLAYER_TAGGED':
      return `${name(action.playerId)} reported tagging ${name(action.targetPlayerId)}.`;
    case 'PLAYER_FOUND':
      return `${name(action.playerId)} reported finding ${name(action.targetPlayerId)}.`;
    case 'PLAYER_ACTIVATED_POWER':
      return `${name(action.playerId)} used ${action.powerId}.`;
    case 'PLAYER_COMPLETED_CHALLENGE':
      return `${name(action.playerId)} reported completing "${action.challengeId}".`;
    case 'PLAYER_ACCEPTED_EVENT':
      return `${name(action.playerId)} acknowledged ${action.eventId}.`;
  }
}

function entry(
  state: GameState,
  ctx: EngineContext,
  fields: Pick<HistoryEntry, 'source' | 'summary' | 'record'>,
): HistoryEntry {
  const sequence = state.history.length;
  return { id: ctx.nextEntryId(sequence), sequence, at: ctx.now, ...fields };
}

/** Everyone present is ready, and there are enough of them to play. */
function readyToStart(definition: GameDefinition, state: GameState): boolean {
  const present = state.players.filter((player) => player.status !== 'left');
  return present.length >= definition.minPlayers && present.every((player) => player.ready);
}

/**
 * lobby → starting → active.
 *
 * Roles are assigned from the seed stored in the state, which moves the game to
 * `starting`; the first ROUND_START then makes it `active`. Both happen in the
 * same step, so no further input is needed once the last player is ready.
 */
function beginGame(
  state: GameState,
  definition: GameDefinition,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const present = state.players.filter((player) => player.status !== 'left');
  const assignment = assignRoles(
    definition,
    present.map((player) => player.id),
    createRng(state.randomSeed),
  );
  if (!assignment.ok) return assignment;

  const roles = Object.fromEntries(assignment.value);
  const players = state.players.map((player) => ({
    ...player,
    roleId: assignment.value.get(player.id) ?? null,
  }));
  const roleSummary = definition.roles
    .map((role) => `${players.filter((player) => player.roleId === role.id).length} ${role.label}`)
    .join(', ');

  const starting: GameState = {
    ...state,
    status: 'starting',
    startedAt: ctx.now,
    players,
    history: [
      ...state.history,
      entry(state, ctx, {
        source: 'engine',
        summary: `${definition.name} is starting: ${roleSummary}.`,
        record: { kind: 'ROLES_ASSIGNED', roles },
      }),
    ],
  };

  return applyEvent(
    starting,
    definition,
    { type: 'ROUND_START', round: 1, durationSeconds: starting.settings.roundDurationSeconds },
    'engine',
    ctx,
  );
}

/**
 * Takes an action from a client, as untrusted input, and returns the next state
 * or a refusal. On a refusal the caller's state is unchanged.
 */
export function processPlayerAction(
  state: GameState,
  input: unknown,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const parsed = parsePlayerAction(input);
  if (!parsed.ok) return parsed;
  const action = parsed.value;

  const advanced = advanceTime(state, ctx);
  if (!advanced.ok) return advanced;
  const definition = getGameDefinition(state.gameId);

  const valid = validatePlayerAction(action, definition, advanced.value, ctx.now);
  if (!valid.ok) return valid;

  // Record the accepted action. PLAYER_READY also sets the player's ready flag,
  // which is the one change an action makes without an event.
  let current: GameState = {
    ...advanced.value,
    players:
      action.type === 'PLAYER_READY'
        ? advanced.value.players.map((player) =>
            player.id === action.playerId ? { ...player, ready: true } : player,
          )
        : advanced.value.players,
    history: [
      ...advanced.value.history,
      entry(advanced.value, ctx, {
        source: 'human',
        summary: describe(action, advanced.value),
        record: { kind: 'ACTION', action },
      }),
    ],
  };

  for (const event of eventsForAction(action, definition, current)) {
    const applied = applyEvent(current, definition, event, 'engine', ctx);
    if (!applied.ok) return applied;
    current = applied.value;
  }

  if (action.type === 'PLAYER_READY' && readyToStart(definition, current)) {
    return beginGame(current, definition, ctx);
  }
  return ok(current);
}
