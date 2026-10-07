import { err, ok, type Result } from '@touchgrass/shared';
import {
  type GameDefinition,
  type GameRule,
  isLifecycleEventKind,
  permitsActionKind,
  permitsEventKind,
  permitsModifier,
} from '@touchgrass/game-definitions';
import type { PlayerAction } from './actions';
import { type EngineError, engineError } from './errors';
import type { GameEvent } from './events';
import {
  type GameState,
  type GameStatus,
  type PlayerState,
  findPlayer,
  isTerminalStatus,
} from './state';

/**
 * Domain validation.
 *
 * Zod has already confirmed an action or event is well formed. These functions
 * answer the questions a schema cannot: does that player exist in this game,
 * does this game support that event, is the game in a status where it makes
 * sense. They read state and return a verdict; they never change anything.
 *
 * Every event is validated here before it is applied, including the ones the
 * engine produces itself.
 */

/** Statuses in which each lifecycle event may arrive. Every other event needs a running round. */
const LIFECYCLE_EVENT_STATUSES: Readonly<Record<string, readonly GameStatus[]>> = {
  ROUND_START: ['starting', 'round_end'],
  ROUND_END: ['active'],
  GAME_END: ['round_end'],
};

function ended(state: GameState): EngineError {
  return engineError('GAME_ALREADY_COMPLETED', `Game "${state.id}" has ended.`, {
    status: state.status,
  });
}

function wrongStatus(state: GameState, what: string, allowed: readonly GameStatus[]): EngineError {
  return engineError(
    'INVALID_STATE_TRANSITION',
    `${what} is only possible while the game is ${allowed.join(' or ')}; it is "${state.status}".`,
    { status: state.status, allowed: [...allowed] },
  );
}

/** A player who is in the game and has not left it. */
function presentPlayer(state: GameState, playerId: string): Result<PlayerState, EngineError> {
  const player = findPlayer(state, playerId);
  if (!player || player.status === 'left') {
    return err(
      engineError('INVALID_PLAYER', `Player "${playerId}" is not in this game.`, { playerId }),
    );
  }
  return ok(player);
}

/** A player who is in the game and not out for the round. */
function playingPlayer(state: GameState, playerId: string): Result<PlayerState, EngineError> {
  const player = presentPlayer(state, playerId);
  if (!player.ok) return player;
  if (player.value.status !== 'active') {
    return err(
      engineError('INVALID_ACTION', `${player.value.displayName} is out for this round.`, {
        playerId,
      }),
    );
  }
  return player;
}

function knownRole(definition: GameDefinition, roleId: string): EngineError | undefined {
  if (definition.roles.some((role) => role.id === roleId)) return undefined;
  return engineError('INVALID_ROLE', `${definition.name} has no role "${roleId}".`, { roleId });
}

const ACTION_BY_REASON = { TAGGED: 'PLAYER_TAGGED', FOUND: 'PLAYER_FOUND' } as const;

/** The rule that lets `actor` do this to `target`, if the game has one. */
export function findRule(
  definition: GameDefinition,
  action: GameRule['action'],
  actor: PlayerState,
  target: PlayerState,
): GameRule | undefined {
  return definition.rules.find(
    (rule) =>
      rule.action === action &&
      rule.actorRoleId === actor.roleId &&
      rule.targetRoleId === target.roleId,
  );
}

function noRule(action: string, actor: PlayerState, target: PlayerState): EngineError {
  return engineError(
    'INVALID_ROLE',
    `A ${actor.roleId ?? 'player with no role'} cannot report ${action} against a ${target.roleId ?? 'player with no role'}.`,
    { actorRoleId: actor.roleId, targetRoleId: target.roleId },
  );
}

/** Refuses a role change that would break a role's declared minimum or maximum. */
function roleCountsAfter(
  definition: GameDefinition,
  state: GameState,
  assignments: readonly { playerId: string; roleId: string }[],
): EngineError | undefined {
  const present = state.players.filter((player) => player.status !== 'left');
  const count = (roleOf: (player: PlayerState) => string | null, roleId: string): number =>
    present.filter((player) => roleOf(player) === roleId).length;
  const next = new Map(assignments.map((entry) => [entry.playerId, entry.roleId]));

  for (const role of definition.roles) {
    const before = count((player) => player.roleId, role.id);
    const after = count((player) => next.get(player.id) ?? player.roleId, role.id);
    const aboveMax = role.max !== undefined && after > role.max;
    const newlyBelowMin = after < role.min && after < before;
    if (aboveMax || newlyBelowMin) {
      return engineError(
        'INVALID_ROLE',
        `The change would leave ${after} ${role.label}; ${definition.name} needs ${role.min}${role.max === undefined ? ' or more' : ` to ${role.max}`}.`,
        { roleId: role.id, after, min: role.min, max: role.max },
      );
    }
  }
  return undefined;
}

/** Checks that an event is legal for this game in its current state. */
export function validateGameEvent(
  event: GameEvent,
  definition: GameDefinition,
  state: GameState,
): Result<GameEvent, EngineError> {
  if (isTerminalStatus(state.status)) return err(ended(state));

  if (!permitsEventKind(definition, event.type)) {
    return err(
      engineError('UNSUPPORTED_EVENT', `${definition.name} does not support ${event.type}.`, {
        type: event.type,
        gameId: definition.id,
      }),
    );
  }

  const allowed = isLifecycleEventKind(event.type)
    ? (LIFECYCLE_EVENT_STATUSES[event.type] ?? [])
    : (['active'] as const);
  if (!allowed.includes(state.status)) return err(wrongStatus(state, event.type, allowed));

  switch (event.type) {
    case 'ROUND_START': {
      if (event.round !== state.currentRound + 1 || event.round > state.settings.totalRounds) {
        return err(
          engineError('INVALID_EVENT', `Round ${event.round} cannot start now.`, {
            currentRound: state.currentRound,
            totalRounds: state.settings.totalRounds,
          }),
        );
      }
      return ok(event);
    }

    case 'ROUND_END': {
      if (event.round !== state.currentRound) {
        return err(
          engineError('INVALID_EVENT', `Round ${event.round} is not the running round.`, {
            currentRound: state.currentRound,
          }),
        );
      }
      return ok(event);
    }

    case 'GAME_END': {
      if (state.currentRound < state.settings.totalRounds) {
        return err(
          engineError('INVALID_EVENT', 'The game cannot end before its last round has.', {
            currentRound: state.currentRound,
            totalRounds: state.settings.totalRounds,
          }),
        );
      }
      return ok(event);
    }

    case 'ZONE_CHANGE':
    case 'RULE_MODIFIER': {
      if (!permitsModifier(definition, event.modifier)) {
        return err(
          engineError('INVALID_MODIFIER', `${definition.name} does not allow ${event.modifier}.`, {
            modifier: event.modifier,
          }),
        );
      }
      if (event.type === 'RULE_MODIFIER') {
        for (const roleId of event.roleIds) {
          const problem = knownRole(definition, roleId);
          if (problem) return err(problem);
        }
      }
      return ok(event);
    }

    case 'CHALLENGE': {
      for (const playerId of event.playerIds) {
        const player = presentPlayer(state, playerId);
        if (!player.ok) return player;
      }
      if (state.activeObjectives.some((objective) => objective.id === event.challengeId)) {
        return err(
          engineError('INVALID_EVENT', `Challenge "${event.challengeId}" is already active.`, {
            challengeId: event.challengeId,
          }),
        );
      }
      return ok(event);
    }

    case 'BONUS_OBJECTIVE': {
      if (state.activeObjectives.some((objective) => objective.id === event.objectiveId)) {
        return err(
          engineError('INVALID_EVENT', `Objective "${event.objectiveId}" is already active.`, {
            objectiveId: event.objectiveId,
          }),
        );
      }
      return ok(event);
    }

    case 'POWER_UP': {
      const player = presentPlayer(state, event.playerId);
      if (!player.ok) return player;
      if (!definition.powers.some((power) => power.id === event.powerId)) {
        return err(
          engineError('INVALID_EVENT', `${definition.name} has no power "${event.powerId}".`, {
            powerId: event.powerId,
          }),
        );
      }
      const inUse = state.activeModifiers.some(
        (modifier) =>
          modifier.kind === 'TEMPORARY_POWER_UP' &&
          modifier.playerId === event.playerId &&
          modifier.powerId === event.powerId,
      );
      if (inUse || player.value.powers.includes(event.powerId)) {
        return err(
          engineError(
            'INVALID_EVENT',
            `${player.value.displayName} already has "${event.powerId}".`,
            { playerId: event.playerId, powerId: event.powerId },
          ),
        );
      }
      return ok(event);
    }

    case 'ROLE_CHANGE': {
      for (const assignment of event.assignments) {
        const player = presentPlayer(state, assignment.playerId);
        if (!player.ok) return player;
        const problem = knownRole(definition, assignment.roleId);
        if (problem) return err(problem);
      }

      if (event.cause) {
        // A caused role change must be exactly what a rule of this game produces.
        const actor = presentPlayer(state, event.cause.byPlayerId);
        if (!actor.ok) return actor;
        const target = presentPlayer(state, event.cause.targetPlayerId);
        if (!target.ok) return target;
        const action = ACTION_BY_REASON[event.cause.reason];
        const rule = findRule(definition, action, actor.value, target.value);
        if (rule?.outcome !== 'SWAP_ROLES') {
          return err(noRule(action, actor.value, target.value));
        }
        const swapped =
          event.assignments.length === 2 &&
          event.assignments.some(
            (entry) => entry.playerId === actor.value.id && entry.roleId === rule.targetRoleId,
          ) &&
          event.assignments.some(
            (entry) => entry.playerId === target.value.id && entry.roleId === rule.actorRoleId,
          );
        if (!swapped) {
          return err(
            engineError('INVALID_EVENT', 'The role change does not match the rule that caused it.'),
          );
        }
      }

      const problem = roleCountsAfter(definition, state, event.assignments);
      return problem ? err(problem) : ok(event);
    }

    case 'PLAYER_OUT': {
      const actor = presentPlayer(state, event.byPlayerId);
      if (!actor.ok) return actor;
      const target = playingPlayer(state, event.playerId);
      if (!target.ok) {
        // An event naming a player who is already out is a bad event, not a bad action.
        return target.error.code === 'INVALID_ACTION'
          ? err(engineError('INVALID_EVENT', target.error.message, target.error.context))
          : target;
      }
      const action = ACTION_BY_REASON[event.reason];
      const rule = findRule(definition, action, actor.value, target.value);
      if (rule?.outcome !== 'TARGET_OUT') return err(noRule(action, actor.value, target.value));
      return ok(event);
    }

    case 'POWER_ACTIVATED': {
      const player = presentPlayer(state, event.playerId);
      if (!player.ok) return player;
      const power = definition.powers.find((candidate) => candidate.id === event.powerId);
      if (
        !power ||
        !player.value.powers.includes(event.powerId) ||
        power.durationSeconds !== event.durationSeconds
      ) {
        return err(
          engineError(
            'INVALID_EVENT',
            `${player.value.displayName} cannot activate "${event.powerId}".`,
            { playerId: event.playerId, powerId: event.powerId },
          ),
        );
      }
      return ok(event);
    }

    case 'OBJECTIVE_COMPLETED': {
      const player = presentPlayer(state, event.playerId);
      if (!player.ok) return player;
      const objective = state.activeObjectives.find(
        (candidate) => candidate.id === event.objectiveId,
      );
      const eligible =
        objective !== undefined &&
        (objective.eligiblePlayerIds.length === 0 ||
          objective.eligiblePlayerIds.includes(event.playerId)) &&
        !objective.completedByPlayerIds.includes(event.playerId);
      if (!eligible || objective.points !== event.points) {
        return err(
          engineError(
            'INVALID_EVENT',
            `${player.value.displayName} cannot complete "${event.objectiveId}".`,
            { playerId: event.playerId, objectiveId: event.objectiveId },
          ),
        );
      }
      return ok(event);
    }

    case 'TIME_EXTENSION':
      return ok(event);
  }
}

/**
 * Checks that a player may take this action in this game right now.
 *
 * `now` is the engine's clock value. It is needed to tell whether a power or an
 * objective is still in force; nothing here reads a clock itself.
 */
export function validatePlayerAction(
  action: PlayerAction,
  definition: GameDefinition,
  state: GameState,
  now: number,
): Result<PlayerAction, EngineError> {
  if (isTerminalStatus(state.status)) return err(ended(state));

  if (!permitsActionKind(definition, action.type)) {
    return err(
      engineError('INVALID_ACTION', `${definition.name} has no ${action.type} action.`, {
        type: action.type,
        gameId: definition.id,
      }),
    );
  }

  const present = presentPlayer(state, action.playerId);
  if (!present.ok) return present;

  if (action.type === 'PLAYER_READY') {
    return state.status === 'lobby' ? ok(action) : err(wrongStatus(state, action.type, ['lobby']));
  }

  if (state.status !== 'active') return err(wrongStatus(state, action.type, ['active']));

  const actor = playingPlayer(state, action.playerId);
  if (!actor.ok) return actor;

  switch (action.type) {
    case 'PLAYER_TAGGED':
    case 'PLAYER_FOUND': {
      const target = playingPlayer(state, action.targetPlayerId);
      if (!target.ok) return target;
      if (!findRule(definition, action.type, actor.value, target.value)) {
        return err(noRule(action.type, actor.value, target.value));
      }
      if (action.type === 'PLAYER_TAGGED' && isImmune(definition, state, target.value.id, now)) {
        return err(
          engineError('INVALID_ACTION', `${target.value.displayName} is shielded.`, {
            playerId: target.value.id,
          }),
        );
      }
      return ok(action);
    }

    case 'PLAYER_ACTIVATED_POWER': {
      if (!actor.value.powers.includes(action.powerId)) {
        return err(
          engineError(
            'INVALID_ACTION',
            `${actor.value.displayName} does not hold "${action.powerId}".`,
            { powerId: action.powerId },
          ),
        );
      }
      return ok(action);
    }

    case 'PLAYER_COMPLETED_CHALLENGE': {
      const objective = state.activeObjectives.find(
        (candidate) => candidate.id === action.challengeId && candidate.expiresAt > now,
      );
      if (!objective) {
        return err(
          engineError('INVALID_ACTION', `No active challenge "${action.challengeId}".`, {
            challengeId: action.challengeId,
          }),
        );
      }
      const eligible =
        objective.eligiblePlayerIds.length === 0 ||
        objective.eligiblePlayerIds.includes(action.playerId);
      if (!eligible || objective.completedByPlayerIds.includes(action.playerId)) {
        return err(
          engineError(
            'INVALID_ACTION',
            `${actor.value.displayName} cannot complete "${action.challengeId}".`,
            { challengeId: action.challengeId, eligible },
          ),
        );
      }
      return ok(action);
    }

    case 'PLAYER_ACCEPTED_EVENT': {
      const entry = state.history.find((candidate) => candidate.id === action.eventId);
      if (entry?.record.kind !== 'EVENT') {
        return err(
          engineError('INVALID_ACTION', `No event "${action.eventId}" in this game's history.`, {
            eventId: action.eventId,
          }),
        );
      }
      return ok(action);
    }
  }
}

/** True while the player has an activated power whose effect is TAG_IMMUNITY. */
export function isImmune(
  definition: GameDefinition,
  state: GameState,
  playerId: string,
  now: number,
): boolean {
  return state.activeModifiers.some(
    (modifier) =>
      modifier.kind === 'TEMPORARY_POWER_UP' &&
      modifier.playerId === playerId &&
      modifier.expiresAt > now &&
      definition.powers.some(
        (power) => power.id === modifier.powerId && power.effect === 'TAG_IMMUNITY',
      ),
  );
}
