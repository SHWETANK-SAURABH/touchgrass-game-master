import { type Result, err, ok } from '@touchgrass/shared';
import {
  type EngineContext,
  type EngineError,
  type GameState,
  type HistoryEntry,
  type PlayerActionOutcome,
  type SessionCommand,
  advanceTime,
  createSession,
  createSessionCommandSchema,
  engineCommandSchema,
  engineError,
  reduce,
  submitPlayerAction,
} from '@touchgrass/game-engine';

/**
 * The authoritative holder of one game's state.
 *
 * The engine is a set of pure functions: it is given a state and returns a new
 * one, and it keeps nothing. Something has to keep the state between inputs and
 * make sure there is only one of it. That is all this module does.
 *
 *   caller supplies            the session owns
 *   ---------------            ----------------
 *   the acting player's id     the one authoritative GameState
 *   the client's intent        the order inputs are applied in
 *   the time                   replacing the state, only after success
 *
 * A session never takes a state from its caller. It creates its own through the
 * engine when it is made, and from then on the only way to change it is one of
 * three operations, each a single call to one engine function:
 *
 *   submitAction   →  submitPlayerAction   a player's intent, for an actor
 *   advanceTime    →  advanceTime          the time, supplied by the caller
 *   applyCommand   →  reduce               a host command, from a trusted caller
 *
 * Every operation is synchronous. It reads the state, calls the engine and
 * stores the result without yielding in between, so two operations on the same
 * session cannot interleave and no queue or lock is needed. If the engine
 * refuses, the stored state is not replaced.
 *
 * There is no timer here, no clock, no network, no storage and no registry of
 * sessions. Each session is its own closure and shares nothing mutable with any
 * other.
 */

/** What an accepted time advance or host command did. */
export interface SessionUpdate {
  /** The authoritative state after the operation. */
  readonly state: GameState;
  /** The history entries the operation added, in order. May be empty. */
  readonly entries: readonly HistoryEntry[];
}

export interface GameSession {
  /** The id of the game this object holds. It identifies the object only. */
  readonly id: string;

  /**
   * The current authoritative state. It is frozen all the way down: a caller can
   * read it and pass it on, and cannot change the game by writing to it.
   */
  readonly getState: () => GameState;

  /**
   * Processes one client intent on behalf of `actorId`.
   *
   * `actorId` is the player the caller has decided this client is. `intent` is
   * the client's message, untrusted: it cannot name an actor, and it cannot
   * express a host command.
   */
  readonly submitAction: (
    actorId: string,
    intent: unknown,
    ctx: EngineContext,
  ) => Result<PlayerActionOutcome, EngineError>;

  /**
   * Brings the game up to `ctx.now`: ends rounds and the game when they are due.
   * Nothing calls this on its own; a game only moves forward in time when a
   * caller says what time it is.
   */
  readonly advanceTime: (ctx: EngineContext) => Result<SessionUpdate, EngineError>;

  /**
   * Applies a host command: a player joining or leaving, a phase change, pause,
   * resume, abort.
   *
   * Trusted callers only. A command names no actor and the game records no
   * host, so nothing here checks who is asking. It must not be reachable from a
   * player's message; `submitAction` cannot express one.
   */
  readonly applyCommand: (
    command: SessionCommand,
    ctx: EngineContext,
  ) => Result<SessionUpdate, EngineError>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function invalidCommand(message: string, issues: readonly string[]): EngineError {
  return engineError('INVALID_ACTION', message, { issues: [...issues] });
}

const issuesOf = (error: { issues: readonly { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

/**
 * Creates a session for a new game.
 *
 * The initial state is built here, by the engine, from the command. There is no
 * way to hand a session an existing state.
 */
export function createGameSession(
  command: unknown,
  ctx: EngineContext,
): Result<GameSession, EngineError> {
  const parsed = createSessionCommandSchema.safeParse(command);
  if (!parsed.success) {
    return err(
      engineError('INVALID_GAME_CONFIGURATION', 'The session could not be created.', {
        issues: issuesOf(parsed.error),
      }),
    );
  }
  const created = createSession(parsed.data, ctx);
  if (!created.ok) return created;

  // Copied once so the session shares no object with the game definition it was
  // created from, then frozen. Each later state is frozen as it is stored; the
  // engine builds new states by sharing the unchanged parts of the old one, so
  // only what an operation added is visited.
  let current: GameState = deepFreeze(structuredClone(created.value));

  /** Stores the next state and reports what was added. Called only after success. */
  const replace = (next: GameState): SessionUpdate => {
    const entries = next.history.slice(current.history.length);
    current = deepFreeze(next);
    return deepFreeze({ state: current, entries });
  };

  return ok({
    id: current.id,

    getState: () => current,

    submitAction(actorId, intent, actionCtx) {
      const outcome = submitPlayerAction(current, actorId, intent, actionCtx);
      if (!outcome.ok) return outcome;
      current = deepFreeze(outcome.value.state);
      return ok(deepFreeze(outcome.value));
    },

    advanceTime(timeCtx) {
      const next = advanceTime(current, timeCtx);
      if (!next.ok) return next;
      return ok(replace(next.value));
    },

    applyCommand(input, commandCtx) {
      const valid = engineCommandSchema.safeParse(input);
      if (!valid.success) {
        return err(
          invalidCommand('The command is not a valid host command.', issuesOf(valid.error)),
        );
      }
      if (valid.data.type === 'CREATE_SESSION') {
        return err(invalidCommand('A session is created once and cannot be created again.', []));
      }
      const next = reduce(current, valid.data, commandCtx);
      if (!next.ok) return next;
      return ok(replace(next.value));
    },
  });
}
