import { type Clock, systemClock } from '@touchgrass/shared';
import { findGameDefinition } from '@touchgrass/game-definitions';
import { contextAt } from '@touchgrass/game-engine';
import type { SessionUpdate } from '@touchgrass/game-session';
import type { GameMaster, ToolCallRecord } from '@touchgrass/ai/game-master';
import { handOffProposalTo } from '@touchgrass/ai/handoff';
import type { PolicyOptions } from '@touchgrass/safety';
import type { SessionHandle } from './session-handle';

/**
 * Game Master turns for live sessions.
 *
 *   trigger                      decided by application code, never by the model
 *     → the game as it stands    read from the session
 *     → Game Master              asked for one proposal; given no way to act
 *     → proposal                 a value
 *     → schema                   the proposal's own schema         (ai package)
 *     → legality                 the engine's validator            (engine)
 *     → safety                   the deterministic validator       (safety package)
 *     → application              the engine, through the session   (engine)
 *     → broadcast                the room, as for any other change (realtime)
 *     → save                     the handle's own save             (this package)
 *
 * This module is the wiring and nothing else. It holds no game rule and no
 * safety rule, and it never touches a game's state: the one thing it hands on
 * is what the hand-off returns from the safety package's clearance, and it
 * hands that to the session's room.
 *
 * A turn can fail at every step, and none of those failures is the game's. A
 * model that is away, slow or wrong, a proposal that is refused, an engine that
 * says no: each ends the turn with nothing applied, nothing broadcast and
 * nothing saved, and the game carries on exactly as it would with no Game
 * Master at all.
 *
 * Turns for one session run one at a time, in the order they were asked for.
 * Turns for different sessions do not wait for each other. The model is always
 * asked with a time limit.
 */

/** A Game Master turn may wait this long for the model: twenty seconds. */
export const DEFAULT_GAME_MASTER_TIMEOUT_MS = 20_000;

/** Why a turn was taken. Both are decided by application code. */
export type GameMasterTrigger =
  /** A round has just begun. */
  | 'round_start'
  /** Trusted code asked for one. */
  | 'manual';

/**
 * The trigger policy, whole: a turn is taken when a round begins. It looks only
 * at what the engine recorded, so it is the same every time for the same game.
 */
export function gameMasterTriggerFor(update: SessionUpdate): GameMasterTrigger | null {
  const roundBegan = update.entries.some(
    (entry) => entry.record.kind === 'EVENT' && entry.record.event.type === 'ROUND_START',
  );
  return roundBegan && update.state.status === 'active' ? 'round_start' : null;
}

/**
 * What one turn did, for whoever keeps a record. It names the session, the
 * model and the outcome. It never carries a prompt, a reply, a rationale, a
 * player, a token, or any part of a game beyond the kind of event proposed.
 */
export interface GameMasterAudit {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly trigger: GameMasterTrigger;
  readonly at: number;
  readonly provider: string;
  readonly model: string;
  readonly outcome:
    /** An event was proposed, passed every check, and the engine applied it. */
    | 'APPLIED'
    /** The Game Master proposed that nothing happen. */
    | 'NO_EVENT'
    /** A proposal was made and refused. Nothing changed. */
    | 'REJECTED'
    /** No usable proposal was produced. Nothing changed. */
    | 'FAILED'
    /** The model was not asked, or its answer was no longer wanted. */
    | 'SKIPPED';
  /** Where a refusal or failure happened. */
  readonly stage?: 'PROPOSAL' | 'SCHEMA' | 'STATE' | 'SAFETY' | 'APPLICATION';
  /** A short machine-readable reason. */
  readonly code?: string;
  /** The kind of event proposed, when a proposal got that far. */
  readonly eventType?: string;
  /** How many replies the model was asked for. */
  readonly attempts?: number;
  /** How long the turn took, from being started to its outcome, in milliseconds. */
  readonly durationMs: number;
  /**
   * The tool calls the model made, in order: which tool, whether it answered,
   * a code if it did not, and how long it took. Never what was asked or answered.
   */
  readonly toolCalls?: readonly ToolCallRecord[];
  /** For APPLIED: whether the changed game was then saved. */
  readonly saved?: boolean;
}

export interface GameMasterTurnsOptions {
  /** The Game Master. Only its `propose` is ever called. */
  readonly gameMaster: Pick<GameMaster, 'propose' | 'provider' | 'model'>;
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  /** How long one turn may wait for the model. Defaults to DEFAULT_GAME_MASTER_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Makes the safety policy stricter, or records adult supervision. It cannot loosen it. */
  readonly safety?: PolicyOptions;
  /** Told what each turn did. A listener that throws is ignored. */
  readonly onAudit?: (audit: GameMasterAudit) => void;
  /**
   * Told what was thrown when a turn ended in a way nothing here expects. The
   * record of that turn says only UNEXPECTED; this is for whoever monitors errors.
   */
  readonly onUnexpectedError?: (error: unknown) => void;
}

export interface GameMasterTurns {
  /**
   * Takes one turn for a loaded session, after any turn already under way for
   * it. It never rejects and never throws: what happened is in the record.
   */
  readonly run: (handle: SessionHandle, trigger: GameMasterTrigger) => Promise<GameMasterAudit>;
}

export function createGameMasterTurns(options: GameMasterTurnsOptions): GameMasterTurns {
  const { gameMaster } = options;
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GAME_MASTER_TIMEOUT_MS;
  let invocations = 0;

  /**
   * The turn under way for each session, so the next one waits for it. Keyed
   * by the handle and holding nothing else, so it keeps no session alive.
   */
  const lastTurn = new WeakMap<SessionHandle, Promise<void>>();

  const takeTurn = async (
    handle: SessionHandle,
    trigger: GameMasterTrigger,
  ): Promise<Omit<GameMasterAudit, 'durationMs'>> => {
    invocations += 1;
    const base = {
      invocationId: `gm-${String(invocations)}`,
      sessionId: handle.session.id,
      trigger,
      at: clock.now(),
      provider: gameMaster.provider,
      model: gameMaster.model,
    };

    // A session that is being unloaded, or has been, gets no turn.
    if (handle.room.isClosed()) return { ...base, outcome: 'SKIPPED', code: 'SESSION_CLOSED' };

    const state = handle.session.getState();
    // The Game Master only speaks during a running round. Asking the model
    // about a lobby or a finished game would be a wasted call.
    if (state.status !== 'active') return { ...base, outcome: 'SKIPPED', code: 'GAME_NOT_ACTIVE' };
    const definition = findGameDefinition(state.gameId);
    if (!definition) return { ...base, outcome: 'FAILED', stage: 'SCHEMA', code: 'UNKNOWN_GAME' };

    // The model is given a copy of what it may know, a time limit, and nothing
    // else. Whatever it answers is a value.
    const limit = AbortSignal.timeout(timeoutMs);
    const timedOut = new Promise<'TIMED_OUT'>((resolve) => {
      limit.addEventListener(
        'abort',
        () => {
          resolve('TIMED_OUT');
        },
        { once: true },
      );
    });
    const proposing = gameMaster.propose(
      { state, definition, now: clock.now() },
      // A tool is not run for a session that has been closed meanwhile.
      { signal: limit, available: () => !handle.room.isClosed() },
    );
    // If the limit wins, the model's eventual answer or failure is dropped.
    proposing.catch(() => undefined);
    const proposed = await Promise.race([proposing, timedOut]);

    if (proposed === 'TIMED_OUT') {
      return { ...base, outcome: 'FAILED', stage: 'PROPOSAL', code: 'TIMED_OUT' };
    }
    if (!proposed.ok) {
      return {
        ...base,
        outcome: 'FAILED',
        stage: 'PROPOSAL',
        code: proposed.error.modelErrorCode ?? proposed.error.code,
        ...(proposed.error.attempts === undefined ? {} : { attempts: proposed.error.attempts }),
        ...(proposed.error.toolCalls?.length ? { toolCalls: proposed.error.toolCalls } : {}),
      };
    }
    const answered = {
      ...base,
      attempts: proposed.value.attempts,
      ...(proposed.value.toolCalls?.length ? { toolCalls: proposed.value.toolCalls } : {}),
    };

    // The model took time. The session may have been unloaded meanwhile, and an
    // unloaded session is never changed and never brought back.
    if (handle.room.isClosed()) return { ...answered, outcome: 'SKIPPED', code: 'SESSION_CLOSED' };

    // From here to the end of the hand-off is one turn of the event loop: the
    // proposal is validated against the game as it is now, checked for safety,
    // and applied, with nothing able to come between.
    const handed = handOffProposalTo(
      { getState: handle.session.getState, applyEvent: handle.room.applyEvent },
      proposed.value.proposal,
      contextAt(clock),
      options.safety,
    );

    if (!handed.ok) {
      const failure = handed.error;
      const eventType = 'proposal' in failure ? failure.proposal.event?.type : undefined;
      const code =
        failure.stage === 'SCHEMA'
          ? 'INVALID_PROPOSAL'
          : failure.stage === 'SAFETY'
            ? failure.rejection.kind
            : failure.stage === 'PROPOSAL'
              ? failure.error.code
              : failure.error.code;
      return {
        ...answered,
        outcome: 'REJECTED',
        stage: failure.stage,
        code,
        ...(eventType ? { eventType } : {}),
      };
    }
    if (handed.value.outcome === 'NO_EVENT') return { ...answered, outcome: 'NO_EVENT' };

    // The room has already told its connections. What is left is to keep it.
    const saved = await handle.save();
    return {
      ...answered,
      outcome: 'APPLIED',
      ...(handed.value.proposal.event ? { eventType: handed.value.proposal.event.type } : {}),
      saved: saved.ok,
      ...(saved.ok ? {} : { code: saved.error.code }),
    };
  };

  return {
    run(handle, trigger) {
      const turn = (lastTurn.get(handle) ?? Promise.resolve()).then(async () => {
        const startedAt = clock.now();
        let taken: Omit<GameMasterAudit, 'durationMs'>;
        try {
          taken = await takeTurn(handle, trigger);
        } catch (error) {
          // Nothing above is expected to throw. If something does, the turn is
          // over and the game is as the engine left it.
          taken = {
            invocationId: `gm-${String(invocations)}`,
            sessionId: handle.session.id,
            trigger,
            at: startedAt,
            provider: gameMaster.provider,
            model: gameMaster.model,
            outcome: 'FAILED',
            code: 'UNEXPECTED',
          };
          try {
            options.onUnexpectedError?.(error);
          } catch {
            // Being told is a courtesy.
          }
        }
        const audit: GameMasterAudit = {
          ...taken,
          durationMs: Math.max(0, clock.now() - startedAt),
        };
        try {
          options.onAudit?.(audit);
        } catch {
          // Being told is a courtesy.
        }
        return audit;
      });
      lastTurn.set(
        handle,
        turn.then(() => undefined),
      );
      return turn;
    },
  };
}
