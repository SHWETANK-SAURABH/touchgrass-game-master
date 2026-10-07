import { describe, expect, it } from 'vitest';
import { submitGameEvent } from './engine';
import { processPlayerAction } from './process-action';
import type { GameState } from './state';
import {
  START,
  at,
  codeOf,
  eventTypes,
  holders,
  lobby,
  must,
  scoreOf,
  started,
} from './test-support';
import { advanceTime } from './time';

const ROUND_MS = 180_000;
const roundEnd = (round: number): number => START + round * ROUND_MS;

/** A running three-player game and who holds which role. */
function setup(): { state: GameState; it: string; r1: string; r2: string } {
  const state = started('tag', 3);
  const [tagger] = holders(state, 'tagger');
  const [r1, r2] = holders(state, 'runner');
  if (!tagger || !r1 || !r2) throw new Error('fixture failed');
  return { state, it: tagger, r1, r2 };
}

const tag = (playerId: string, targetPlayerId: string) => ({
  type: 'PLAYER_TAGGED' as const,
  playerId,
  targetPlayerId,
});

describe('Tag: start', () => {
  it('assigns exactly one tagger and makes everyone else a runner', () => {
    for (const count of [2, 3, 4]) {
      const state = started('tag', count);
      expect(holders(state, 'tagger')).toHaveLength(1);
      expect(holders(state, 'runner')).toHaveLength(count - 1);
    }
  });

  it('picks the same tagger for the same seed', () => {
    expect(holders(started('tag', 4, 99), 'tagger')).toEqual(
      holders(started('tag', 4, 99), 'tagger'),
    );
  });

  it('starts round 1 with the definition timer', () => {
    const { state } = setup();
    expect(state.status).toBe('active');
    expect(state.currentRound).toBe(1);
    expect(state.timer.endsAt).toBe(at(roundEnd(1)).now);
  });
});

describe('Tag: tagging', () => {
  it('swaps roles when the tagger tags a runner', () => {
    const { state, it: tagger, r1, r2 } = setup();
    const next = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    expect(holders(next, 'tagger')).toEqual([r1]);
    expect(holders(next, 'runner').sort()).toEqual([tagger, r2].sort());
  });

  it('scores TAG_MADE for the player who made the tag', () => {
    const { state, it: tagger, r1, r2 } = setup();
    const next = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    expect(scoreOf(next, tagger)).toBe(2);
    expect(scoreOf(next, r1)).toBe(0);
    expect(scoreOf(next, r2)).toBe(0);
  });

  it('records the action, then the event with its cause and the award', () => {
    const { state, it: tagger, r1 } = setup();
    const next = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    const [action, event] = next.history.slice(-2);

    expect(action).toMatchObject({ source: 'human', record: { kind: 'ACTION' } });
    expect(event).toMatchObject({
      source: 'engine',
      record: {
        kind: 'EVENT',
        event: {
          type: 'ROLE_CHANGE',
          cause: { reason: 'TAGGED', byPlayerId: tagger, targetPlayerId: r1 },
        },
      },
      awards: [{ playerId: tagger, reason: 'TAG_MADE', points: 2 }],
    });
  });

  it('lets the new tagger tag in turn', () => {
    const { state, it: tagger, r1, r2 } = setup();
    const first = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    const second = must(processPlayerAction(first, tag(r1, r2), at(START + 9_000)));
    expect(holders(second, 'tagger')).toEqual([r2]);
    expect(scoreOf(second, r1)).toBe(2);
  });

  it('rejects a tag by a runner', () => {
    const { state, it: tagger, r1, r2 } = setup();
    expect(codeOf(processPlayerAction(state, tag(r1, r2), at(START + 1)))).toBe('INVALID_ROLE');
    expect(codeOf(processPlayerAction(state, tag(r1, tagger), at(START + 1)))).toBe('INVALID_ROLE');
  });

  it('rejects a tag on yourself, on an unknown player, or by one', () => {
    const { state, it: tagger, r1 } = setup();
    expect(codeOf(processPlayerAction(state, tag(tagger, tagger), at(START + 1)))).toBe(
      'INVALID_ACTION',
    );
    expect(codeOf(processPlayerAction(state, tag(tagger, 'ghost'), at(START + 1)))).toBe(
      'INVALID_PLAYER',
    );
    expect(codeOf(processPlayerAction(state, tag('ghost', r1), at(START + 1)))).toBe(
      'INVALID_PLAYER',
    );
  });

  it('rejects a tag before the game has started', () => {
    const state = lobby('tag', 3);
    expect(codeOf(processPlayerAction(state, tag('p0', 'p1'), at(10)))).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('rejects an action that tries to carry a result', () => {
    const { state, it: tagger, r1 } = setup();
    const smuggled = { ...tag(tagger, r1), score: 100 };
    expect(codeOf(processPlayerAction(state, smuggled, at(START + 1)))).toBe('INVALID_ACTION');
  });

  it('leaves the state untouched when a tag is refused', () => {
    const { state, r1, r2 } = setup();
    const snapshot = structuredClone(state);
    processPlayerAction(state, tag(r1, r2), at(START + 1));
    processPlayerAction(state, tag('ghost', r2), at(START + 1));
    expect(state).toEqual(snapshot);
  });
});

describe('Tag: shield', () => {
  /** r1 holds a shield, granted by an external POWER_UP event. */
  function withShield(): ReturnType<typeof setup> {
    const game = setup();
    const state = must(
      submitGameEvent(
        game.state,
        { type: 'POWER_UP', playerId: game.r1, powerId: 'shield' },
        'game-master',
        at(START + 1_000),
      ),
    );
    return { ...game, state };
  }

  const activate = (playerId: string) => ({
    type: 'PLAYER_ACTIVATED_POWER' as const,
    playerId,
    powerId: 'shield',
  });

  it('holding a shield is not protection: it must be activated', () => {
    const { state, it: tagger, r1 } = withShield();
    expect(state.players.find((player) => player.id === r1)?.powers).toEqual(['shield']);
    expect(codeOf(processPlayerAction(state, tag(tagger, r1), at(START + 2_000)))).toBe('ok');
  });

  it('activating moves the shield from held to in force for 20 seconds', () => {
    const { state, r1 } = withShield();
    const next = must(processPlayerAction(state, activate(r1), at(START + 2_000)));

    expect(next.players.find((player) => player.id === r1)?.powers).toEqual([]);
    expect(next.activeModifiers).toEqual([
      expect.objectContaining({
        kind: 'TEMPORARY_POWER_UP',
        playerId: r1,
        powerId: 'shield',
        expiresAt: at(START + 22_000).now,
      }),
    ]);
    expect(eventTypes(next).slice(-2)).toEqual(['POWER_UP', 'POWER_ACTIVATED']);
  });

  it('makes the holder immune to tags while it lasts', () => {
    const { state, it: tagger, r1, r2 } = withShield();
    const shielded = must(processPlayerAction(state, activate(r1), at(START + 2_000)));

    const refused = processPlayerAction(shielded, tag(tagger, r1), at(START + 21_999));
    expect(codeOf(refused)).toBe('INVALID_ACTION');
    // The shield protects its holder only.
    expect(codeOf(processPlayerAction(shielded, tag(tagger, r2), at(START + 3_000)))).toBe('ok');
  });

  it('expires exactly 20 seconds after activation', () => {
    const { state, it: tagger, r1 } = withShield();
    const shielded = must(processPlayerAction(state, activate(r1), at(START + 2_000)));

    const after = must(processPlayerAction(shielded, tag(tagger, r1), at(START + 22_000)));
    expect(holders(after, 'tagger')).toEqual([r1]);
    expect(after.activeModifiers).toEqual([]);
  });

  it('cannot be activated twice, or by someone who does not hold it', () => {
    const { state, r1, r2 } = withShield();
    const shielded = must(processPlayerAction(state, activate(r1), at(START + 2_000)));
    expect(codeOf(processPlayerAction(shielded, activate(r1), at(START + 3_000)))).toBe(
      'INVALID_ACTION',
    );
    expect(codeOf(processPlayerAction(state, activate(r2), at(START + 3_000)))).toBe(
      'INVALID_ACTION',
    );
  });

  it('cannot be granted to a player who already has one', () => {
    const { state, r1 } = withShield();
    const again = submitGameEvent(
      state,
      { type: 'POWER_UP', playerId: r1, powerId: 'shield' },
      'game-master',
      at(START + 2_000),
    );
    expect(codeOf(again)).toBe('INVALID_EVENT');
  });

  it('rejects a power the game does not define', () => {
    const { state, r1 } = setup();
    const result = submitGameEvent(
      state,
      { type: 'POWER_UP', playerId: r1, powerId: 'jetpack' },
      'game-master',
      at(START + 1_000),
    );
    expect(codeOf(result)).toBe('INVALID_EVENT');
  });
});

describe('Tag: rounds and scoring', () => {
  it('gives ROUND_SURVIVED to every runner who was not tagged', () => {
    const { state, it: tagger, r1, r2 } = setup();
    const next = must(advanceTime(state, at(roundEnd(1))));
    expect(scoreOf(next, r1)).toBe(1);
    expect(scoreOf(next, r2)).toBe(1);
    expect(scoreOf(next, tagger)).toBe(0);
  });

  it('gives no survival point to a player who was tagged that round', () => {
    const { state, it: tagger, r1, r2 } = setup();
    const tagged = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    const next = must(advanceTime(tagged, at(roundEnd(1))));

    // The original tagger made a tag (2) and ended the round an untagged runner (1).
    expect(scoreOf(next, tagger)).toBe(3);
    expect(scoreOf(next, r2)).toBe(1);
    // r1 was tagged and ended the round as the tagger.
    expect(scoreOf(next, r1)).toBe(0);
  });

  it('records the round-end awards on the ROUND_END entry', () => {
    const { state, r1, r2 } = setup();
    const next = must(advanceTime(state, at(roundEnd(1))));
    const entry = next.history.find(
      (candidate) =>
        candidate.record.kind === 'EVENT' && candidate.record.event.type === 'ROUND_END',
    );
    expect(entry?.awards).toEqual([
      { playerId: r1, reason: 'ROUND_SURVIVED', points: 1 },
      { playerId: r2, reason: 'ROUND_SURVIVED', points: 1 },
    ]);
  });

  it('starts the next round at the instant the previous one ended', () => {
    const { state } = setup();
    const next = must(advanceTime(state, at(roundEnd(1) + 7_000)));
    expect(next.status).toBe('active');
    expect(next.currentRound).toBe(2);
    expect(next.timer.endsAt).toBe(at(roundEnd(2)).now);
    expect(eventTypes(next).slice(-2)).toEqual(['ROUND_END', 'ROUND_START']);
  });

  it('keeps roles from one round to the next', () => {
    const { state, it: tagger, r1 } = setup();
    const tagged = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    const next = must(advanceTime(tagged, at(roundEnd(1) + 1)));
    expect(holders(next, 'tagger')).toEqual([r1]);
  });

  it('counts a tag reported after the timer ran out in the next round', () => {
    const { state, it: tagger, r1 } = setup();
    const next = must(processPlayerAction(state, tag(tagger, r1), at(roundEnd(1) + 2_000)));
    expect(next.currentRound).toBe(2);
    // Round 1 ended first: no survival point was lost to the late tag.
    expect(scoreOf(next, r1)).toBe(1);
    expect(scoreOf(next, tagger)).toBe(2);
  });

  it('plays three rounds and then completes', () => {
    const { state } = setup();
    const done = must(advanceTime(state, at(roundEnd(3))));
    expect(done.status).toBe('completed');
    expect(done.currentRound).toBe(3);
    expect(done.endedAt).toBe(at(roundEnd(3)).now);
    expect(eventTypes(done)).toEqual([
      'ROUND_START',
      'ROUND_END',
      'ROUND_START',
      'ROUND_END',
      'ROUND_START',
      'ROUND_END',
      'GAME_END',
    ]);
  });
});

describe('Tag: winner', () => {
  it('is the player with the highest score', () => {
    const { state, it: tagger, r1 } = setup();
    const tagged = must(processPlayerAction(state, tag(tagger, r1), at(START + 5_000)));
    const done = must(advanceTime(tagged, at(roundEnd(3))));

    // Original tagger: 2 for the tag, then an untagged runner in all three rounds.
    expect(scoreOf(done, tagger)).toBe(5);
    expect(done.winnerIds).toEqual([tagger]);
  });

  it('is shared by every player level on the highest score, in join order', () => {
    const { state, it: tagger } = setup();
    const done = must(advanceTime(state, at(roundEnd(3))));

    // Nobody tagged anyone: both runners survived all three rounds.
    const runners = done.players
      .filter((player) => player.id !== tagger)
      .map((player) => player.id);
    expect(runners.map((id) => scoreOf(done, id))).toEqual([3, 3]);
    expect(done.winnerIds).toEqual(runners);
  });

  it('accepts nothing once the game has completed', () => {
    const { state, it: tagger, r1 } = setup();
    const done = must(advanceTime(state, at(roundEnd(3))));
    expect(codeOf(processPlayerAction(done, tag(tagger, r1), at(roundEnd(3) + 1)))).toBe(
      'GAME_ALREADY_COMPLETED',
    );
  });
});
