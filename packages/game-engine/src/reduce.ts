import { err, ok, type Result } from '@touchgrass/shared';
import { getGameDefinition, findGameDefinition } from '@touchgrass/game-definitions';
import type { EngineContext } from './apply-event';
import type { CreateSessionCommand, SessionCommand } from './commands';
import { type EngineError, engineError } from './errors';
import {
  type GameState,
  type GameStatus,
  type HistoryEntry,
  type HistorySource,
  type PlayerState,
  isTerminalStatus,
} from './state';
import { advanceTime } from './time';

/**
 * Host commands.
 *
 * `reduce` handles the session-level operations: players joining and leaving,
 * phases, pause, resume, abort. It is a pure function of (state, command,
 * context). Gameplay does not go through here: player actions are handled in
 * process-action.ts and game events in apply-event.ts.
 *
 * Like every entry point, it first brings the state up to the supplied time, so
 * a command never acts on a round that has already run out.
 */

function appendHistory(
  state: GameState,
  ctx: EngineContext,
  entry: {
    source: HistorySource;
    command: SessionCommand['type'] | 'CREATE_SESSION';
    summary: string;
    detail?: Record<string, unknown>;
  },
): HistoryEntry[] {
  const sequence = state.history.length;
  return [
    ...state.history,
    {
      id: ctx.nextEntryId(sequence),
      sequence,
      at: ctx.now,
      source: entry.source,
      summary: entry.summary,
      record: {
        kind: 'COMMAND',
        command: entry.command,
        ...(entry.detail ? { detail: entry.detail } : {}),
      },
    },
  ];
}

function wrongStatus(state: GameState, expected: readonly GameStatus[]): EngineError {
  return engineError(
    'INVALID_STATE_TRANSITION',
    `Command requires status ${expected.join(' or ')}, but the game is "${state.status}".`,
    { status: state.status, expected: [...expected] },
  );
}

/** Creates a game in the lobby, with the settings of its definition. */
export function createSession(
  command: CreateSessionCommand,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const definition = findGameDefinition(command.gameId);
  if (!definition) {
    return err(
      engineError('INVALID_GAME_CONFIGURATION', `No game definition for id "${command.gameId}".`, {
        gameId: command.gameId,
      }),
    );
  }

  const base: GameState = {
    id: command.sessionId,
    gameId: definition.id,
    joinCode: command.joinCode,
    status: 'lobby',
    phaseIndex: 0,
    settings: definition.settings,
    currentRound: 0,
    timer: { endsAt: null, pausedAt: null },
    players: [],
    activeModifiers: [],
    activeObjectives: [],
    history: [],
    winnerIds: [],
    createdAt: ctx.now,
    startedAt: null,
    endedAt: null,
    randomSeed: command.randomSeed,
  };

  return ok({
    ...base,
    history: appendHistory(base, ctx, {
      source: 'engine',
      command: 'CREATE_SESSION',
      summary: `Session opened for ${definition.name}. Join code ${command.joinCode}.`,
      detail: { gameId: definition.id },
    }),
  });
}

export function reduce(
  input: GameState,
  command: SessionCommand,
  ctx: EngineContext,
): Result<GameState, EngineError> {
  const advanced = advanceTime(input, ctx);
  if (!advanced.ok) return advanced;
  const state = advanced.value;

  if (isTerminalStatus(state.status)) {
    return err(
      engineError(
        'GAME_ALREADY_COMPLETED',
        `Game "${state.id}" has ended and accepts no more commands.`,
        { status: state.status },
      ),
    );
  }

  const definition = getGameDefinition(state.gameId);

  switch (command.type) {
    case 'ADD_PLAYER': {
      if (state.status !== 'lobby') {
        return err(
          engineError('GAME_ALREADY_STARTED', `Game "${state.id}" has already started.`, {
            status: state.status,
          }),
        );
      }
      if (state.players.some((player) => player.id === command.playerId)) {
        return err(
          engineError('DUPLICATE_PLAYER', `Player "${command.playerId}" is already in the lobby.`, {
            playerId: command.playerId,
          }),
        );
      }
      const present = state.players.filter((player) => player.status !== 'left');
      if (present.length >= definition.maxPlayers) {
        return err(
          engineError(
            'PLAYER_LIMIT_EXCEEDED',
            `${definition.name} is full at ${definition.maxPlayers} players.`,
            { max: definition.maxPlayers },
          ),
        );
      }

      const player: PlayerState = {
        id: command.playerId,
        displayName: command.displayName,
        roleId: null,
        score: 0,
        status: 'active',
        ready: false,
        powers: [],
        joinedAt: ctx.now,
      };
      return ok({
        ...state,
        players: [...state.players, player],
        history: appendHistory(state, ctx, {
          source: 'human',
          command: 'ADD_PLAYER',
          summary: `${command.displayName} joined.`,
          detail: { playerId: command.playerId },
        }),
      });
    }

    case 'REMOVE_PLAYER': {
      const player = state.players.find((candidate) => candidate.id === command.playerId);
      if (!player || player.status === 'left') {
        return err(
          engineError('INVALID_PLAYER', `No player "${command.playerId}" in this game.`, {
            playerId: command.playerId,
          }),
        );
      }
      // Marked as left rather than deleted: removing the record would make the
      // history unreadable and would erase a score that other entries refer to.
      return ok({
        ...state,
        players: state.players.map((candidate) =>
          candidate.id === command.playerId ? { ...candidate, status: 'left' as const } : candidate,
        ),
        history: appendHistory(state, ctx, {
          source: 'human',
          command: 'REMOVE_PLAYER',
          summary: `${player.displayName} left.`,
          detail: { playerId: command.playerId },
        }),
      });
    }

    case 'ADVANCE_PHASE': {
      if (state.status !== 'active') return err(wrongStatus(state, ['active']));
      const nextIndex = state.phaseIndex + 1;
      const nextPhase = definition.phases[nextIndex];
      if (!nextPhase) {
        return err(
          engineError(
            'INVALID_PHASE',
            `${definition.name} has no phase after "${definition.phases[state.phaseIndex]?.id ?? 'unknown'}".`,
            { phaseIndex: state.phaseIndex },
          ),
        );
      }
      return ok({
        ...state,
        phaseIndex: nextIndex,
        history: appendHistory(state, ctx, {
          source: 'human',
          command: 'ADVANCE_PHASE',
          summary: `Phase: ${nextPhase.label}.`,
          detail: { phaseId: nextPhase.id, phaseIndex: nextIndex },
        }),
      });
    }

    case 'PAUSE_SESSION': {
      if (state.status !== 'active') return err(wrongStatus(state, ['active']));
      // The clock stops here. `endsAt` and every expiry are left as they are and
      // moved forward by the length of the pause when the game resumes.
      return ok({
        ...state,
        status: 'paused',
        timer: { ...state.timer, pausedAt: ctx.now },
        history: appendHistory(state, ctx, {
          source: 'human',
          command: 'PAUSE_SESSION',
          summary: `Paused: ${command.reason}`,
          detail: { reason: command.reason },
        }),
      });
    }

    case 'RESUME_SESSION': {
      if (state.status !== 'paused' || state.timer.pausedAt === null) {
        return err(wrongStatus(state, ['paused']));
      }
      const pausedFor = ctx.now - state.timer.pausedAt;
      return ok({
        ...state,
        status: 'active',
        timer: {
          endsAt: state.timer.endsAt === null ? null : state.timer.endsAt + pausedFor,
          pausedAt: null,
        },
        activeModifiers: state.activeModifiers.map((modifier) => ({
          ...modifier,
          expiresAt: modifier.expiresAt + pausedFor,
        })),
        activeObjectives: state.activeObjectives.map((objective) => ({
          ...objective,
          expiresAt: objective.expiresAt + pausedFor,
        })),
        history: appendHistory(state, ctx, {
          source: 'human',
          command: 'RESUME_SESSION',
          summary: 'Resumed.',
          detail: { pausedForMs: pausedFor },
        }),
      });
    }

    case 'ABORT_SESSION': {
      // Legal from any non-terminal status, including the lobby and a pause.
      // Stopping a game must never be blocked by a state check.
      return ok({
        ...state,
        status: 'aborted',
        endedAt: ctx.now,
        timer: { endsAt: null, pausedAt: null },
        history: appendHistory(state, ctx, {
          source: 'human',
          command: 'ABORT_SESSION',
          summary: `Stopped: ${command.reason}`,
          detail: { reason: command.reason },
        }),
      });
    }
  }
}
