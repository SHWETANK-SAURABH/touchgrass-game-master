import { z } from 'zod';
import { gameSettingsSchema } from '@touchgrass/game-definitions';
import { playerActionSchema } from './actions';
import { gameEventSchema } from './events';
import { activeModifierSchema, activeObjectiveSchema } from './modifiers';
import { scoreAwardSchema } from './scoring';

/**
 * The canonical shape of a game in progress.
 *
 * Two properties matter more than anything else here:
 *
 *  1. It is plain data. No class instances, no methods, no hidden state. A game
 *     can be serialised, stored, sent over a socket, and replayed.
 *  2. It is complete. Everything needed to continue the game — round, timer,
 *     roles, scores, what is in force, and how it got here — is in this object.
 *     Nothing about the game lives in a database row or a model's context.
 *
 * All times are absolute epoch milliseconds supplied by the caller. The state
 * never stores "seconds remaining", because that would change with the moment
 * it is read; remaining time is `timer.endsAt` minus the caller's clock.
 */

// --- lifecycle ---------------------------------------------------------------

export const GAME_STATUSES = [
  /** Created, players joining, roles not yet assigned. */
  'lobby',
  /** Roles assigned, first round not yet begun. */
  'starting',
  /** A round is running. */
  'active',
  /** Between rounds. */
  'round_end',
  /** Halted by a human. Nothing is applied until it resumes. */
  'paused',
  /** Finished normally. */
  'completed',
  /** Stopped early. */
  'aborted',
] as const;
export const gameStatusSchema = z.enum(GAME_STATUSES);
export type GameStatus = z.infer<typeof gameStatusSchema>;

export const TERMINAL_STATUSES = ['completed', 'aborted'] as const satisfies readonly GameStatus[];

export function isTerminalStatus(status: GameStatus): boolean {
  return (TERMINAL_STATUSES as readonly GameStatus[]).includes(status);
}

/**
 * The lifecycle contract: which status may follow which.
 *
 * `aborted` is reachable from every non-terminal status, because stopping a game
 * must never be blocked. Terminal statuses lead nowhere. A paused game can only
 * resume or be aborted; it cannot complete.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<GameStatus, readonly GameStatus[]>> = {
  lobby: ['starting', 'aborted'],
  starting: ['active', 'aborted'],
  active: ['round_end', 'paused', 'aborted'],
  round_end: ['active', 'completed', 'aborted'],
  paused: ['active', 'aborted'],
  completed: [],
  aborted: [],
};

export function canTransition(from: GameStatus, to: GameStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

// --- players -----------------------------------------------------------------

export const playerStatusSchema = z.enum([
  /** Playing. */
  'active',
  /** Out for the current round, e.g. a hider who has been found. */
  'out',
  /** Left the game. The record stays so history and scores remain readable. */
  'left',
]);
export type PlayerStatus = z.infer<typeof playerStatusSchema>;

/** Holds no personal information beyond a display name the player chose. */
export const playerStateSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).max(40),
    /** Null until the engine assigns roles at start. */
    roleId: z.string().min(1).nullable(),
    /** Never negative. */
    score: z.int().min(0),
    status: playerStatusSchema,
    /** Whether the player has reported ready. */
    ready: z.boolean(),
    /** Ids of powers the player holds and has not yet activated. */
    powers: z.array(z.string().min(1)),
    joinedAt: z.int(),
  })
  .strict();
export type PlayerState = z.infer<typeof playerStateSchema>;

// --- history -----------------------------------------------------------------

/**
 * Who caused a history entry. This makes "did a model cause this?" answerable
 * from the data alone.
 */
export const historySourceSchema = z.enum([
  /** The engine itself: lifecycle events and the results of player actions. */
  'engine',
  /** A person: the host, or a player reporting an action. */
  'human',
  /** A game event that originated from the Game Master and passed validation. */
  'game-master',
]);
export type HistorySource = z.infer<typeof historySourceSchema>;

/** What a history entry records. */
export const historyRecordSchema = z.discriminatedUnion('kind', [
  /** A host command. */
  z
    .object({
      kind: z.literal('COMMAND'),
      command: z.string().min(1),
      detail: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  /** A player action that passed validation. */
  z.object({ kind: z.literal('ACTION'), action: playerActionSchema }).strict(),
  /** A game event that was applied. */
  z.object({ kind: z.literal('EVENT'), event: gameEventSchema }).strict(),
  /** Roles handed out by the engine when the game begins. */
  z
    .object({
      kind: z.literal('ROLES_ASSIGNED'),
      roles: z.record(z.string(), z.string()),
    })
    .strict(),
]);
export type HistoryRecord = z.infer<typeof historyRecordSchema>;

export const historyEntrySchema = z
  .object({
    id: z.string().min(1),
    /** Position in the history, starting at 0 with no gaps. */
    sequence: z.int().min(0),
    at: z.int(),
    source: historySourceSchema,
    /** Human-readable summary, safe to show players. */
    summary: z.string().min(1),
    record: historyRecordSchema,
    /** Points awarded as a consequence of this entry. Omitted when there are none. */
    awards: z.array(scoreAwardSchema).min(1).optional(),
  })
  .strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

// --- timer -------------------------------------------------------------------

export const roundTimerSchema = z
  .object({
    /** When the running round ends, or null when no round is running. */
    endsAt: z.int().nullable(),
    /**
     * When the game was paused, or null. While paused the clock is frozen: on
     * resume, `endsAt` and every expiry move forward by the length of the pause.
     */
    pausedAt: z.int().nullable(),
  })
  .strict();
export type RoundTimer = z.infer<typeof roundTimerSchema>;

// --- game state --------------------------------------------------------------

export const gameStateSchema = z
  .object({
    id: z.string().min(1),
    /** Id of the game definition being played. */
    gameId: z.string().min(1),
    joinCode: z.string().min(1),
    status: gameStatusSchema,
    /** Index into the definition's `phases` array. */
    phaseIndex: z.int().min(0),
    settings: gameSettingsSchema,
    /** 0 before the first round starts. */
    currentRound: z.int().min(0),
    timer: roundTimerSchema,
    players: z.array(playerStateSchema),
    activeModifiers: z.array(activeModifierSchema),
    activeObjectives: z.array(activeObjectiveSchema),
    history: z.array(historyEntrySchema),
    /** Decided by the engine when the game completes. Empty until then. */
    winnerIds: z.array(z.string().min(1)),
    createdAt: z.int(),
    startedAt: z.int().nullable(),
    endedAt: z.int().nullable(),
    /** Stored so a replay reproduces every random choice, on any host. */
    randomSeed: z.int(),
  })
  .strict()
  .superRefine((state, ctx) => {
    const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

    if (!unique(state.players.map((player) => player.id))) {
      ctx.addIssue({ code: 'custom', path: ['players'], message: 'player ids must be unique' });
    }
    if (!unique(state.activeModifiers.map((modifier) => modifier.id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeModifiers'],
        message: 'modifier ids must be unique',
      });
    }
    if (!unique(state.activeObjectives.map((objective) => objective.id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeObjectives'],
        message: 'objective ids must be unique',
      });
    }
    if (state.currentRound > state.settings.totalRounds) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentRound'],
        message: 'currentRound cannot exceed settings.totalRounds',
      });
    }
    if (state.history.some((entry, index) => entry.sequence !== index)) {
      ctx.addIssue({
        code: 'custom',
        path: ['history'],
        message: 'history sequence numbers must run from 0 with no gaps',
      });
    }
    if (isTerminalStatus(state.status) !== (state.endedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt must be set exactly when the game has ended',
      });
    }
    if (state.status === 'lobby' && state.startedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'a game in the lobby has not started',
      });
    }
    if ((state.status === 'paused') !== (state.timer.pausedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['timer', 'pausedAt'],
        message: 'timer.pausedAt must be set exactly while the game is paused',
      });
    }
    if (state.status === 'active' && state.timer.endsAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['timer', 'endsAt'],
        message: 'a running round must have an end time',
      });
    }
    if (state.winnerIds.length > 0 && state.status !== 'completed') {
      ctx.addIssue({
        code: 'custom',
        path: ['winnerIds'],
        message: 'winners exist only once the game has completed',
      });
    }
    const playerIds = state.players.map((player) => player.id);
    if (state.winnerIds.some((id) => !playerIds.includes(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['winnerIds'],
        message: 'a winner must be a player in the game',
      });
    }
  });
export type GameState = z.infer<typeof gameStateSchema>;

export function findPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((player) => player.id === playerId);
}
