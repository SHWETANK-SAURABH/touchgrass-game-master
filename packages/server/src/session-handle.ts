import { type Result, ok } from '@touchgrass/shared';
import type { GameState } from '@touchgrass/game-engine';
import type { GameSession } from '@touchgrass/game-session';
import { type Room, createRoom, createToken } from '@touchgrass/realtime';
import type { SessionPersistenceError } from '@touchgrass/session-persistence';

/**
 * One loaded game, and everything that belongs to it alone.
 *
 *   GameSession   the running game
 *   Room          its connections and bearer tokens
 *   host token    the bearer secret for its host role
 *   dirty marker  the state this handle last saved
 *   save queue    its saves, one at a time
 *
 * A handle does not own a store and does not listen on a network. It is told
 * how to save, and it is told what else has to happen when it stops: whoever
 * made it decides that. A single-game server stops its listener and closes its
 * store. A registry of many games frees the game's id and keeps the store open
 * for the others.
 *
 * Saving happens only when it is asked for: `save()`, and once inside
 * `shutdown()` if there is anything unsaved. `hasUnsavedChanges()` says whether
 * there is, and never saves. `close()` never saves. No join, action, host
 * command, tick, leave, resume or disconnect saves anything; the room does not
 * know a store exists.
 */

/** A game a room has been made for. */
export interface HostedSession {
  readonly session: GameSession;
  readonly room: Room;
  /** A new bearer secret for the host role. It is not stored anywhere. */
  readonly hostToken: string;
}

/**
 * Makes a room around a session that already exists. The session is used as it
 * is; the room and the host token are new.
 */
export function hostSession(
  session: GameSession,
  options: { readonly createToken?: () => string } = {},
): HostedSession {
  const hostToken = (options.createToken ?? createToken)();
  const room = createRoom({ session, hostToken, ...options });
  return { session, room, hostToken };
}

export interface SessionHandle extends HostedSession {
  /**
   * Saves the game as it is now. This is the explicit save: nothing else calls
   * it. A failure is returned and changes nothing in the running game.
   *
   * Saves are made one at a time. One requested while another is still going
   * waits for it, and then saves the game as it is at that point, not as it was
   * when the save was asked for. A save that fails does not hold up the next.
   */
  readonly save: () => Promise<Result<void, SessionPersistenceError>>;
  /**
   * Whether the game has changed since this handle last saved it successfully.
   *
   * It is a question, not a trigger: a true answer saves nothing. It compares
   * the session's current state with the exact state object that was last
   * saved, which is kept here in memory and nowhere else.
   *
   * It speaks only for this handle. It does not know whether another process
   * has overwritten or deleted what is stored.
   */
  readonly hasUnsavedChanges: () => boolean;
  /**
   * Stops without saving: whatever has changed since the last save is
   * discarded. A save that was already asked for is allowed to finish. Calling
   * it again, or after `shutdown`, does nothing.
   */
  readonly close: () => Promise<void>;
  /**
   * Stops gracefully, keeping the game: it is saved, once, if it has unsaved
   * changes. Saves already under way are waited for first.
   *
   * It returns the result of that final save, or success if nothing needed
   * saving. If the save fails, the failure is returned, nothing is retried, and
   * `hasUnsavedChanges()` stays true.
   *
   * Calling it again returns the first call's result and does nothing more.
   * After `close` it does nothing.
   */
  readonly shutdown: () => Promise<Result<void, SessionPersistenceError>>;
}

export interface SessionHandleOptions {
  /** The game, with the room and host token already made for it. */
  readonly hosted: HostedSession;
  /** Saves the session to wherever it is kept. The handle calls nothing else to save. */
  readonly persist: (session: GameSession) => Promise<Result<void, SessionPersistenceError>>;
  /**
   * Runs first when the handle stops, before any final save: whatever lets the
   * game still change, such as a listener, is stopped here. It is called in the
   * same turn as `close()` or `shutdown()`.
   */
  readonly beforeStop?: () => Promise<void> | void;
  /**
   * Runs last when the handle stops, whatever happened before it, and in the
   * same turn as the last pending save finishing.
   */
  readonly afterStop?: () => Promise<void> | void;
}

/**
 * Makes the handle for a game that is known to be stored as it is now: one that
 * has just been created and saved, or one that has just been loaded.
 */
export function createSessionHandle(options: SessionHandleOptions): SessionHandle {
  const { hosted, persist, beforeStop, afterStop } = options;

  // The state the store is known to hold. A created game has just been saved
  // and a loaded one has just been read, so at this moment it is the session's
  // own state. A GameSession replaces its state object only when the game
  // really changes, so comparing references is an exact test for "changed".
  let lastSavedState: GameState = hosted.session.getState();

  /** One save, from capturing the state to hearing back from the store. */
  const saveNow = async (): Promise<Result<void, SessionPersistenceError>> => {
    // Taken before the save is awaited. The game may change while the store is
    // working, and what was saved is this state, not whatever came after.
    const stateBeingSaved = hosted.session.getState();
    const saved = await persist(hosted.session);
    if (saved.ok) lastSavedState = stateBeingSaved;
    return saved;
  };

  /**
   * The saves of this handle, one at a time.
   *
   * `pendingSaves` settles when the most recently requested save has finished,
   * however it ended, and is undefined while no save is pending. A save
   * requested while another is pending waits for it and only then captures the
   * state and writes, so the store never has two writes from this handle in
   * flight, and a later save always stores a state at least as new as an earlier
   * one. A save requested when nothing is pending starts at once.
   *
   * This orders the saves of one handle. It does nothing about another handle's
   * saves, or about another process writing the same session.
   */
  let pendingSaves: Promise<void> | undefined;

  const save = (): Promise<Result<void, SessionPersistenceError>> => {
    const result = pendingSaves ? pendingSaves.then(saveNow) : saveNow();
    // What later saves wait for. It never rejects, so one save that fails, or
    // even throws, cannot stop the ones behind it.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pendingSaves = settled;
    void settled.then(() => {
      if (pendingSaves === settled) pendingSaves = undefined;
    });
    return result;
  };

  /** Waits until no save is pending, including any requested while waiting. */
  const savesSettled = async (): Promise<void> => {
    while (pendingSaves) await pendingSaves;
  };

  const hasUnsavedChanges = (): boolean => hosted.session.getState() !== lastSavedState;

  /**
   * Stops the handle, with one save in the middle if asked for and needed.
   * Saves already under way are waited for first, so the decision to save is
   * made against what they stored, and `afterStop` never runs while a save is
   * pending. `afterStop` runs whatever happens before it. If `beforeStop` or
   * `afterStop` fails, the first such failure is thrown once everything has been
   * attempted.
   */
  const stop = async (finalSave: boolean): Promise<Result<void, SessionPersistenceError>> => {
    let failure: { readonly error: unknown } | undefined;
    try {
      await beforeStop?.();
    } catch (error) {
      failure = { error };
    }

    await savesSettled();
    let saved: Result<void, SessionPersistenceError> = ok(undefined);
    if (finalSave && hasUnsavedChanges()) saved = await save();
    // Waited for here and not in a helper, so that `afterStop` begins in the
    // same turn as the last save finishing and no save can start in between.
    while (pendingSaves) await pendingSaves;

    try {
      await afterStop?.();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
    return saved;
  };

  let closed = false;
  let shuttingDown: Promise<Result<void, SessionPersistenceError>> | undefined;

  return {
    ...hosted,
    save,
    hasUnsavedChanges,
    async close() {
      if (closed) return;
      closed = true;
      await stop(false);
    },
    shutdown() {
      if (shuttingDown) return shuttingDown;
      // Already closed without saving. There is nothing left to do.
      if (closed) return Promise.resolve(ok(undefined));
      closed = true;
      shuttingDown = stop(true);
      return shuttingDown;
    },
  };
}
