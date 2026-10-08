import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import {
  type EngineContext,
  type GameState,
  type TimedInput,
  contextAt,
  createSession,
  gameStateSchema,
  replay,
} from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from './session';

const T0 = 1_700_000_000_000;
const at = (ms: number): EngineContext => contextAt(fixedClock(T0 + ms));
const START = 1_000;
const NOW = START + 5_000;
const ROUND_MS = 180_000;

const create = (sessionId = 'g1', gameId = 'tag') => ({
  type: 'CREATE_SESSION' as const,
  sessionId,
  gameId,
  joinCode: 'GRASS7',
  randomSeed: 7,
});

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

const codeOf = (result: { ok: true } | { ok: false; error: { code: string } }): string =>
  result.ok ? 'ok' : result.error.code;

const READY = { type: 'PLAYER_READY' };
const tag = (targetPlayerId: string) => ({ type: 'PLAYER_TAGGED', targetPlayerId });

/** A new session in the lobby with players p0, p1 and p2. */
function lobbySession(sessionId = 'g1', gameId = 'tag'): GameSession {
  const session = unwrap(createGameSession(create(sessionId, gameId), at(0)));
  for (const index of [0, 1, 2]) {
    unwrap(
      session.applyCommand(
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  return session;
}

/** A session whose three players are all ready, so round 1 is running. */
function runningSession(sessionId = 'g1', gameId = 'tag'): GameSession {
  const session = lobbySession(sessionId, gameId);
  for (const index of [0, 1, 2]) unwrap(session.submitAction(`p${index}`, READY, at(START)));
  return session;
}

function holders(state: GameState, roleId: string): string[] {
  return state.players.filter((player) => player.roleId === roleId).map((player) => player.id);
}

function tagRoles(session: GameSession): { tagger: string; r1: string; r2: string } {
  const [tagger] = holders(session.getState(), 'tagger');
  const [r1, r2] = holders(session.getState(), 'runner');
  if (!tagger || !r1 || !r2) throw new Error('fixture failed');
  return { tagger, r1, r2 };
}

/** Runs an operation that must be refused and checks the session kept its state. */
function refused(
  session: GameSession,
  run: () => { ok: true } | { ok: false; error: { code: string } },
) {
  const before = session.getState();
  const snapshot = structuredClone(before);
  const result = run();
  expect(result.ok).toBe(false);
  expect(Object.keys(result)).not.toContain('value');
  // The very same state object is still the authoritative one, and it is unchanged.
  expect(session.getState()).toBe(before);
  expect(session.getState()).toEqual(snapshot);
  return codeOf(result);
}

describe('createGameSession', () => {
  it('creates a game in the lobby through the engine', () => {
    const session = unwrap(createGameSession(create(), at(0)));
    expect(session.id).toBe('g1');
    expect(session.getState()).toMatchObject({
      id: 'g1',
      gameId: 'tag',
      status: 'lobby',
      players: [],
      createdAt: T0,
    });
    // The engine records the creation as the first history entry.
    expect(session.getState().history.map((entry) => entry.record)).toEqual([
      { kind: 'COMMAND', command: 'CREATE_SESSION', detail: { gameId: 'tag' } },
    ]);
    expect(gameStateSchema.safeParse(session.getState()).success).toBe(true);
  });

  it('refuses a game that is not registered', () => {
    expect(codeOf(createGameSession(create('g1', 'quidditch'), at(0)))).toBe(
      'INVALID_GAME_CONFIGURATION',
    );
  });

  it('does not accept a state, or anything that is not a create command', () => {
    const existing = runningSession().getState();
    const attempts: unknown[] = [
      existing,
      { ...create(), state: existing },
      { ...create(), players: existing.players },
      { ...create(), status: 'active' },
      { ...create(), history: existing.history },
      { type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Ada' },
      { ...create(), randomSeed: 1.5 },
      { ...create(), sessionId: '' },
      null,
      undefined,
      'tag',
    ];
    for (const attempt of attempts) {
      expect(codeOf(createGameSession(attempt, at(0)))).toBe('INVALID_GAME_CONFIGURATION');
    }
  });

  it('takes one argument besides the time: there is no parameter for a state', () => {
    expect(createGameSession.length).toBe(2);
  });
});

describe('getState', () => {
  it('returns the current state, and the same object until something changes it', () => {
    const session = lobbySession();
    expect(session.getState()).toBe(session.getState());
    expect(session.getState().players.map((player) => player.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('cannot be used to change the game', () => {
    const session = runningSession();
    const { tagger, r1 } = tagRoles(session);
    const state = session.getState() as unknown as {
      status: string;
      players: { score: number; roleId: string; powers: string[] }[];
      history: unknown[];
      timer: { endsAt: number };
      winnerIds: string[];
    };

    const writes: (() => void)[] = [
      () => {
        state.status = 'completed';
      },
      () => {
        (state.players[0] as { score: number }).score = 999;
      },
      () => {
        (state.players[1] as { roleId: string }).roleId = 'tagger';
      },
      () => {
        (state.players[0] as { powers: string[] }).powers.push('shield');
      },
      () => {
        state.players.pop();
      },
      () => {
        state.history.length = 0;
      },
      () => {
        state.timer.endsAt = 0;
      },
      () => {
        state.winnerIds.push('p0');
      },
    ];
    for (const write of writes) expect(write).toThrow(TypeError);

    expect(session.getState().status).toBe('active');
    expect(session.getState().players.every((player) => player.score === 0)).toBe(true);
    // The game still works after the attempts.
    expect(session.submitAction(tagger, tag(r1), at(NOW)).ok).toBe(true);
  });

  it('keeps earlier states readable and unchanged after the game moves on', () => {
    const session = runningSession();
    const { tagger, r1 } = tagRoles(session);
    const before = session.getState();
    const snapshot = structuredClone(before);
    unwrap(session.submitAction(tagger, tag(r1), at(NOW)));
    expect(before).toEqual(snapshot);
    expect(session.getState()).not.toBe(before);
  });

  it('does not freeze the game definition it was created from', () => {
    runningSession();
    // The engine puts the definition's own settings object into a new state.
    // The session copies its first state, so freezing never reaches that object.
    const fresh = unwrap(createSession(create('other'), at(0)));
    expect(Object.isFrozen(fresh.settings)).toBe(false);
  });
});

describe('submitAction', () => {
  it('replaces the state after an accepted action and returns what was added', () => {
    const session = runningSession();
    const { tagger, r1 } = tagRoles(session);
    const before = session.getState();

    const outcome = unwrap(session.submitAction(tagger, tag(r1), at(NOW)));

    expect(session.getState()).toBe(outcome.state);
    expect(session.getState()).not.toBe(before);
    expect(holders(session.getState(), 'tagger')).toEqual([r1]);
    expect(outcome.action).toEqual({ type: 'PLAYER_TAGGED', playerId: tagger, targetPlayerId: r1 });
    expect(outcome.entries).toEqual(session.getState().history.slice(before.history.length));
    expect(outcome.entries.map((entry) => entry.sequence)).toEqual([
      before.history.length,
      before.history.length + 1,
    ]);
    expect(outcome.entries.map((entry) => entry.record.kind)).toEqual(['ACTION', 'EVENT']);
  });

  it('leaves the state exactly as it was after a refused action', () => {
    const session = runningSession();
    const { tagger, r1, r2 } = tagRoles(session);
    expect(refused(session, () => session.submitAction(r1, tag(r2), at(NOW)))).toBe('INVALID_ROLE');
    expect(refused(session, () => session.submitAction('ghost', tag(r1), at(NOW)))).toBe(
      'INVALID_PLAYER',
    );
    expect(refused(session, () => session.submitAction(tagger, { type: 'NOPE' }, at(NOW)))).toBe(
      'INVALID_ACTION',
    );
    // Sent after the round ran out, by a runner: the round end is not kept either.
    expect(
      refused(session, () => session.submitAction(r1, tag(r2), at(START + ROUND_MS + 1))),
    ).toBe('INVALID_ROLE');
    expect(session.getState().currentRound).toBe(1);
  });

  it('takes the actor from the caller, never from the intent', () => {
    const session = runningSession();
    const { tagger, r1, r2 } = tagRoles(session);
    expect(
      refused(session, () => session.submitAction(r1, { ...tag(r2), playerId: tagger }, at(NOW))),
    ).toBe('INVALID_ACTION');
    const outcome = unwrap(session.submitAction(tagger, tag(r2), at(NOW)));
    expect(outcome.action).toMatchObject({ playerId: tagger });
  });

  it('has no parameter for a state, and ignores one smuggled into the intent', () => {
    const session = runningSession();
    const { tagger, r1 } = tagRoles(session);
    expect(session.submitAction.length).toBe(3);
    const forged = { ...session.getState(), status: 'completed' };
    expect(
      refused(session, () => session.submitAction(tagger, { ...tag(r1), state: forged }, at(NOW))),
    ).toBe('INVALID_ACTION');
    expect(refused(session, () => session.submitAction(tagger, forged, at(NOW)))).toBe(
      'INVALID_ACTION',
    );
  });

  it.each([
    ['add a player', { type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Mallory' }],
    ['remove a player', { type: 'REMOVE_PLAYER', playerId: 'p0' }],
    ['pause', { type: 'PAUSE_SESSION', reason: 'because' }],
    ['resume', { type: 'RESUME_SESSION' }],
    ['abort', { type: 'ABORT_SESSION', reason: 'because' }],
    ['advance the phase', { type: 'ADVANCE_PHASE' }],
    ['create a session', create('g2')],
    ['advance time', { type: 'ADVANCE_TIME' }],
    ['submit a game event', { type: 'TIME_EXTENSION', seconds: 300 }],
    ['end the game', { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' }],
  ])('cannot be used to %s', (_label, message) => {
    const session = runningSession();
    const { tagger } = tagRoles(session);
    expect(refused(session, () => session.submitAction(tagger, message, at(NOW)))).toBe(
      'INVALID_ACTION',
    );
    expect(session.getState().players).toHaveLength(3);
    expect(session.getState().status).toBe('active');
  });

  it('applies actions one after another, each against the latest state', () => {
    const session = runningSession();
    const { tagger, r1, r2 } = tagRoles(session);

    // Three messages handled in the same instant, in this order.
    const first = session.submitAction(tagger, tag(r1), at(NOW));
    const second = session.submitAction(tagger, tag(r2), at(NOW));
    const third = session.submitAction(r1, tag(r2), at(NOW));

    expect(codeOf(first)).toBe('ok');
    // By then the first tagger was a runner.
    expect(codeOf(second)).toBe('INVALID_ROLE');
    // The new tagger's tag is judged against the state the first one produced.
    expect(codeOf(third)).toBe('ok');
    expect(holders(session.getState(), 'tagger')).toEqual([r2]);

    const sequences = session.getState().history.map((entry) => entry.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index));
    if (first.ok && third.ok) {
      expect(third.value.entries[0]?.sequence).toBe(
        (first.value.entries.at(-1)?.sequence ?? 0) + 1,
      );
    }
  });
});

describe('advanceTime', () => {
  it('replaces the state when time has moved the game on', () => {
    const session = runningSession();
    const before = session.getState();
    const update = unwrap(session.advanceTime(at(START + ROUND_MS)));

    expect(session.getState()).toBe(update.state);
    expect(update.state.currentRound).toBe(2);
    expect(update.entries.map((entry) => entry.sequence)).toEqual([
      before.history.length,
      before.history.length + 1,
    ]);
    expect(
      update.entries.map((entry) => (entry.record.kind === 'EVENT' ? entry.record.event.type : '')),
    ).toEqual(['ROUND_END', 'ROUND_START']);
  });

  it('reports no entries when nothing was due', () => {
    const session = runningSession();
    const before = session.getState();
    const update = unwrap(session.advanceTime(at(NOW)));
    expect(update.entries).toEqual([]);
    expect(session.getState()).toEqual(before);
  });

  it('runs a whole game when the caller supplies the times', () => {
    const session = runningSession();
    unwrap(session.advanceTime(at(START + 3 * ROUND_MS)));
    expect(session.getState()).toMatchObject({ status: 'completed', currentRound: 3 });
    expect(session.getState().winnerIds.length).toBeGreaterThan(0);
  });

  it('leaves the state as it was when time would move backwards', () => {
    const session = runningSession();
    unwrap(session.advanceTime(at(NOW)));
    const { tagger, r1 } = tagRoles(session);
    unwrap(session.submitAction(tagger, tag(r1), at(NOW)));
    expect(refused(session, () => session.advanceTime(at(NOW - 1)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('does not move the game forward on its own', () => {
    vi.useFakeTimers();
    try {
      const session = runningSession();
      const before = session.getState();
      vi.advanceTimersByTime(10 * ROUND_MS);
      expect(vi.getTimerCount()).toBe(0);
      expect(session.getState()).toBe(before);
      expect(session.getState().currentRound).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('applyCommand', () => {
  it('replaces the state after an accepted command', () => {
    const session = unwrap(createGameSession(create(), at(0)));
    const update = unwrap(
      session.applyCommand({ type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Ada' }, at(1)),
    );
    expect(session.getState()).toBe(update.state);
    expect(update.state.players.map((player) => player.displayName)).toEqual(['Ada']);
    expect(update.entries).toHaveLength(1);
    expect(update.entries[0]).toMatchObject({
      sequence: 1,
      source: 'human',
      record: { kind: 'COMMAND', command: 'ADD_PLAYER' },
    });
  });

  it('pauses, resumes and aborts', () => {
    const session = runningSession();
    unwrap(session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW)));
    expect(session.getState().status).toBe('paused');
    const { tagger, r1 } = tagRoles(session);
    expect(refused(session, () => session.submitAction(tagger, tag(r1), at(NOW + 1_000)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
    unwrap(session.applyCommand({ type: 'RESUME_SESSION' }, at(NOW + 2_000)));
    expect(session.getState().status).toBe('active');
    unwrap(session.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(NOW + 3_000)));
    expect(session.getState().status).toBe('aborted');
    expect(refused(session, () => session.submitAction(tagger, tag(r1), at(NOW + 4_000)))).toBe(
      'GAME_ALREADY_COMPLETED',
    );
  });

  it('leaves the state as it was after a refused command', () => {
    const session = runningSession();
    expect(
      refused(session, () =>
        session.applyCommand({ type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Late' }, at(NOW)),
      ),
    ).toBe('GAME_ALREADY_STARTED');
    expect(
      refused(session, () =>
        session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'ghost' }, at(NOW)),
      ),
    ).toBe('INVALID_PLAYER');
    expect(refused(session, () => session.applyCommand({ type: 'RESUME_SESSION' }, at(NOW)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('refuses anything that is not a host command, without throwing', () => {
    const session = runningSession();
    const attempts: unknown[] = [
      create('g2'),
      { type: 'PLAYER_READY' },
      { type: 'PLAYER_TAGGED', playerId: 'p0', targetPlayerId: 'p1' },
      { type: 'TIME_EXTENSION', seconds: 60 },
      { type: 'SET_SCORE', playerId: 'p0', score: 99 },
      { type: 'PAUSE_SESSION', reason: 'x', status: 'completed' },
      { type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Mallory', score: 50, roleId: 'tagger' },
      session.getState(),
      null,
      undefined,
    ];
    for (const attempt of attempts) {
      expect(refused(session, () => session.applyCommand(attempt as never, at(NOW)))).toBe(
        'INVALID_ACTION',
      );
    }
  });
});

describe('sessions are independent', () => {
  it('shares no state between two sessions', () => {
    const a = runningSession('a');
    const b = runningSession('b');
    const bBefore = b.getState();
    const { tagger, r1 } = tagRoles(a);

    unwrap(a.submitAction(tagger, tag(r1), at(NOW)));
    unwrap(a.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(NOW + 1_000)));

    expect(a.getState().status).toBe('aborted');
    expect(b.getState()).toBe(bBefore);
    expect(b.getState().status).toBe('active');
    expect(b.getState().players.every((player) => player.score === 0)).toBe(true);
    expect(a.id).toBe('a');
    expect(b.id).toBe('b');
  });

  it('shares no object between two sessions, even ones created identically', () => {
    const a = lobbySession('same');
    const b = lobbySession('same');
    expect(a.getState()).toEqual(b.getState());
    expect(a.getState()).not.toBe(b.getState());
    expect(a.getState().players).not.toBe(b.getState().players);
    expect(a.getState().settings).not.toBe(b.getState().settings);
    unwrap(a.submitAction('p0', READY, at(START)));
    expect(b.getState().players.every((player) => !player.ready)).toBe(true);
  });

  it('runs different games side by side', () => {
    const tagGame = runningSession('a', 'tag');
    const hideGame = runningSession('b', 'hide-and-seek');
    const [seeker] = holders(hideGame.getState(), 'seeker');
    const [hider] = holders(hideGame.getState(), 'hider');
    unwrap(
      hideGame.submitAction(seeker ?? '', { type: 'PLAYER_FOUND', targetPlayerId: hider }, at(NOW)),
    );
    expect(hideGame.getState().players.find((player) => player.id === hider)?.status).toBe('out');
    expect(holders(tagGame.getState(), 'tagger')).toHaveLength(1);
    expect(tagGame.getState().history.at(-1)?.at).toBe(T0 + START);
  });
});

describe('the session is synchronous and holds only a game', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(directory, 'session.ts'), 'utf-8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('returns plain values, never a promise', () => {
    const session = runningSession();
    const { tagger, r1 } = tagRoles(session);
    const results: unknown[] = [
      createGameSession(create('x'), at(0)),
      session.getState(),
      session.submitAction(tagger, tag(r1), at(NOW)),
      session.submitAction('ghost', READY, at(NOW)),
      session.advanceTime(at(NOW)),
      session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW)),
    ];
    for (const result of results) {
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof (result as { then?: unknown }).then).toBe('undefined');
    }
    for (const method of [session.submitAction, session.advanceTime, session.applyCommand]) {
      expect(method.constructor.name).toBe('Function');
    }
  });

  it('has no async code, timer, clock, network, queue or module-level state', () => {
    expect(code).not.toMatch(
      /\basync\b|\bawait\b|Promise|setTimeout|setInterval|setImmediate|queueMicrotask|Date\.now|new Date|Math\.random|fetch\(|process\.env/,
    );
    // Nothing mutable is declared outside a function: the only `let` is the
    // state inside the session's own closure.
    const topLevel = code
      .split('\n')
      .filter(
        (line) => /^(let|var)\s/.test(line) || /^const \w+ = new (Map|Set|WeakMap)/.test(line),
      );
    expect(topLevel).toEqual([]);
    expect(code.match(/\blet\b/g)).toHaveLength(1);
  });

  it('reads no clock, random source, timer or network while running a game', () => {
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
      vi.spyOn(globalThis, 'fetch'),
    ];
    const session = runningSession();
    const { tagger, r1 } = tagRoles(session);
    session.submitAction(tagger, tag(r1), at(NOW));
    session.advanceTime(at(START + 3 * ROUND_MS));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('depends only on the engine and shared helpers, and uses four engine functions', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['@touchgrass/game-engine', '@touchgrass/shared']);

    const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies).toBeUndefined();
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@touchgrass/game-engine',
      '@touchgrass/shared',
    ]);

    expect(code).not.toMatch(
      /processPlayerAction|\bstep\(|submitGameEvent|applyValidatedEvent|validateExternalEvent|replay\(/,
    );
    for (const name of ['createSession(', 'submitPlayerAction(', 'advanceTime(', 'reduce(']) {
      expect(code).toContain(name);
    }
  });
});

describe('the engine is unchanged underneath', () => {
  it('reaches exactly the state a replay of the same inputs reaches', () => {
    const session = runningSession();
    const { tagger, r1, r2 } = tagRoles(session);
    unwrap(session.submitAction(tagger, tag(r1), at(NOW)));
    session.submitAction(tagger, tag(r2), at(NOW + 500)); // refused, and leaves no trace
    unwrap(session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW + 1_000)));
    unwrap(session.applyCommand({ type: 'RESUME_SESSION' }, at(NOW + 4_000)));
    unwrap(session.submitAction(r1, tag(r2), at(NOW + 5_000)));
    unwrap(session.advanceTime(at(START + 3 * ROUND_MS + 3_000)));

    // The same game as recorded inputs: actions carry their actor, as history does.
    const inputs: TimedInput[] = [
      ...[0, 1, 2].map((index) => ({
        at: T0,
        input: {
          type: 'COMMAND' as const,
          command: {
            type: 'ADD_PLAYER' as const,
            playerId: `p${index}`,
            displayName: `Player ${index}`,
          },
        },
      })),
      ...[0, 1, 2].map((index) => ({
        at: T0 + START,
        input: { type: 'ACTION' as const, action: { type: 'PLAYER_READY', playerId: `p${index}` } },
      })),
      {
        at: T0 + NOW,
        input: {
          type: 'ACTION',
          action: { type: 'PLAYER_TAGGED', playerId: tagger, targetPlayerId: r1 },
        },
      },
      {
        at: T0 + NOW + 1_000,
        input: { type: 'COMMAND', command: { type: 'PAUSE_SESSION', reason: 'water' } },
      },
      { at: T0 + NOW + 4_000, input: { type: 'COMMAND', command: { type: 'RESUME_SESSION' } } },
      {
        at: T0 + NOW + 5_000,
        input: {
          type: 'ACTION',
          action: { type: 'PLAYER_TAGGED', playerId: r1, targetPlayerId: r2 },
        },
      },
      { at: T0 + START + 3 * ROUND_MS + 3_000, input: { type: 'ADVANCE_TIME' } },
    ];
    const replayed = unwrap(replay(create(), T0, inputs));

    expect(session.getState()).toEqual(replayed);
    expect(session.getState().status).toBe('completed');
    expect(gameStateSchema.safeParse(session.getState()).success).toBe(true);
  });

  it('adds no field to the state', () => {
    const keys = Object.keys(runningSession().getState()).sort();
    expect(keys).toEqual(Object.keys(gameStateSchema.shape).sort());
  });
});

describe('the state object changes exactly when the game does', () => {
  // Code outside this package relies on this: comparing two results of
  // getState() with === is how it tells whether a game has changed.

  it('gives a new state object for every accepted change', () => {
    const session = lobbySession();
    const seen = new Set<GameState>([session.getState()]);

    unwrap(session.submitAction('p0', READY, at(START)));
    seen.add(session.getState());
    unwrap(session.applyCommand({ type: 'REMOVE_PLAYER', playerId: 'p2' }, at(START)));
    seen.add(session.getState());
    unwrap(session.submitAction('p1', READY, at(START)));
    seen.add(session.getState());
    // The round runs out: time alone changes the game.
    unwrap(session.advanceTime(at(START + ROUND_MS)));
    seen.add(session.getState());

    expect(seen.size).toBe(5);
  });

  it('keeps the very same state object when an operation is refused', () => {
    const session = runningSession();
    const before = session.getState();
    const { r1, r2 } = tagRoles(session);

    expect(session.submitAction(r1, tag(r2), at(NOW)).ok).toBe(false);
    expect(session.submitAction('ghost', READY, at(NOW)).ok).toBe(false);
    expect(session.submitAction(r1, { type: 'NOPE' }, at(NOW)).ok).toBe(false);
    expect(session.applyCommand({ type: 'RESUME_SESSION' }, at(NOW)).ok).toBe(false);
    expect(session.applyCommand({ type: 'SET_SCORE' } as never, at(NOW)).ok).toBe(false);
    expect(session.advanceTime(at(START - 1)).ok).toBe(false);

    expect(session.getState()).toBe(before);
  });

  it('keeps the very same state object when time advances and nothing is due', () => {
    const lobby = lobbySession();
    const lobbyBefore = lobby.getState();
    expect(unwrap(lobby.advanceTime(at(60_000))).state).toBe(lobbyBefore);
    expect(lobby.getState()).toBe(lobbyBefore);

    const running = runningSession();
    const before = running.getState();
    for (const ms of [START, NOW, START + ROUND_MS - 1]) {
      expect(unwrap(running.advanceTime(at(ms))).state).toBe(before);
    }
    expect(running.getState()).toBe(before);
    // One millisecond later the round is over, and the object is a new one.
    unwrap(running.advanceTime(at(START + ROUND_MS)));
    expect(running.getState()).not.toBe(before);
  });

  it('is not changed by reading the state or taking a snapshot', () => {
    const session = runningSession();
    const before = session.getState();
    session.getState();
    session.snapshot();
    expect(session.snapshot().state).toBe(before);
    expect(session.getState()).toBe(before);
  });
});
