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
  gameStateSchema,
  reduce,
  sequentialEntryId,
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
 * A session gets its state in one of two ways: it creates a new one through the
 * engine, or it is restored from a snapshot an earlier session produced, which
 * is validated before it is accepted. From then on the only way to change it is
 * one of three operations, each a single call to one engine function:
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
 * A session can describe itself as a snapshot and be rebuilt from one. That is
 * the whole of its part in persistence: it does not write, read, schedule or
 * retry anything, and whatever stores a snapshot decides nothing about the game.
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

/** The version of the snapshot layout this code writes and reads. */
export const SNAPSHOT_VERSION = 1;

/**
 * Everything needed to rebuild a session, as plain data.
 *
 * It is a labelled GameState and nothing more. The state already carries the
 * game's history: `state.history` is the one authoritative record of what
 * happened, in order, and a snapshot does not hold a second copy of it or any
 * other log. Nothing about connections, tokens or hosts is in a GameState, so
 * none of it can be in a snapshot.
 *
 * It survives `JSON.stringify` and `JSON.parse` unchanged.
 */
export interface GameSessionSnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  /** The id of the session it was taken from. Always equal to `state.id`. */
  readonly sessionId: string;
  /** The authoritative state at the moment of the snapshot, history included. */
  readonly state: GameState;
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
   * The session as it is now, for something else to store. Frozen all the way
   * down, like the state: writing to it throws and changes nothing here.
   */
  readonly snapshot: () => GameSessionSnapshot;

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

  // Copied once so the session shares no object with the game definition it
  // was created from.
  return ok(hold(structuredClone(created.value)));
}

/**
 * The holder itself. `initial` must be a state nothing else has a reference to:
 * a copy of what the engine created, or the result of validating a snapshot.
 *
 * Each state is frozen as it is stored. The engine builds new states by sharing
 * the unchanged parts of the old one, so only what an operation added is visited.
 */
function hold(initial: GameState): GameSession {
  let current: GameState = deepFreeze(initial);

  /** Stores the next state and reports what was added. Called only after success. */
  const replace = (next: GameState): SessionUpdate => {
    const entries = next.history.slice(current.history.length);
    current = deepFreeze(next);
    return deepFreeze({ state: current, entries });
  };

  return {
    id: current.id,

    getState: () => current,

    snapshot: () =>
      Object.freeze({ version: SNAPSHOT_VERSION, sessionId: current.id, state: current }),

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
  };
}

function invalidSnapshot(message: string, context?: Record<string, unknown>): EngineError {
  return engineError('INVALID_GAME_STATE', `The snapshot cannot be restored: ${message}`, context);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a session from a snapshot.
 *
 * `snapshot` is untrusted: it has been somewhere else since a session wrote it.
 * It is accepted only if all of the following hold, and otherwise refused with
 * nothing created:
 *
 *  1. It is a snapshot of this version, with exactly the fields of one.
 *  2. Its state satisfies the engine's own GameState schema, which also checks
 *     that the state is consistent with itself: history numbered without gaps,
 *     unique ids, end time set exactly when the game has ended, and so on.
 *  3. The session id matches the state's id.
 *  4. The game is one the engine has a definition for, and the state carries
 *     that definition's settings. This is checked by asking the engine to create
 *     a fresh session of the same game and comparing.
 *  5. The history begins the way the engine begins one, and its times never go
 *     backwards.
 *  6. The engine has nothing to do to the state at its own latest time. A state
 *     the engine produced never has a round that has already run out or a
 *     modifier that has already expired, so one that does was not produced by
 *     the engine as it stands.
 *
 * It cannot prove the history and the rest of the state agree in every respect.
 * The history does not record enough to replay a game from it, so a snapshot
 * with, say, an altered score and an otherwise valid shape is accepted. A
 * snapshot is to be kept where only trusted code can write it.
 *
 * The restored session holds a copy: it shares nothing with the object passed
 * in. It behaves exactly as the original would have from that point on.
 */
export function restoreGameSession(snapshot: unknown): Result<GameSession, EngineError> {
  if (!isPlainObject(snapshot)) return err(invalidSnapshot('it is not an object.'));
  const keys = Object.keys(snapshot).sort();
  if (keys.join() !== 'sessionId,state,version') {
    return err(invalidSnapshot('it does not have exactly the fields of a snapshot.', { keys }));
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    return err(invalidSnapshot(`it is not a version ${String(SNAPSHOT_VERSION)} snapshot.`));
  }

  // Parsing builds a new object, so the session never holds the caller's.
  const parsed = gameStateSchema.safeParse(snapshot.state);
  if (!parsed.success) {
    return err(
      invalidSnapshot('its state is not a valid game state.', { issues: issuesOf(parsed.error) }),
    );
  }
  const state = parsed.data;
  if (snapshot.sessionId !== state.id) {
    return err(invalidSnapshot('its session id does not match its state.'));
  }

  // The engine is asked for a new session of the same game. If it has no such
  // game, this is where that is found out.
  const fresh = createSession(
    {
      type: 'CREATE_SESSION',
      sessionId: state.id,
      gameId: state.gameId,
      joinCode: state.joinCode,
      randomSeed: state.randomSeed,
    },
    { now: state.createdAt, nextEntryId: sequentialEntryId },
  );
  if (!fresh.ok) return fresh;
  if (JSON.stringify(state.settings) !== JSON.stringify(fresh.value.settings)) {
    return err(invalidSnapshot('its settings are not those of the game definition.'));
  }

  const [first] = state.history;
  const [expected] = fresh.value.history;
  if (
    !first ||
    !expected ||
    first.at !== state.createdAt ||
    JSON.stringify(first.record) !== JSON.stringify(expected.record)
  ) {
    return err(invalidSnapshot('its history does not begin with the creation of the session.'));
  }
  if (state.history.some((entry, index) => entry.at < (state.history[index - 1]?.at ?? entry.at))) {
    return err(invalidSnapshot('its history goes backwards in time.'));
  }

  const latest = state.history.at(-1)?.at ?? state.createdAt;
  const settled = advanceTime(state, { now: latest, nextEntryId: sequentialEntryId });
  if (!settled.ok) return settled;
  if (settled.value !== state) {
    return err(
      invalidSnapshot('a round or a modifier in it had already run out when it was taken.'),
    );
  }

  return ok(hold(state));
}
