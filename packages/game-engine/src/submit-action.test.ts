import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PLAYER_ACTION_KINDS } from '@touchgrass/game-definitions';
import { parsePlayerIntent, playerActionSchema, playerIntentSchema } from './actions';
import { submitGameEvent } from './engine';
import { processPlayerAction } from './process-action';
import { reduce } from './reduce';
import type { GameState } from './state';
import { type PlayerActionOutcome, submitPlayerAction } from './submit-action';
import { START, at, codeOf, holders, lobby, must, scoreOf, started } from './test-support';
import { advanceTime } from './time';

const NOW = START + 5_000;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function tagGame(): { state: GameState; tagger: string; r1: string; r2: string } {
  const state = deepFreeze(started('tag', 3));
  const [tagger] = holders(state, 'tagger');
  const [r1, r2] = holders(state, 'runner');
  if (!tagger || !r1 || !r2) throw new Error('fixture failed');
  return { state, tagger, r1, r2 };
}

function hideGame(): { state: GameState; seeker: string; h1: string; h2: string } {
  const state = deepFreeze(started('hide-and-seek', 3));
  const [seeker] = holders(state, 'seeker');
  const [h1, h2] = holders(state, 'hider');
  if (!seeker || !h1 || !h2) throw new Error('fixture failed');
  return { state, seeker, h1, h2 };
}

const tag = (targetPlayerId: string) => ({ type: 'PLAYER_TAGGED', targetPlayerId });
const find = (targetPlayerId: string) => ({ type: 'PLAYER_FOUND', targetPlayerId });
const READY = { type: 'PLAYER_READY' };

const kinds = (outcome: PlayerActionOutcome): string[] =>
  outcome.entries.map((entry) =>
    entry.record.kind === 'EVENT' ? entry.record.event.type : entry.record.kind,
  );

/** Submits against a frozen state and checks a refusal left it exactly as it was. */
function refused(state: GameState, actorId: unknown, intent: unknown, ms = NOW): string {
  const snapshot = structuredClone(state);
  const result = submitPlayerAction(deepFreeze(state), actorId as string, intent, at(ms));
  expect(result.ok).toBe(false);
  expect(Object.keys(result)).not.toContain('value');
  expect(state).toEqual(snapshot);
  return codeOf(result);
}

describe('player intents', () => {
  it('has one intent for every action kind, and no others', () => {
    const intentKinds = playerIntentSchema.options.map((option) => option.shape.type.value);
    expect([...intentKinds].sort()).toEqual([...PLAYER_ACTION_KINDS].sort());
  });

  it.each([
    READY,
    tag('p1'),
    find('p1'),
    { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' },
    { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: 'oak' },
    { type: 'PLAYER_ACCEPTED_EVENT', eventId: 'entry-3' },
  ])('$type plus an actor is exactly a player action', (intent) => {
    const parsed = must(parsePlayerIntent(intent));
    expect(parsed).toEqual(intent);
    expect(playerActionSchema.safeParse({ ...parsed, playerId: 'p0' }).success).toBe(true);
    // The action needs an actor; the intent on its own is not one.
    expect(playerActionSchema.safeParse(parsed).success).toBe(false);
  });

  it.each([
    ['an actor', { ...tag('p1'), playerId: 'p0' }],
    ['an actor on a ready message', { ...READY, playerId: 'p2' }],
    ['a score', { ...tag('p1'), points: 50 }],
    ['a role', { ...tag('p1'), roleId: 'tagger' }],
    ['a status', { ...find('p1'), status: 'out' }],
    ['a source', { ...READY, source: 'engine' }],
    ['a transport field', { ...READY, socketId: 'abc' }],
    ['a nested state', { ...READY, state: { status: 'completed' } }],
  ])('refuses a message that carries %s', (_label, message) => {
    expect(codeOf(parsePlayerIntent(message))).toBe('INVALID_ACTION');
  });

  it.each([
    ['null', null],
    ['a string', 'PLAYER_READY'],
    ['an array', [READY]],
    ['no type', { targetPlayerId: 'p1' }],
    ['an unknown type', { type: 'PLAYER_TELEPORTED' }],
    ['a host command', { type: 'ABORT_SESSION', reason: 'because' }],
    ['a game event', { type: 'TIME_EXTENSION', seconds: 60 }],
    ['an engine event', { type: 'PLAYER_OUT', playerId: 'p1', byPlayerId: 'p0', reason: 'FOUND' }],
    ['a missing target', { type: 'PLAYER_TAGGED' }],
    ['a target that is not a string', { type: 'PLAYER_TAGGED', targetPlayerId: 7 }],
    ['an empty target', tag('')],
    ['an over-long id', tag('x'.repeat(65))],
  ])('refuses %s', (_label, message) => {
    expect(codeOf(parsePlayerIntent(message))).toBe('INVALID_ACTION');
  });
});

describe('submitPlayerAction: a valid action', () => {
  it('returns the next state, the recorded action and the entries it added', () => {
    const { state, tagger, r1 } = tagGame();
    const outcome = must(submitPlayerAction(state, tagger, tag(r1), at(NOW)));

    expect(outcome.action).toEqual({ type: 'PLAYER_TAGGED', playerId: tagger, targetPlayerId: r1 });
    expect(kinds(outcome)).toEqual(['ACTION', 'ROLE_CHANGE']);
    expect(outcome.entries).toEqual(outcome.state.history.slice(state.history.length));
    expect(outcome.entries.map((entry) => entry.sequence)).toEqual([
      state.history.length,
      state.history.length + 1,
    ]);
    expect(outcome.entries[0]).toMatchObject({ source: 'human', at: at(NOW).now });
    expect(outcome.entries[1]).toMatchObject({ source: 'engine' });
  });

  it('gives exactly the state processPlayerAction gives for the same action', () => {
    const { state, tagger, r1 } = tagGame();
    const viaIntent = must(submitPlayerAction(state, tagger, tag(r1), at(NOW)));
    const viaAction = must(
      processPlayerAction(
        state,
        { type: 'PLAYER_TAGGED', playerId: tagger, targetPlayerId: r1 },
        at(NOW),
      ),
    );
    expect(viaIntent.state).toEqual(viaAction);
  });

  it('includes a round that ended because time had passed, in order', () => {
    const { state, r1, r2 } = tagGame();
    const tagged = must(
      submitPlayerAction(state, holders(state, 'tagger')[0] ?? '', tag(r1), at(NOW)),
    );
    // The next message arrives after round 1 ran out: it counts in round 2.
    const late = must(submitPlayerAction(tagged.state, r1, tag(r2), at(START + 181_000)));
    expect(kinds(late)).toEqual(['ROUND_END', 'ROUND_START', 'ACTION', 'ROLE_CHANGE']);
    expect(late.state.currentRound).toBe(2);
  });
});

describe('submitPlayerAction: who is acting', () => {
  it('takes the actor from the caller, never from the message', () => {
    const { state, tagger, r1, r2 } = tagGame();
    // A runner's client claims to be the tagger.
    expect(refused(state, r1, { ...tag(r2), playerId: tagger })).toBe('INVALID_ACTION');
    // The same message without the claim is judged as the runner it came from.
    expect(refused(state, r1, tag(r2))).toBe('INVALID_ROLE');
    // And the tagger's own message is accepted.
    expect(submitPlayerAction(state, tagger, tag(r2), at(NOW)).ok).toBe(true);
  });

  it('refuses an actor who is not in the game', () => {
    const { state, r1 } = tagGame();
    expect(refused(state, 'ghost', tag(r1))).toBe('INVALID_PLAYER');
    expect(refused(state, 'ghost', READY)).toBe('INVALID_PLAYER');
  });

  it.each([
    ['an empty id', ''],
    ['no id', undefined],
    ['null', null],
    ['a number', 0],
    ['an object', { id: 'p0' }],
    ['an over-long id', 'p'.repeat(65)],
  ])('refuses %s as the actor', (_label, actorId) => {
    expect(refused(tagGame().state, actorId, READY)).toBe('INVALID_PLAYER');
  });

  it('refuses an actor who has left the game', () => {
    const { state, tagger, r1, r2 } = tagGame();
    const left = must(reduce(state, { type: 'REMOVE_PLAYER', playerId: tagger }, at(NOW)));
    expect(refused(left, tagger, tag(r1), NOW + 1_000)).toBe('INVALID_PLAYER');
    // Nobody can act on a player who has left, either.
    const without = must(reduce(state, { type: 'REMOVE_PLAYER', playerId: r2 }, at(NOW)));
    expect(refused(without, tagger, tag(r2), NOW + 1_000)).toBe('INVALID_PLAYER');
  });

  it('refuses an actor who is out for the round', () => {
    const { state, seeker, h1, h2 } = hideGame();
    const found = must(submitPlayerAction(state, seeker, find(h1), at(NOW))).state;
    const objective = must(
      submitGameEvent(
        found,
        {
          type: 'BONUS_OBJECTIVE',
          objectiveId: 'oak',
          description: 'Touch the big oak.',
          points: 2,
          durationSeconds: 60,
        },
        'human',
        at(NOW + 1_000),
      ),
    );
    const complete = { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: 'oak' };
    expect(refused(objective, h1, complete, NOW + 2_000)).toBe('INVALID_ACTION');
    expect(submitPlayerAction(objective, h2, complete, at(NOW + 2_000)).ok).toBe(true);
  });

  it('refuses an action the actor does not hold the role for', () => {
    const tagging = tagGame();
    expect(refused(tagging.state, tagging.r1, tag(tagging.tagger))).toBe('INVALID_ROLE');
    expect(refused(tagging.state, tagging.r1, tag(tagging.r2))).toBe('INVALID_ROLE');

    const hiding = hideGame();
    expect(refused(hiding.state, hiding.h1, find(hiding.seeker))).toBe('INVALID_ROLE');
    expect(refused(hiding.state, hiding.h1, find(hiding.h2))).toBe('INVALID_ROLE');
  });

  it('refuses a target who does not exist, and a player acting on themselves', () => {
    const { state, tagger } = tagGame();
    expect(refused(state, tagger, tag('ghost'))).toBe('INVALID_PLAYER');
    expect(refused(state, tagger, tag(tagger))).toBe('INVALID_ACTION');
    const hiding = hideGame();
    expect(refused(hiding.state, hiding.seeker, find('ghost'))).toBe('INVALID_PLAYER');
    expect(refused(hiding.state, hiding.seeker, find(hiding.seeker))).toBe('INVALID_ACTION');
  });

  it('does not let one player use what belongs to another', () => {
    const { state, tagger, r1, r2 } = tagGame();
    const shielded = must(
      submitGameEvent(
        state,
        { type: 'POWER_UP', playerId: r1, powerId: 'shield' },
        'human',
        at(NOW),
      ),
    );
    const activate = { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' };
    // r2 and the tagger do not hold r1's shield.
    expect(refused(shielded, r2, activate, NOW + 1_000)).toBe('INVALID_ACTION');
    expect(refused(shielded, tagger, activate, NOW + 1_000)).toBe('INVALID_ACTION');

    // A challenge issued to r1 cannot be completed by r2. (Tag has no CHALLENGE
    // event, so this uses a bonus objective r2 has already completed instead.)
    const objective = must(
      submitGameEvent(
        state,
        {
          type: 'BONUS_OBJECTIVE',
          objectiveId: 'oak',
          description: 'Touch the big oak.',
          points: 2,
          durationSeconds: 60,
        },
        'human',
        at(NOW),
      ),
    );
    const complete = { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: 'oak' };
    const once = must(submitPlayerAction(objective, r2, complete, at(NOW + 1_000))).state;
    expect(refused(once, r2, complete, NOW + 2_000)).toBe('INVALID_ACTION');
    expect(scoreOf(once, r2)).toBe(2);
  });
});

describe('submitPlayerAction: when it may happen', () => {
  it('refuses gameplay actions before the game has started', () => {
    const state = lobby('tag', 3);
    expect(refused(state, 'p0', tag('p1'), 5)).toBe('INVALID_STATE_TRANSITION');
    expect(refused(state, 'p0', { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' }, 5)).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('refuses every action while the game is paused', () => {
    const { state, tagger, r1 } = tagGame();
    const paused = must(reduce(state, { type: 'PAUSE_SESSION', reason: 'water' }, at(NOW)));
    expect(refused(paused, tagger, tag(r1), NOW + 1_000)).toBe('INVALID_STATE_TRANSITION');
    expect(refused(paused, tagger, READY, NOW + 1_000)).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses every action once the game has ended', () => {
    const { state, tagger, r1 } = tagGame();
    const aborted = must(reduce(state, { type: 'ABORT_SESSION', reason: 'rain' }, at(NOW)));
    expect(refused(aborted, tagger, tag(r1), NOW + 1_000)).toBe('GAME_ALREADY_COMPLETED');

    const finished = must(advanceTime(state, at(START + 3 * 180_000)));
    expect(finished.status).toBe('completed');
    expect(refused(finished, tagger, tag(r1), START + 3 * 180_000 + 1)).toBe(
      'GAME_ALREADY_COMPLETED',
    );
    // A message that arrives after the last round ran out is refused the same way.
    expect(refused(state, tagger, tag(r1), START + 3 * 180_000 + 1)).toBe('GAME_ALREADY_COMPLETED');
  });

  it('refuses an action the game does not have', () => {
    const hiding = hideGame();
    expect(refused(hiding.state, hiding.seeker, tag(hiding.h1))).toBe('INVALID_ACTION');
    const tagging = tagGame();
    expect(refused(tagging.state, tagging.tagger, find(tagging.r1))).toBe('INVALID_ACTION');
  });

  it('refuses a message stamped earlier than the game has already seen', () => {
    const { state, tagger, r1, r2 } = tagGame();
    const next = must(submitPlayerAction(state, tagger, tag(r1), at(NOW))).state;
    expect(refused(next, r1, tag(r2), NOW - 1)).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses a state whose game is not registered, without throwing', () => {
    const state = { ...tagGame().state, gameId: 'quidditch' };
    expect(refused(state, 'p0', READY)).toBe('INVALID_GAME_CONFIGURATION');
  });
});

describe('submitPlayerAction: a refusal changes nothing', () => {
  it('records nothing, scores nothing and advances no time', () => {
    const { state, r1, r2 } = tagGame();
    // Sent after round 1 ran out, by a runner: the round end is not committed
    // either, because the whole step is refused.
    const result = submitPlayerAction(state, r1, tag(r2), at(START + 181_000));
    expect(codeOf(result)).toBe('INVALID_ROLE');
    expect(state.currentRound).toBe(1);
    expect(state.timer.endsAt).toBe(at(START + 180_000).now);
    expect(state.players.every((player) => player.score === 0)).toBe(true);
    expect(state.history.at(-1)?.record).toMatchObject({ kind: 'EVENT' });
  });

  it('never writes to the state it was given, even when it succeeds', () => {
    const { state, tagger, r1 } = tagGame();
    const snapshot = structuredClone(state);
    const outcome = must(submitPlayerAction(state, tagger, tag(r1), at(NOW)));
    expect(state).toEqual(snapshot);
    expect(outcome.state).not.toBe(state);
    expect(holders(state, 'tagger')).toEqual([tagger]);
  });

  it('does not keep a reference to the message it was given', () => {
    const { state, tagger, r1 } = tagGame();
    const message = { type: 'PLAYER_TAGGED', targetPlayerId: r1 };
    const outcome = must(submitPlayerAction(state, tagger, message, at(NOW)));
    message.targetPlayerId = 'someone-else';
    expect(outcome.action).toMatchObject({ targetPlayerId: r1 });
    expect(outcome.state.history.at(-2)?.record).toMatchObject({
      action: { targetPlayerId: r1 },
    });
  });
});

describe('submitPlayerAction: determinism', () => {
  it('gives the same result for the same state, actor, message and time', () => {
    const { state, tagger, r1 } = tagGame();
    const first = submitPlayerAction(state, tagger, tag(r1), at(NOW));
    const second = submitPlayerAction(state, tagger, tag(r1), at(NOW));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const refusedOnce = submitPlayerAction(state, r1, tag(tagger), at(NOW));
    expect(submitPlayerAction(state, r1, tag(tagger), at(NOW))).toEqual(refusedOnce);
  });

  it('reads no clock, random source, timer or network', () => {
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
      vi.spyOn(globalThis, 'fetch'),
    ];
    const { state, tagger, r1, r2 } = tagGame();
    const next = must(submitPlayerAction(state, tagger, tag(r1), at(NOW))).state;
    submitPlayerAction(next, r1, tag(r2), at(START + 181_000));
    submitPlayerAction(state, 'ghost', tag(r1), at(NOW));
    must(submitPlayerAction(lobby('tag', 2), 'p0', READY, at(5)));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('imports nothing but the engine, the definitions and shared helpers', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const file of ['submit-action.ts', 'process-action.ts', 'actions.ts', 'validate.ts']) {
      const source = readFileSync(join(directory, file), 'utf-8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
      for (const name of imports) {
        expect(
          name.startsWith('./') ||
            name === 'zod' ||
            name === '@touchgrass/shared' ||
            name === '@touchgrass/game-definitions',
          `${file} imports ${name}`,
        ).toBe(true);
      }
    }
  });
});

describe('submitPlayerAction: two messages at once', () => {
  it('judges the second against the state the first produced', () => {
    // The tagger's phone sends two tags in the same instant.
    const { state, tagger, r1, r2 } = tagGame();
    const first = must(submitPlayerAction(state, tagger, tag(r1), at(NOW)));
    // By then the tagger is a runner: the second tag is no longer theirs to make.
    expect(refused(first.state, tagger, tag(r2))).toBe('INVALID_ROLE');
    expect(holders(first.state, 'tagger')).toEqual([r1]);
    expect(scoreOf(first.state, tagger)).toBe(2);
  });

  it('refuses the same message sent twice', () => {
    const { state, seeker, h1 } = hideGame();
    const first = must(submitPlayerAction(state, seeker, find(h1), at(NOW)));
    expect(refused(first.state, seeker, find(h1))).toBe('INVALID_ACTION');
    expect(scoreOf(first.state, seeker)).toBe(2);
  });

  it('depends on the order the holder of the state chooses', () => {
    // A shield and a tag arrive together. Whichever is applied first decides.
    const { state, tagger, r1 } = tagGame();
    const armed = must(
      submitGameEvent(
        state,
        { type: 'POWER_UP', playerId: r1, powerId: 'shield' },
        'human',
        at(NOW),
      ),
    );
    const activate = { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' };

    const shieldFirst = must(submitPlayerAction(armed, r1, activate, at(NOW + 1_000)));
    expect(refused(shieldFirst.state, tagger, tag(r1), NOW + 1_000)).toBe('INVALID_ACTION');

    const tagFirst = must(submitPlayerAction(armed, tagger, tag(r1), at(NOW + 1_000)));
    expect(holders(tagFirst.state, 'tagger')).toEqual([r1]);
    // r1 may still raise the shield afterwards; it no longer undoes the tag.
    const after = must(submitPlayerAction(tagFirst.state, r1, activate, at(NOW + 1_000)));
    expect(holders(after.state, 'tagger')).toEqual([r1]);
  });

  it('gives two independent results when called twice on the same state', () => {
    // Two callers that both held the old state would each get a different
    // future. Neither changes the other or the state they started from.
    const { state, tagger, r1, r2 } = tagGame();
    const a = must(submitPlayerAction(state, tagger, tag(r1), at(NOW)));
    const b = must(submitPlayerAction(state, tagger, tag(r2), at(NOW)));
    expect(holders(a.state, 'tagger')).toEqual([r1]);
    expect(holders(b.state, 'tagger')).toEqual([r2]);
    expect(holders(state, 'tagger')).toEqual([tagger]);
    // Both claim the same history positions, which is how a holder can tell.
    expect(a.entries.map((entry) => entry.sequence)).toEqual(
      b.entries.map((entry) => entry.sequence),
    );
  });

  it('numbers entries without gaps across a run of accepted and refused messages', () => {
    const { state, tagger, r1, r2 } = tagGame();
    let current = state;
    const sequences: number[] = [];
    const messages: [string, object][] = [
      [tagger, tag(r1)],
      [tagger, tag(r2)], // refused
      [r1, tag(r2)],
      ['ghost', READY], // refused
      [r2, tag(tagger)],
    ];
    for (const [index, [actor, message]] of messages.entries()) {
      const result = submitPlayerAction(current, actor, message, at(NOW + index * 1_000));
      if (!result.ok) continue;
      sequences.push(...result.value.entries.map((entry) => entry.sequence));
      current = result.value.state;
    }
    const firstNew = state.history.length;
    expect(sequences).toEqual(sequences.map((_, index) => firstNew + index));
    expect(current.history).toHaveLength(firstNew + sequences.length);
    expect(holders(current, 'tagger')).toEqual([tagger]);
  });
});

describe('submitPlayerAction: Tag', () => {
  it('a tag swaps the two roles and scores TAG_MADE +2', () => {
    const { state, tagger, r1, r2 } = tagGame();
    const outcome = must(submitPlayerAction(state, tagger, tag(r1), at(NOW)));
    expect(holders(outcome.state, 'tagger')).toEqual([r1]);
    expect(holders(outcome.state, 'runner').sort()).toEqual([tagger, r2].sort());
    expect(outcome.entries[1]).toMatchObject({
      record: {
        kind: 'EVENT',
        event: {
          type: 'ROLE_CHANGE',
          cause: { reason: 'TAGGED', byPlayerId: tagger, targetPlayerId: r1 },
        },
      },
      awards: [{ playerId: tagger, reason: 'TAG_MADE', points: 2 }],
    });
    expect(scoreOf(outcome.state, tagger)).toBe(2);
  });

  it('activating a shield causes POWER_ACTIVATED and blocks a tag for 20 seconds', () => {
    const { state, tagger, r1 } = tagGame();
    const armed = must(
      submitGameEvent(
        state,
        { type: 'POWER_UP', playerId: r1, powerId: 'shield' },
        'human',
        at(NOW),
      ),
    );
    const outcome = must(
      submitPlayerAction(
        armed,
        r1,
        { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' },
        at(NOW + 1_000),
      ),
    );
    expect(kinds(outcome)).toEqual(['ACTION', 'POWER_ACTIVATED']);
    expect(outcome.entries[1]?.record).toMatchObject({
      event: { type: 'POWER_ACTIVATED', playerId: r1, powerId: 'shield', durationSeconds: 20 },
    });
    expect(outcome.state.players.find((player) => player.id === r1)?.powers).toEqual([]);

    expect(refused(outcome.state, tagger, tag(r1), NOW + 20_999)).toBe('INVALID_ACTION');
    expect(submitPlayerAction(outcome.state, tagger, tag(r1), at(NOW + 21_000)).ok).toBe(true);
    // A power cannot be used twice, or one the game does not have.
    expect(
      refused(
        outcome.state,
        r1,
        { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' },
        NOW + 2_000,
      ),
    ).toBe('INVALID_ACTION');
    expect(
      refused(
        outcome.state,
        r1,
        { type: 'PLAYER_ACTIVATED_POWER', powerId: 'jetpack' },
        NOW + 2_000,
      ),
    ).toBe('INVALID_ACTION');
  });

  it('completing an objective causes OBJECTIVE_COMPLETED and scores its points once', () => {
    const { state, r1 } = tagGame();
    const objective = must(
      submitGameEvent(
        state,
        {
          type: 'BONUS_OBJECTIVE',
          objectiveId: 'oak',
          description: 'Touch the big oak.',
          points: 3,
          durationSeconds: 30,
        },
        'human',
        at(NOW),
      ),
    );
    const complete = { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: 'oak' };
    const outcome = must(submitPlayerAction(objective, r1, complete, at(NOW + 1_000)));
    expect(kinds(outcome)).toEqual(['ACTION', 'OBJECTIVE_COMPLETED']);
    expect(scoreOf(outcome.state, r1)).toBe(3);
    // Not one that does not exist, and not after it has run out.
    expect(refused(objective, r1, { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: 'elm' })).toBe(
      'INVALID_ACTION',
    );
    expect(refused(objective, r1, complete, NOW + 30_000)).toBe('INVALID_ACTION');
  });

  it('runners who were not tagged score ROUND_SURVIVED +1 when the round ends', () => {
    const { state, tagger, r1, r2 } = tagGame();
    const tagged = must(submitPlayerAction(state, tagger, tag(r1), at(NOW))).state;
    const ended = must(advanceTime(tagged, at(START + 180_000)));
    expect(scoreOf(ended, r2)).toBe(1);
    expect(scoreOf(ended, r1)).toBe(0);
    // The first tagger made a tag (+2) and ended the round as an untagged runner (+1).
    expect(scoreOf(ended, tagger)).toBe(3);
  });
});

describe('submitPlayerAction: Hide & Seek', () => {
  it('a find puts the hider out, keeps their role and scores FOUND_PLAYER +2', () => {
    const { state, seeker, h1 } = hideGame();
    const outcome = must(submitPlayerAction(state, seeker, find(h1), at(NOW)));
    expect(kinds(outcome)).toEqual(['ACTION', 'PLAYER_OUT']);
    expect(outcome.entries[1]).toMatchObject({
      record: { event: { type: 'PLAYER_OUT', playerId: h1, byPlayerId: seeker, reason: 'FOUND' } },
      awards: [{ playerId: seeker, reason: 'FOUND_PLAYER', points: 2 }],
    });
    const found = outcome.state.players.find((player) => player.id === h1);
    expect(found).toMatchObject({ status: 'out', roleId: 'hider' });
    expect(holders(outcome.state, 'seeker')).toEqual([seeker]);
  });

  it('scores ALL_FOUND +2 and no STAYED_HIDDEN when everyone was found', () => {
    const { state, seeker, h1, h2 } = hideGame();
    const one = must(submitPlayerAction(state, seeker, find(h1), at(NOW))).state;
    const both = must(submitPlayerAction(one, seeker, find(h2), at(NOW + 1_000))).state;
    const ended = must(advanceTime(both, at(START + 300_000)));
    expect(scoreOf(ended, seeker)).toBe(6);
    expect(scoreOf(ended, h1)).toBe(0);
    expect(scoreOf(ended, h2)).toBe(0);
  });

  it('scores STAYED_HIDDEN +3 for a hider who was not found', () => {
    const { state, seeker, h1, h2 } = hideGame();
    const one = must(submitPlayerAction(state, seeker, find(h1), at(NOW))).state;
    const ended = must(advanceTime(one, at(START + 300_000)));
    expect(scoreOf(ended, h2)).toBe(3);
    expect(scoreOf(ended, h1)).toBe(0);
    expect(scoreOf(ended, seeker)).toBe(2);
  });

  it('has no power to activate', () => {
    const { state, h1 } = hideGame();
    expect(refused(state, h1, { type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' })).toBe(
      'INVALID_ACTION',
    );
  });
});

describe('submitPlayerAction: PLAYER_READY', () => {
  it('marks only the actor ready, and causes no event', () => {
    const state = deepFreeze(lobby('tag', 3));
    const outcome = must(submitPlayerAction(state, 'p1', READY, at(5)));
    expect(outcome.state.players.map((player) => player.ready)).toEqual([false, true, false]);
    expect(kinds(outcome)).toEqual(['ACTION']);
    expect(outcome.state.status).toBe('lobby');
  });

  it('starts the game when the last player is ready', () => {
    let state = lobby('tag', 3);
    state = must(submitPlayerAction(state, 'p0', READY, at(5))).state;
    state = must(submitPlayerAction(state, 'p1', READY, at(6))).state;
    const last = must(submitPlayerAction(state, 'p2', READY, at(7)));
    expect(kinds(last)).toEqual(['ACTION', 'ROLES_ASSIGNED', 'ROUND_START']);
    expect(last.state.status).toBe('active');
    expect(holders(last.state, 'tagger')).toHaveLength(1);
    expect(last.state.timer.endsAt).toBe(at(7).now + 180_000);
  });

  it('does not start a game with too few players', () => {
    const outcome = must(submitPlayerAction(lobby('tag', 1), 'p0', READY, at(5)));
    expect(outcome.state.status).toBe('lobby');
  });

  it('cannot be reported for someone else, or after the game has started', () => {
    const state = lobby('tag', 3);
    expect(refused(state, 'p0', { ...READY, playerId: 'p1' }, 5)).toBe('INVALID_ACTION');
    const { state: running, r1 } = tagGame();
    expect(refused(running, r1, READY)).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('submitPlayerAction: PLAYER_ACCEPTED_EVENT', () => {
  function announced(): { state: GameState; eventId: string } {
    const state = must(
      submitGameEvent(tagGame().state, { type: 'TIME_EXTENSION', seconds: 30 }, 'human', at(NOW)),
    );
    return { state: deepFreeze(state), eventId: state.history.at(-1)?.id ?? '' };
  }

  it('is recorded and changes nothing else', () => {
    const { state, eventId } = announced();
    const outcome = must(
      submitPlayerAction(state, 'p1', { type: 'PLAYER_ACCEPTED_EVENT', eventId }, at(NOW + 1_000)),
    );
    expect(kinds(outcome)).toEqual(['ACTION']);
    expect(outcome.action).toEqual({ type: 'PLAYER_ACCEPTED_EVENT', playerId: 'p1', eventId });
    expect({ ...outcome.state, history: [] }).toEqual({ ...state, history: [] });
  });

  it('must name an event in this game, and carries nothing else', () => {
    const { state, eventId } = announced();
    const accept = { type: 'PLAYER_ACCEPTED_EVENT', eventId };
    expect(refused(state, 'p1', { ...accept, eventId: 'nope' }, NOW + 1_000)).toBe(
      'INVALID_ACTION',
    );
    // The id of an entry that is not an event.
    expect(
      refused(state, 'p1', { ...accept, eventId: state.history[0]?.id ?? '' }, NOW + 1_000),
    ).toBe('INVALID_ACTION');
    expect(refused(state, 'p1', { ...accept, points: 5 }, NOW + 1_000)).toBe('INVALID_ACTION');
    expect(refused(state, 'ghost', accept, NOW + 1_000)).toBe('INVALID_PLAYER');
  });
});
