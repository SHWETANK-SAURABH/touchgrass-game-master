import type { GameDefinition } from '@touchgrass/game-definitions';
import { EVENT_LIMITS, type GameState } from '@touchgrass/game-engine';

/**
 * What the Game Master is given, and what it is shown.
 *
 * The input is typed: the engine's `GameState`, the `GameDefinition` being
 * played, and the current time. From those, `buildGameMasterView` derives the
 * compact, read-only view that goes into the prompt. The model never receives
 * the state object itself and has no handle on it; it sees a description.
 */

export interface GameMasterContext {
  /** The game as the engine currently holds it. Read, never changed. */
  readonly state: GameState;
  /** The definition of the game being played. Must match `state.gameId`. */
  readonly definition: GameDefinition;
  /** The engine's clock value, epoch ms. Used only to express times as seconds. */
  readonly now: number;
  /** How many of the latest history entries to show. Default 10. */
  readonly recentHistoryLimit?: number;
}

export interface GameMasterView {
  readonly game: { readonly id: string; readonly name: string; readonly summary: string };
  readonly round: {
    readonly current: number;
    readonly total: number;
    readonly secondsRemaining: number | null;
  };
  readonly roles: readonly {
    readonly id: string;
    readonly label: string;
    readonly min: number;
    readonly max: number | null;
  }[];
  readonly players: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string | null;
    readonly score: number;
    readonly status: string;
    readonly heldPowers: readonly string[];
  }[];
  readonly inForce: {
    readonly modifiers: readonly {
      readonly kind: string;
      readonly detail: string;
      readonly secondsRemaining: number;
    }[];
    readonly objectives: readonly {
      readonly id: string;
      readonly description: string;
      readonly points: number;
      readonly secondsRemaining: number;
    }[];
  };
  readonly recentHistory: readonly {
    readonly secondsAgo: number;
    readonly source: string;
    readonly summary: string;
  }[];
  readonly allowed: {
    readonly eventKinds: readonly string[];
    readonly modifiers: readonly string[];
    readonly powers: readonly {
      readonly id: string;
      readonly label: string;
      readonly description: string;
    }[];
  };
  readonly limits: typeof EVENT_LIMITS;
  readonly guidance: { readonly persona: string; readonly avoid: readonly string[] };
}

const secondsBetween = (from: number, to: number): number =>
  Math.max(0, Math.round((to - from) / 1000));

export function buildGameMasterView(context: GameMasterContext): GameMasterView {
  const { state, definition, now } = context;
  const limit = context.recentHistoryLimit ?? 10;

  return {
    game: { id: definition.id, name: definition.name, summary: definition.tagline },
    round: {
      current: state.currentRound,
      total: state.settings.totalRounds,
      secondsRemaining:
        state.timer.endsAt === null ? null : secondsBetween(now, state.timer.endsAt),
    },
    roles: definition.roles.map((role) => ({
      id: role.id,
      label: role.label,
      min: role.min,
      max: role.max ?? null,
    })),
    players: state.players
      .filter((player) => player.status !== 'left')
      .map((player) => ({
        id: player.id,
        name: player.displayName,
        role: player.roleId,
        score: player.score,
        status: player.status,
        heldPowers: player.powers,
      })),
    inForce: {
      modifiers: state.activeModifiers
        .filter((modifier) => modifier.expiresAt > now)
        .map((modifier) => ({
          kind: modifier.kind,
          detail:
            modifier.kind === 'SAFE_ZONE' || modifier.kind === 'MOVING_ZONE'
              ? modifier.zone
              : modifier.kind === 'FREEZE_PERIOD'
                ? `roles: ${modifier.roleIds.join(', ')}`
                : `${modifier.powerId} used by ${modifier.playerId}`,
          secondsRemaining: secondsBetween(now, modifier.expiresAt),
        })),
      objectives: state.activeObjectives
        .filter((objective) => objective.expiresAt > now)
        .map((objective) => ({
          id: objective.id,
          description: objective.description,
          points: objective.points,
          secondsRemaining: secondsBetween(now, objective.expiresAt),
        })),
    },
    recentHistory: state.history.slice(-limit).map((entry) => ({
      secondsAgo: secondsBetween(entry.at, now),
      source: entry.source,
      summary: entry.summary,
    })),
    allowed: {
      eventKinds: definition.allowedEventKinds,
      modifiers: definition.allowedModifiers,
      powers: definition.powers.map((power) => ({
        id: power.id,
        label: power.label,
        description: power.description,
      })),
    },
    limits: EVENT_LIMITS,
    guidance: {
      persona: definition.gameMaster.persona,
      avoid: definition.gameMaster.avoid,
    },
  };
}
