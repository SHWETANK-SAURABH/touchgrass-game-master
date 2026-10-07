import { createRng, err, ok, type Result } from '@touchgrass/shared';
import { getGameDefinition, findGameDefinition } from '@touchgrass/game-definitions';
import type { EngineCommand } from './commands';
import { type EngineError, engineError } from './errors';
import { assignRoles } from './roles';
import type { LogEntry, Player, SessionState, SessionStatus, EventSource } from './state';

/**
 * The deterministic core.
 *
 * `reduce` is a pure function. Given the same state and the same command with the
 * same context, it returns the same next state — every time, on every host. No
 * clock reads, no `Math.random()`, no I/O, no imports from the AI package.
 *
 * That purity is the product's central safety claim made structural: the model
 * can propose whatever it likes, but the only thing that can move a session is
 * this function, and this function is small enough to read in one sitting and
 * covered by tests that pin its behaviour.
 */

/** Non-deterministic inputs, supplied by the caller rather than read ambiently. */
export interface EngineContext {
  /** Wall clock for this command, in epoch ms. */
  readonly now: number;
  /** Id generator for log entries. Injected so tests and replay produce stable ids. */
  readonly nextEntryId: (sequence: number) => string;
}

/** Statuses in which the session accepts gameplay commands. */
const RUNNING: readonly SessionStatus[] = ['active'];
const TERMINAL: readonly SessionStatus[] = ['completed', 'aborted'];

function appendLog(
  state: SessionState,
  ctx: EngineContext,
  entry: { source: EventSource; type: string; summary: string; detail?: Record<string, unknown> },
): LogEntry[] {
  const sequence = state.log.length;
  return [
    ...state.log,
    {
      id: ctx.nextEntryId(sequence),
      sequence,
      at: ctx.now,
      source: entry.source,
      type: entry.type,
      summary: entry.summary,
      ...(entry.detail ? { detail: entry.detail } : {}),
    },
  ];
}

function wrongStatus(state: SessionState, expected: readonly SessionStatus[]): EngineError {
  return engineError(
    'WRONG_STATUS',
    `Command requires status ${expected.join(' or ')}, but the session is "${state.status}".`,
    { status: state.status, expected: [...expected] },
  );
}

/**
 * Creates a session. Separate from `reduce` because there is no prior state to
 * reduce from, and because it is the one place that validates the game id.
 */
export function createSession(
  command: Extract<EngineCommand, { type: 'CREATE_SESSION' }>,
  ctx: EngineContext,
): Result<SessionState, EngineError> {
  const definition = findGameDefinition(command.gameId);
  if (!definition) {
    return err(
      engineError('UNKNOWN_GAME', `No game definition for id "${command.gameId}".`, {
        gameId: command.gameId,
      }),
    );
  }

  const base: SessionState = {
    id: command.sessionId,
    gameId: definition.id,
    joinCode: command.joinCode,
    status: 'lobby',
    phaseIndex: 0,
    players: [],
    modifiers: [],
    log: [],
    createdAt: ctx.now,
    startedAt: null,
    endedAt: null,
    randomSeed: command.randomSeed,
  };

  return ok({
    ...base,
    log: appendLog(base, ctx, {
      source: 'engine',
      type: 'CREATE_SESSION',
      summary: `Session opened for ${definition.name}. Join code ${command.joinCode}.`,
      detail: { gameId: definition.id },
    }),
  });
}

export function reduce(
  state: SessionState,
  command: Exclude<EngineCommand, { type: 'CREATE_SESSION' }>,
  ctx: EngineContext,
): Result<SessionState, EngineError> {
  if (TERMINAL.includes(state.status)) {
    return err(
      engineError('WRONG_STATUS', `Session "${state.id}" has ended and accepts no more commands.`, {
        status: state.status,
      }),
    );
  }

  const definition = getGameDefinition(state.gameId);

  switch (command.type) {
    case 'ADD_PLAYER': {
      if (state.status !== 'lobby') return err(wrongStatus(state, ['lobby']));
      if (state.players.some((player) => player.id === command.playerId)) {
        return err(
          engineError('DUPLICATE_PLAYER', `Player "${command.playerId}" is already in the lobby.`, {
            playerId: command.playerId,
          }),
        );
      }
      if (state.players.length >= definition.maxPlayers) {
        return err(
          engineError(
            'SESSION_FULL',
            `${definition.name} is full at ${definition.maxPlayers} players.`,
            { max: definition.maxPlayers },
          ),
        );
      }

      const player: Player = {
        id: command.playerId,
        displayName: command.displayName,
        roleId: null,
        score: 0,
        joinedAt: ctx.now,
        active: true,
      };
      return ok({
        ...state,
        players: [...state.players, player],
        log: appendLog(state, ctx, {
          source: 'human',
          type: 'ADD_PLAYER',
          summary: `${command.displayName} joined.`,
          detail: { playerId: command.playerId },
        }),
      });
    }

    case 'REMOVE_PLAYER': {
      const player = state.players.find((candidate) => candidate.id === command.playerId);
      if (!player) {
        return err(
          engineError('UNKNOWN_PLAYER', `No player "${command.playerId}" in this session.`, {
            playerId: command.playerId,
          }),
        );
      }
      // Marked inactive rather than deleted: removing the record would make the
      // log unreadable and would erase a score that other entries refer to.
      return ok({
        ...state,
        players: state.players.map((candidate) =>
          candidate.id === command.playerId ? { ...candidate, active: false } : candidate,
        ),
        log: appendLog(state, ctx, {
          source: 'human',
          type: 'REMOVE_PLAYER',
          summary: `${player.displayName} left.`,
          detail: { playerId: command.playerId },
        }),
      });
    }

    case 'START_SESSION': {
      if (state.status !== 'lobby') return err(wrongStatus(state, ['lobby']));

      const present = state.players.filter((player) => player.active);
      const assignment = assignRoles(
        definition,
        present.map((player) => player.id),
        createRng(state.randomSeed),
      );
      if (!assignment.ok) return assignment;

      const players = state.players.map((player) => ({
        ...player,
        roleId: assignment.value.get(player.id) ?? null,
      }));
      const roleSummary = definition.roles
        .map((role) => {
          const count = players.filter((player) => player.roleId === role.id).length;
          return `${count} ${role.label}`;
        })
        .join(', ');

      return ok({
        ...state,
        status: 'active',
        startedAt: ctx.now,
        phaseIndex: 0,
        players,
        log: appendLog(state, ctx, {
          source: 'engine',
          type: 'START_SESSION',
          summary: `${definition.name} started: ${roleSummary}.`,
          detail: {
            roles: Object.fromEntries(assignment.value),
            phaseId: definition.phases[0]?.id,
          },
        }),
      });
    }

    case 'ADVANCE_PHASE': {
      if (!RUNNING.includes(state.status)) return err(wrongStatus(state, RUNNING));
      const nextIndex = state.phaseIndex + 1;
      const nextPhase = definition.phases[nextIndex];
      if (!nextPhase) {
        return err(
          engineError(
            'NO_FURTHER_PHASE',
            `${definition.name} has no phase after "${definition.phases[state.phaseIndex]?.id ?? 'unknown'}". Complete the session instead.`,
            { phaseIndex: state.phaseIndex },
          ),
        );
      }
      return ok({
        ...state,
        phaseIndex: nextIndex,
        log: appendLog(state, ctx, {
          source: 'engine',
          type: 'ADVANCE_PHASE',
          summary: `Phase: ${nextPhase.label}.`,
          detail: { phaseId: nextPhase.id, phaseIndex: nextIndex },
        }),
      });
    }

    case 'PAUSE_SESSION': {
      if (!RUNNING.includes(state.status)) return err(wrongStatus(state, RUNNING));
      return ok({
        ...state,
        status: 'paused',
        log: appendLog(state, ctx, {
          source: 'human',
          type: 'PAUSE_SESSION',
          summary: `Paused: ${command.reason}`,
          detail: { reason: command.reason },
        }),
      });
    }

    case 'RESUME_SESSION': {
      if (state.status !== 'paused') return err(wrongStatus(state, ['paused']));
      return ok({
        ...state,
        status: 'active',
        log: appendLog(state, ctx, {
          source: 'human',
          type: 'RESUME_SESSION',
          summary: 'Resumed.',
        }),
      });
    }

    case 'COMPLETE_SESSION': {
      if (state.status === 'lobby') return err(wrongStatus(state, ['active', 'paused']));
      return ok({
        ...state,
        status: 'completed',
        endedAt: ctx.now,
        log: appendLog(state, ctx, {
          source: 'human',
          type: 'COMPLETE_SESSION',
          summary: `${definition.name} finished.`,
        }),
      });
    }

    case 'ABORT_SESSION': {
      // Legal from any non-terminal status, including the lobby. Stopping a game
      // must never be blocked by a state check.
      return ok({
        ...state,
        status: 'aborted',
        endedAt: ctx.now,
        log: appendLog(state, ctx, {
          source: 'human',
          type: 'ABORT_SESSION',
          summary: `Stopped: ${command.reason}`,
          detail: { reason: command.reason },
        }),
      });
    }
  }
}

/**
 * Replays a command sequence from scratch.
 *
 * Exists to be used, not just to exist: the tests assert that replaying a
 * session's own command list reproduces its state byte for byte, which is the
 * property that lets a future Redis/Mongo layer store commands instead of
 * snapshots, and lets a disputed call be settled by re-running the log.
 */
export function replay(
  create: Extract<EngineCommand, { type: 'CREATE_SESSION' }>,
  commands: readonly Exclude<EngineCommand, { type: 'CREATE_SESSION' }>[],
  contextFor: (index: number) => EngineContext,
): Result<SessionState, EngineError> {
  const created = createSession(create, contextFor(0));
  if (!created.ok) return created;

  let state = created.value;
  for (const [index, command] of commands.entries()) {
    const next = reduce(state, command, contextFor(index + 1));
    if (!next.ok) return next;
    state = next.value;
  }
  return ok(state);
}
