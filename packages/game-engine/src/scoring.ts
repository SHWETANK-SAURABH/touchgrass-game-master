import { z } from 'zod';
import {
  SCORING_TRIGGERS,
  type GameDefinition,
  type ScoringTrigger,
} from '@touchgrass/game-definitions';
import type { GameEvent } from './events';
import type { GameState, PlayerState } from './state';

/**
 * Scoring.
 *
 * Points are never an input. They are a consequence the engine computes when an
 * event is applied: a tag, a find, a completed objective, the end of a round.
 * How many points each is worth comes from the game definition; a trigger a
 * definition does not list is worth nothing in that game.
 *
 * There is no event that says "change this score", so nothing outside the engine
 * — a client, a model — has a way to ask for points. Every award is recorded on
 * the history entry of the event that caused it, with its reason.
 */

/** Why points were awarded: a definition's scoring trigger, or a completed objective. */
export const SCORE_REASONS = [...SCORING_TRIGGERS, 'OBJECTIVE_COMPLETED'] as const;

export const scoreAwardSchema = z
  .object({
    playerId: z.string().min(1),
    reason: z.enum(SCORE_REASONS),
    /** Always positive: the engine never takes points away. */
    points: z.int().min(1),
  })
  .strict();
export type ScoreAward = z.infer<typeof scoreAwardSchema>;

/** Points a definition gives for a trigger, or 0 if it does not score it. */
export function pointsFor(definition: GameDefinition, trigger: ScoringTrigger): number {
  return definition.scoring.find((rule) => rule.trigger === trigger)?.points ?? 0;
}

function award(
  definition: GameDefinition,
  playerId: string,
  trigger: ScoringTrigger,
): ScoreAward[] {
  const points = pointsFor(definition, trigger);
  return points > 0 ? [{ playerId, reason: trigger, points }] : [];
}

const TRIGGER_BY_REASON = { TAGGED: 'TAG_MADE', FOUND: 'FOUND_PLAYER' } as const;

/** Ids of players who were the target of a tag since the current round started. */
function taggedThisRound(state: GameState): Set<string> {
  const tagged = new Set<string>();
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const record = state.history[index]?.record;
    if (record?.kind !== 'EVENT') continue;
    if (record.event.type === 'ROUND_START') break;
    if (record.event.type === 'ROLE_CHANGE' && record.event.cause?.reason === 'TAGGED') {
      tagged.add(record.event.cause.targetPlayerId);
    }
  }
  return tagged;
}

/**
 * Awards made when a round ends, read from the state as it stands at that moment.
 *
 * For each rule of the game:
 *  - SWAP_ROLES (Tag): every player holding the target role who was not tagged
 *    during the round gets ROUND_SURVIVED.
 *  - TARGET_OUT (Hide & Seek): every target-role player who is not out gets
 *    STAYED_HIDDEN; if all of them are out, each actor-role player gets ALL_FOUND.
 */
function roundEndAwards(definition: GameDefinition, state: GameState): ScoreAward[] {
  const present = state.players.filter((player) => player.status !== 'left');
  const awards: ScoreAward[] = [];

  for (const rule of definition.rules) {
    const targets = present.filter((player) => player.roleId === rule.targetRoleId);

    if (rule.outcome === 'SWAP_ROLES') {
      const tagged = taggedThisRound(state);
      for (const player of targets) {
        if (player.status === 'active' && !tagged.has(player.id)) {
          awards.push(...award(definition, player.id, 'ROUND_SURVIVED'));
        }
      }
      continue;
    }

    const stillIn = targets.filter((player) => player.status === 'active');
    for (const player of stillIn) {
      awards.push(...award(definition, player.id, 'STAYED_HIDDEN'));
    }
    if (targets.length > 0 && stillIn.length === 0) {
      for (const player of present.filter((candidate) => candidate.roleId === rule.actorRoleId)) {
        awards.push(...award(definition, player.id, 'ALL_FOUND'));
      }
    }
  }
  return awards;
}

/**
 * The awards that follow from applying `event` to `state`. `state` is the state
 * before the event is applied.
 */
export function awardsForEvent(
  definition: GameDefinition,
  state: GameState,
  event: GameEvent,
): ScoreAward[] {
  switch (event.type) {
    case 'ROLE_CHANGE':
      return event.cause
        ? award(definition, event.cause.byPlayerId, TRIGGER_BY_REASON[event.cause.reason])
        : [];
    case 'PLAYER_OUT':
      return award(definition, event.byPlayerId, TRIGGER_BY_REASON[event.reason]);
    case 'OBJECTIVE_COMPLETED':
      return [{ playerId: event.playerId, reason: 'OBJECTIVE_COMPLETED', points: event.points }];
    case 'ROUND_END':
      return roundEndAwards(definition, state);
    case 'ROUND_START':
    case 'ZONE_CHANGE':
    case 'CHALLENGE':
    case 'POWER_UP':
    case 'RULE_MODIFIER':
    case 'BONUS_OBJECTIVE':
    case 'TIME_EXTENSION':
    case 'GAME_END':
    case 'POWER_ACTIVATED':
      return [];
  }
}

/** Adds awards to scores. Awards are positive, so a score can only grow. */
export function applyAwards(
  players: readonly PlayerState[],
  awards: readonly ScoreAward[],
): PlayerState[] {
  return players.map((player) => {
    const gained = awards
      .filter((entry) => entry.playerId === player.id)
      .reduce((sum, entry) => sum + entry.points, 0);
    return gained > 0 ? { ...player, score: player.score + gained } : player;
  });
}
