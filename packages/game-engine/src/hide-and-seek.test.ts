import { describe, expect, it } from 'vitest';
import { submitGameEvent } from './engine';
import { processPlayerAction } from './process-action';
import type { GameState } from './state';
import { START, at, codeOf, eventTypes, holders, must, scoreOf, started } from './test-support';
import { advanceTime } from './time';

const ROUND_MS = 300_000;
const roundEnd = (round: number): number => START + round * ROUND_MS;

/** A running three-player game and who holds which role. */
function setup(): { state: GameState; seeker: string; h1: string; h2: string } {
  const state = started('hide-and-seek', 3);
  const [seeker] = holders(state, 'seeker');
  const [h1, h2] = holders(state, 'hider');
  if (!seeker || !h1 || !h2) throw new Error('fixture failed');
  return { state, seeker, h1, h2 };
}

const find = (playerId: string, targetPlayerId: string) => ({
  type: 'PLAYER_FOUND' as const,
  playerId,
  targetPlayerId,
});

const statusOf = (state: GameState, playerId: string): string | undefined =>
  state.players.find((player) => player.id === playerId)?.status;

describe('Hide & Seek: start', () => {
  it('assigns exactly one seeker and makes everyone else a hider', () => {
    for (const count of [2, 3, 4]) {
      const state = started('hide-and-seek', count);
      expect(holders(state, 'seeker')).toHaveLength(1);
      expect(holders(state, 'hider')).toHaveLength(count - 1);
    }
  });

  it('starts round 1 with a 300 second timer', () => {
    const { state } = setup();
    expect(state.currentRound).toBe(1);
    expect(state.timer.endsAt).toBe(at(roundEnd(1)).now);
  });
});

describe('Hide & Seek: finding', () => {
  it('puts a found hider out for the round without changing their role', () => {
    const { state, seeker, h1, h2 } = setup();
    const next = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    expect(statusOf(next, h1)).toBe('out');
    expect(statusOf(next, h2)).toBe('active');
    expect(holders(next, 'hider').sort()).toEqual([h1, h2].sort());
    expect(holders(next, 'seeker')).toEqual([seeker]);
  });

  it('scores FOUND_PLAYER for the seeker', () => {
    const { state, seeker, h1 } = setup();
    const next = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    expect(scoreOf(next, seeker)).toBe(2);
    expect(scoreOf(next, h1)).toBe(0);
  });

  it('records the action, then a PLAYER_OUT event with who found whom and the award', () => {
    const { state, seeker, h1 } = setup();
    const next = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    const [action, event] = next.history.slice(-2);

    expect(action).toMatchObject({ source: 'human', record: { kind: 'ACTION' } });
    expect(event).toMatchObject({
      source: 'engine',
      record: {
        kind: 'EVENT',
        event: { type: 'PLAYER_OUT', playerId: h1, byPlayerId: seeker, reason: 'FOUND' },
      },
      awards: [{ playerId: seeker, reason: 'FOUND_PLAYER', points: 2 }],
    });
  });

  it('rejects a hider finding the seeker or another hider', () => {
    const { state, seeker, h1, h2 } = setup();
    expect(codeOf(processPlayerAction(state, find(h1, seeker), at(START + 1)))).toBe(
      'INVALID_ROLE',
    );
    expect(codeOf(processPlayerAction(state, find(h1, h2), at(START + 1)))).toBe('INVALID_ROLE');
  });

  it('rejects finding the same hider twice', () => {
    const { state, seeker, h1 } = setup();
    const next = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    const again = processPlayerAction(next, find(seeker, h1), at(START + 31_000));
    expect(codeOf(again)).toBe('INVALID_ACTION');
    expect(scoreOf(next, seeker)).toBe(2);
  });

  it('rejects finding an unknown player', () => {
    const { state, seeker } = setup();
    expect(codeOf(processPlayerAction(state, find(seeker, 'ghost'), at(START + 1)))).toBe(
      'INVALID_PLAYER',
    );
  });

  it('has no tagging: PLAYER_TAGGED is not an action of this game', () => {
    const { state, seeker, h1 } = setup();
    const result = processPlayerAction(
      state,
      { type: 'PLAYER_TAGGED', playerId: seeker, targetPlayerId: h1 },
      at(START + 1),
    );
    expect(codeOf(result)).toBe('INVALID_ACTION');
  });

  it('leaves the state untouched when a find is refused', () => {
    const { state, seeker, h1 } = setup();
    const snapshot = structuredClone(state);
    processPlayerAction(state, find(h1, seeker), at(START + 1));
    processPlayerAction(state, find(seeker, 'ghost'), at(START + 1));
    expect(state).toEqual(snapshot);
  });

  it('does not accept PLAYER_OUT from outside the engine', () => {
    const { state, seeker, h1 } = setup();
    const result = submitGameEvent(
      state,
      { type: 'PLAYER_OUT', playerId: h1, byPlayerId: seeker, reason: 'FOUND' },
      'game-master',
      at(START + 1),
    );
    expect(codeOf(result)).toBe('UNSUPPORTED_EVENT');
  });
});

describe('Hide & Seek: rounds and scoring', () => {
  it('gives STAYED_HIDDEN to each hider who was not found', () => {
    const { state, seeker, h1, h2 } = setup();
    const next = must(advanceTime(state, at(roundEnd(1))));
    expect(scoreOf(next, h1)).toBe(3);
    expect(scoreOf(next, h2)).toBe(3);
    expect(scoreOf(next, seeker)).toBe(0);
  });

  it('gives nothing to a hider who was found, and no ALL_FOUND while one is still hidden', () => {
    const { state, seeker, h1, h2 } = setup();
    const found = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    const next = must(advanceTime(found, at(roundEnd(1))));
    expect(scoreOf(next, h1)).toBe(0);
    expect(scoreOf(next, h2)).toBe(3);
    expect(scoreOf(next, seeker)).toBe(2);
  });

  it('gives the seeker ALL_FOUND when every hider was found', () => {
    const { state, seeker, h1, h2 } = setup();
    const one = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    const both = must(processPlayerAction(one, find(seeker, h2), at(START + 60_000)));
    const next = must(advanceTime(both, at(roundEnd(1))));

    // Two finds (2 + 2) and the all-found bonus (2).
    expect(scoreOf(next, seeker)).toBe(6);
    expect(scoreOf(next, h1)).toBe(0);
    expect(scoreOf(next, h2)).toBe(0);
    const entry = next.history.find(
      (candidate) =>
        candidate.record.kind === 'EVENT' && candidate.record.event.type === 'ROUND_END',
    );
    expect(entry?.awards).toEqual([{ playerId: seeker, reason: 'ALL_FOUND', points: 2 }]);
  });

  it('does not end the round early when everyone has been found', () => {
    const { state, seeker, h1, h2 } = setup();
    const one = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    const both = must(processPlayerAction(one, find(seeker, h2), at(START + 60_000)));
    expect(both.status).toBe('active');
    expect(both.currentRound).toBe(1);
  });

  it('brings found hiders back in for the next round, with the same seeker', () => {
    const { state, seeker, h1 } = setup();
    const found = must(processPlayerAction(state, find(seeker, h1), at(START + 30_000)));
    const next = must(advanceTime(found, at(roundEnd(1) + 1)));
    expect(next.currentRound).toBe(2);
    expect(statusOf(next, h1)).toBe('active');
    expect(holders(next, 'seeker')).toEqual([seeker]);
    expect(codeOf(processPlayerAction(next, find(seeker, h1), at(roundEnd(1) + 5_000)))).toBe('ok');
  });

  it('plays three rounds and then completes', () => {
    const { state } = setup();
    const done = must(advanceTime(state, at(roundEnd(3))));
    expect(done.status).toBe('completed');
    expect(done.endedAt).toBe(at(roundEnd(3)).now);
    expect(eventTypes(done).at(-1)).toBe('GAME_END');
    expect(eventTypes(done).filter((type) => type === 'ROUND_END')).toHaveLength(3);
  });
});

describe('Hide & Seek: winner', () => {
  it('is the seeker when they find everyone every round', () => {
    const { seeker, h1, h2, ...game } = setup();
    let state = game.state;
    for (const round of [1, 2, 3]) {
      const base = roundEnd(round - 1);
      state = must(processPlayerAction(state, find(seeker, h1), at(base + 10_000)));
      state = must(processPlayerAction(state, find(seeker, h2), at(base + 20_000)));
    }
    const done = must(advanceTime(state, at(roundEnd(3))));
    expect(scoreOf(done, seeker)).toBe(18);
    expect(done.winnerIds).toEqual([seeker]);
  });

  it('is the hider who stayed hidden longest', () => {
    const { seeker, h1, h2, ...game } = setup();
    // h1 is found in every round; h2 never is.
    let state = game.state;
    for (const round of [1, 2, 3]) {
      state = must(processPlayerAction(state, find(seeker, h1), at(roundEnd(round - 1) + 10_000)));
    }
    const done = must(advanceTime(state, at(roundEnd(3))));
    expect(scoreOf(done, h2)).toBe(9);
    expect(scoreOf(done, seeker)).toBe(6);
    expect(scoreOf(done, h1)).toBe(0);
    expect(done.winnerIds).toEqual([h2]);
  });

  it('is shared when hiders tie', () => {
    const { state, h1, h2 } = setup();
    const done = must(advanceTime(state, at(roundEnd(3))));
    expect(done.winnerIds.sort()).toEqual([h1, h2].sort());
  });
});
