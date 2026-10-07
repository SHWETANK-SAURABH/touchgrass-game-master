import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import { type GameState, contextAt, reduce, submitGameEvent } from '@touchgrass/game-engine';
import { createGameMaster } from '../game-master/game-master';
import {
  T0,
  deepFreeze,
  lobbyState,
  runningState,
  scriptedProvider,
} from '../game-master/test-support';
import { ModelProviderError } from '../provider/errors';
import { handOffProposal, runGameMasterTurn, validateGameMasterProposal } from './handoff';

const RATIONALE = 'The round has gone quiet and needs one small change.';
const at = (ms: number) => contextAt(fixedClock(T0 + ms));
const NOW = 61_000;

const proposal = (event: unknown) => ({ rationale: RATIONALE, event });
const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };

function holders(state: GameState, roleId: string): string[] {
  return state.players.filter((player) => player.roleId === roleId).map((player) => player.id);
}

/** Hands a proposal off against a frozen state and checks the state is left exactly as it was. */
function handOffFrozen(event: unknown, gameId: 'tag' | 'hide-and-seek' = 'tag') {
  const state = deepFreeze(runningState(gameId));
  const snapshot = structuredClone(state);
  const result = handOffProposal(proposal(event), state, at(NOW));
  expect(state).toEqual(snapshot);
  return { state, result };
}

describe('handOffProposal: valid proposals', () => {
  it('applies a valid Tag event through the engine', () => {
    const state = runningState('tag');
    const result = handOffProposal(proposal(zone), state, at(NOW));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('APPLIED');
    expect(result.value.state.activeModifiers).toEqual([
      expect.objectContaining({
        kind: 'SAFE_ZONE',
        zone: 'the bench',
        expiresAt: T0 + NOW + 60_000,
      }),
    ]);
    expect(result.value.state.history.at(-1)).toMatchObject({
      source: 'game-master',
      record: { kind: 'EVENT', event: zone },
    });
    expect(result.value.proposal.rationale).toBe(RATIONALE);
  });

  it('applies a valid Hide & Seek event through the engine', () => {
    const state = runningState('hide-and-seek');
    const before = state.timer.endsAt ?? 0;
    const result = handOffProposal(
      proposal({ type: 'TIME_EXTENSION', seconds: 60 }),
      state,
      at(NOW),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.timer.endsAt).toBe(before + 60_000);
  });

  it('gives exactly the state the engine gives for the same event', () => {
    const state = runningState('tag');
    const viaHandoff = handOffProposal(proposal(zone), state, at(NOW));
    const viaEngine = submitGameEvent(state, zone, 'game-master', at(NOW));
    expect(viaHandoff.ok && viaEngine.ok).toBe(true);
    if (!viaHandoff.ok || !viaEngine.ok) return;
    expect(viaHandoff.value.state).toEqual(viaEngine.value);
  });

  it('applies a legal role swap and awards nothing for it', () => {
    const state = runningState('tag');
    const [tagger] = holders(state, 'tagger');
    const [runner] = holders(state, 'runner');
    const result = handOffProposal(
      proposal({
        type: 'ROLE_CHANGE',
        assignments: [
          { playerId: runner, roleId: 'tagger' },
          { playerId: tagger, roleId: 'runner' },
        ],
      }),
      state,
      at(NOW),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(holders(result.value.state, 'tagger')).toEqual([runner]);
    expect(result.value.state.players.every((player) => player.score === 0)).toBe(true);
  });

  it('is deterministic: the same state and proposal give the same state', () => {
    const state = runningState('tag');
    const first = handOffProposal(proposal(zone), state, at(NOW));
    const second = handOffProposal(proposal(zone), state, at(NOW));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('handOffProposal: null proposals', () => {
  it('treats event: null as a no-op, not an error', () => {
    const state = deepFreeze(runningState('tag'));
    const result = handOffProposal(proposal(null), state, at(NOW));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('NO_EVENT');
    // The very same state object comes back: nothing was applied or recorded.
    expect(result.value.state).toBe(state);
    expect(result.value.state.history).toHaveLength(state.history.length);
  });

  it('does not act on what the rationale says', () => {
    // A real Gemma reply paired event: null with a rationale that was untrue.
    const state = deepFreeze(runningState('hide-and-seek'));
    const result = handOffProposal(
      { rationale: 'Player 1 has found Player 0, and the round is ending.', event: null },
      state,
      at(NOW),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe(state);
    expect(result.value.state.players.every((player) => player.status === 'active')).toBe(true);
    expect(result.value.state.currentRound).toBe(1);
  });

  it('still requires a well-formed proposal around the null', () => {
    const result = handOffProposal({ event: null }, runningState('tag'), at(NOW));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('SCHEMA');
  });
});

describe('handOffProposal: rejected at the schema stage', () => {
  it.each([
    { type: 'ROUND_START', round: 2, durationSeconds: 180 },
    { type: 'ROUND_END', round: 1 },
    { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
    { type: 'PLAYER_OUT', playerId: 'p1', byPlayerId: 'p0', reason: 'FOUND' },
    { type: 'POWER_ACTIVATED', playerId: 'p1', powerId: 'shield', durationSeconds: 20 },
    { type: 'OBJECTIVE_COMPLETED', playerId: 'p1', objectiveId: 'o1', points: 5 },
  ])('rejects the engine-only event $type', (event) => {
    const { result } = handOffFrozen(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('SCHEMA');
  });

  it('rejects a ROLE_CHANGE that claims to be a tag', () => {
    const { result } = handOffFrozen({
      type: 'ROLE_CHANGE',
      assignments: [
        { playerId: 'p1', roleId: 'tagger' },
        { playerId: 'p0', roleId: 'runner' },
      ],
      cause: { reason: 'TAGGED', byPlayerId: 'p0', targetPlayerId: 'p1' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('SCHEMA');
  });

  it('rejects an event kind the game does not allow', () => {
    const { result } = handOffFrozen({
      type: 'CHALLENGE',
      challengeId: 'c1',
      description: 'Touch three trees.',
      playerIds: ['p0'],
      points: 2,
      durationSeconds: 60,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('SCHEMA');
  });

  it('rejects malformed proposals', () => {
    for (const raw of [
      null,
      'ZONE_CHANGE',
      { rationale: RATIONALE },
      { ...proposal(zone), score: 9 },
    ]) {
      const state = deepFreeze(runningState('tag'));
      const result = handOffProposal(raw, state, at(NOW));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.stage).toBe('SCHEMA');
    }
  });
});

describe('handOffProposal: schema-valid but not game-valid', () => {
  const rejected = (event: unknown, code: string, gameId: 'tag' | 'hide-and-seek' = 'tag') => {
    const { result } = handOffFrozen(event, gameId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('STATE');
    if (result.error.stage === 'STATE') expect(result.error.error.code).toBe(code);
  };

  it('rejects an unknown player', () => {
    rejected({ type: 'POWER_UP', playerId: 'ghost', powerId: 'shield' }, 'INVALID_PLAYER');
    rejected(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'ghost', roleId: 'runner' }] },
      'INVALID_PLAYER',
    );
  });

  it('rejects an unknown role', () => {
    rejected(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p0', roleId: 'wizard' }] },
      'INVALID_ROLE',
    );
    rejected(
      {
        type: 'RULE_MODIFIER',
        modifier: 'FREEZE_PERIOD',
        roleIds: ['wizard'],
        durationSeconds: 30,
      },
      'INVALID_ROLE',
      'hide-and-seek',
    );
  });

  it('rejects an unknown power', () => {
    rejected({ type: 'POWER_UP', playerId: 'p0', powerId: 'jetpack' }, 'INVALID_EVENT');
  });

  it('rejects a role change that would leave two taggers', () => {
    const [runner] = holders(runningState('tag'), 'runner');
    rejected(
      { type: 'ROLE_CHANGE', assignments: [{ playerId: runner, roleId: 'tagger' }] },
      'INVALID_ROLE',
    );
  });

  it('rejects a power the player already holds', () => {
    const grant = { type: 'POWER_UP', playerId: 'p2', powerId: 'shield' };
    const holding = submitGameEvent(runningState('tag'), grant, 'game-master', at(NOW));
    if (!holding.ok) throw new Error('fixture failed');
    const state = deepFreeze(holding.value);
    const snapshot = structuredClone(state);

    const result = handOffProposal(proposal(grant), state, at(NOW + 2_000));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('STATE');
    expect(state).toEqual(snapshot);
    expect(state.players.find((player) => player.id === 'p2')?.powers).toEqual(['shield']);
  });

  it('cannot be widened by a doctored definition', async () => {
    // Regression: the hand-off used to take the definition from its caller. A
    // copy of Hide & Seek that claimed to allow POWER_UP could then get a
    // made-up power applied. The definition now comes from the registry only.
    const state = deepFreeze(runningState('hide-and-seek'));
    const snapshot = structuredClone(state);
    const grant = proposal({ type: 'POWER_UP', playerId: 'p0', powerId: 'godmode' });

    const direct = handOffProposal(grant, state, at(NOW));
    expect(!direct.ok && direct.error.stage).toBe('SCHEMA');

    // Even a Game Master that returns such a proposal as if it were valid.
    const viaTurn = await runGameMasterTurn({
      gameMaster: {
        propose: () =>
          Promise.resolve({
            ok: true as const,
            value: {
              proposal: grant as never,
              attempts: 1,
              provider: 'doctored',
              model: 'doctored',
            },
          }),
      },
      state,
      ctx: at(NOW),
    });
    expect(!viaTurn.ok && viaTurn.error.stage).toBe('SCHEMA');
    expect(state).toEqual(snapshot);
    expect(handOffProposal.length).toBe(3);
  });

  it('rejects an event when the game is not in a running round', () => {
    const inLobby = handOffProposal(proposal(zone), deepFreeze(lobbyState('tag')), at(5));
    expect(!inLobby.ok && inLobby.error.stage).toBe('STATE');

    const paused = reduce(runningState('tag'), { type: 'PAUSE_SESSION', reason: 'water' }, at(NOW));
    if (!paused.ok) throw new Error('fixture failed');
    const whilePaused = handOffProposal(proposal(zone), deepFreeze(paused.value), at(NOW + 1_000));
    expect(!whilePaused.ok && whilePaused.error.stage).toBe('STATE');

    const afterTheEnd = handOffProposal(
      proposal(zone),
      deepFreeze(runningState('tag')),
      at(1_000 + 3 * 180_000 + 1),
    );
    expect(!afterTheEnd.ok && afterTheEnd.error.stage).toBe('STATE');
    if (!afterTheEnd.ok && afterTheEnd.error.stage === 'STATE') {
      expect(afterTheEnd.error.error.code).toBe('GAME_ALREADY_COMPLETED');
    }
  });

  it('refuses a state whose game is not a registered definition', () => {
    const state = deepFreeze({ ...runningState('tag'), gameId: 'quidditch' });
    const result = handOffProposal(proposal(zone), state, at(NOW));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('SCHEMA');
  });

  it.each([
    [
      'playerId "123", roleId "merchant"',
      { type: 'ROLE_CHANGE', assignments: [{ playerId: '123', roleId: 'merchant' }] },
    ],
    [
      'playerId "P123", powerId "speedBoost"',
      { type: 'POWER_UP', playerId: 'P123', powerId: 'speedBoost' },
    ],
    [
      'a real player, powerId "speedBoost"',
      { type: 'POWER_UP', playerId: 'p0', powerId: 'speedBoost' },
    ],
    [
      'a real player, roleId "merchant"',
      { type: 'ROLE_CHANGE', assignments: [{ playerId: 'p0', roleId: 'merchant' }] },
    ],
  ])('rejects the real-model output with %s, and creates nothing', (_label, event) => {
    const { state, result } = handOffFrozen(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('STATE');
    expect(state.players.map((player) => player.id)).toEqual(['p0', 'p1', 'p2']);
    expect(state.players.every((player) => player.powers.length === 0)).toBe(true);
  });
});

describe('handOffProposal: legal in the game but not safe', () => {
  const objective = (description: string, durationSeconds = 60) => ({
    type: 'BONUS_OBJECTIVE',
    objectiveId: 'o1',
    description,
    points: 2,
    durationSeconds,
  });

  const unsafe = (event: unknown, hazard: string, gameId: 'tag' | 'hide-and-seek' = 'tag') => {
    // The engine accepts the event: it is legal in this game right now.
    expect(submitGameEvent(runningState(gameId), event, 'game-master', at(NOW)).ok).toBe(true);

    const { state, result } = handOffFrozen(event, gameId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('SAFETY');
    if (result.error.stage !== 'SAFETY' || result.error.rejection.kind !== 'UNSAFE') {
      throw new Error('expected an UNSAFE safety rejection');
    }
    const { verdict } = result.error.rejection;
    expect(verdict.disposition).not.toBe('allow');
    expect(verdict.violations.map((entry) => entry.hazard)).toContain(hazard);
    // Nothing was recorded, scored or announced.
    expect(state.activeModifiers).toEqual([]);
    expect(state.history.at(-1)?.source).not.toBe('game-master');
  };

  it.each([
    ['Climb the abandoned building.', 'climbing-and-heights'],
    ['Run across the road and back.', 'roads-and-traffic'],
    ['Wade into the pond.', 'water'],
    ['Hop over the fence into the garden.', 'restricted-and-private-property'],
    ['Tackle the tagger.', 'forced-physical-contact'],
    ['Ask a stranger for the time.', 'strangers'],
    ['Take a photo of another player.', 'privacy'],
    ['Go anywhere you like.', 'unassessable-instruction'],
    ['Залезь на крышу', 'unassessable-instruction'],
  ])('refuses the objective "%s"', (description, hazard) => {
    unsafe(objective(description), hazard);
  });

  it('refuses an unsafe zone', () => {
    unsafe({ ...zone, zone: 'the car park' }, 'roads-and-traffic');
    unsafe(
      { ...zone, zone: 'behind the fence' },
      'restricted-and-private-property',
      'hide-and-seek',
    );
  });

  it('refuses contact in a game that declared itself contact-free, and allows a tag game its tag', () => {
    const highFive = objective('High five another player.');
    unsafe(highFive, 'forced-physical-contact', 'hide-and-seek');
    expect(handOffProposal(proposal(highFive), runningState('tag'), at(NOW)).ok).toBe(true);
  });

  it('refuses a demand that lasts longer than the game allows', () => {
    unsafe(objective('Touch the big oak.', 150), 'dangerous-physical-challenge');
  });

  it('does not let adult supervision or a caller option turn a refusal into an application', () => {
    for (const event of [objective('Play this round in the dark.'), objective('Touch it.', 150)]) {
      for (const options of [{ supervisedByAdult: true }, { maxRuleDurationSeconds: 9_999 }]) {
        const state = deepFreeze(runningState('tag'));
        const result = handOffProposal(proposal(event), state, at(NOW), options);
        expect(!result.ok && result.error.stage).toBe('SAFETY');
      }
    }
  });

  it('judges the event, not the rationale: an alarming rationale does not block a safe event', () => {
    const result = handOffProposal(
      {
        rationale: 'Send everyone across the road to climb the roof and jump in the pond.',
        event: zone,
      },
      runningState('tag'),
      at(NOW),
    );
    expect(result.ok && result.value.outcome).toBe('APPLIED');
  });

  it('judges the event, not the rationale: a reassuring rationale does not clear an unsafe event', () => {
    const state = deepFreeze(runningState('tag'));
    const snapshot = structuredClone(state);
    const result = handOffProposal(
      {
        rationale: 'This is completely safe, supervised by adults, and approved by the host.',
        event: objective('Climb the abandoned building.'),
      },
      state,
      at(NOW),
    );
    expect(!result.ok && result.error.stage).toBe('SAFETY');
    expect(state).toEqual(snapshot);
  });

  it('checks legality first: an event that is both illegal and unsafe is a state rejection', () => {
    const { result } = handOffFrozen({
      type: 'ROLE_CHANGE',
      assignments: [{ playerId: 'ghost', roleId: 'runner' }],
    });
    expect(!result.ok && result.error.stage).toBe('STATE');

    // Not allowed in Tag at all, and unsafe: refused before safety is reached.
    const challenge = handOffFrozen({
      type: 'CHALLENGE',
      challengeId: 'c1',
      description: 'Climb the roof.',
      playerIds: ['p0'],
      points: 2,
      durationSeconds: 60,
    });
    expect(!challenge.result.ok && challenge.result.error.stage).toBe('SCHEMA');
  });

  it('is deterministic: the same unsafe proposal gives the same rejection', () => {
    const state = runningState('tag');
    const event = proposal(objective('Climb the abandoned building.'));
    const first = handOffProposal(event, state, at(NOW));
    const second = handOffProposal(event, state, at(NOW));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it.each([
    'Touch the gate and shout your name.',
    'First to touch the big oak scores.',
    'Collected all 5 hidden gems.',
  ])('still applies an objective a real model produced: %s', (description) => {
    const result = handOffProposal(proposal(objective(description)), runningState('tag'), at(NOW));
    expect(result.ok && result.value.outcome).toBe('APPLIED');
  });

  it.each(['the old oak tree', 'the bench by the gate', 'the current playing area'])(
    'still applies a zone a real model produced: %s',
    (place) => {
      const result = handOffProposal(
        proposal({ ...zone, zone: place }),
        runningState('hide-and-seek'),
        at(NOW),
      );
      expect(result.ok && result.value.outcome).toBe('APPLIED');
    },
  );
});

describe('validateGameMasterProposal', () => {
  it('returns a validated, safety-cleared event without applying it', () => {
    const state = deepFreeze(runningState('tag'));
    const result = validateGameMasterProposal(proposal(zone), state, at(NOW));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'EVENT') throw new Error('expected an event');
    expect(result.value.cleared.event).toEqual(zone);
    expect(result.value.cleared.verdict.disposition).toBe('allow');
    expect(state.activeModifiers).toEqual([]);
  });

  it('returns a safety rejection, not a cleared event, for an unsafe proposal', () => {
    const state = deepFreeze(runningState('tag'));
    const result = validateGameMasterProposal(
      proposal({ ...zone, zone: 'the car park' }),
      state,
      at(NOW),
    );
    expect(!result.ok && result.error.stage).toBe('SAFETY');
    expect(Object.keys(result)).not.toContain('value');
  });

  it('returns NO_EVENT for a null proposal', () => {
    const result = validateGameMasterProposal(proposal(null), runningState('tag'), at(NOW));
    expect(result.ok && result.value.kind).toBe('NO_EVENT');
  });
});

describe('runGameMasterTurn', () => {
  const turn = (reply: object | string | Error, state = runningState('tag')) =>
    runGameMasterTurn({
      gameMaster: createGameMaster({ provider: scriptedProvider([reply]), maxRepairAttempts: 0 }),
      state,
      ctx: at(NOW),
    });

  it('asks the Game Master, validates the proposal, and has the engine apply it', async () => {
    const state = deepFreeze(runningState('tag'));
    const result = await turn(proposal(zone), state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('APPLIED');
    expect(result.value.state.activeModifiers).toHaveLength(1);
    // The state that was passed in is untouched; a new state is returned.
    expect(state.activeModifiers).toEqual([]);
  });

  it('returns the same state when the Game Master proposes nothing', async () => {
    const state = deepFreeze(runningState('tag'));
    const result = await turn(proposal(null), state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('NO_EVENT');
    expect(result.value.state).toBe(state);
  });

  it('leaves the game unchanged when the model names things that do not exist', async () => {
    const state = deepFreeze(runningState('tag'));
    const snapshot = structuredClone(state);
    const result = await turn(
      proposal({ type: 'POWER_UP', playerId: 'p123', powerId: 'speedBoost' }),
      state,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('STATE');
    expect(state).toEqual(snapshot);
  });

  it('does not ask the model again after a state rejection', async () => {
    const provider = scriptedProvider([
      proposal({ type: 'POWER_UP', playerId: 'p123', powerId: 'speedBoost' }),
      proposal(zone),
    ]);
    const result = await runGameMasterTurn({
      gameMaster: createGameMaster({ provider, maxRepairAttempts: 3 }),
      state: runningState('tag'),
      ctx: at(NOW),
    });
    // The first reply is schema-valid, so no repair is triggered; the engine's
    // refusal is final and the second, valid reply is never requested.
    expect(result.ok).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it('refuses an unsafe proposal from the Game Master and does not ask it again', async () => {
    const provider = scriptedProvider([
      proposal({ ...zone, zone: 'the car park across the road' }),
      proposal(zone),
    ]);
    const state = deepFreeze(runningState('tag'));
    const snapshot = structuredClone(state);
    const result = await runGameMasterTurn({
      gameMaster: createGameMaster({ provider, maxRepairAttempts: 3 }),
      state,
      ctx: at(NOW),
    });
    expect(!result.ok && result.error.stage).toBe('SAFETY');
    // The safety refusal is final: nothing rewrites the event or requests another.
    expect(provider.requests).toHaveLength(1);
    expect(state).toEqual(snapshot);
  });

  it('passes safety options through, and they can only tighten', async () => {
    const objective = {
      type: 'BONUS_OBJECTIVE',
      objectiveId: 'o1',
      description: 'Touch the big oak.',
      points: 2,
      durationSeconds: 60,
    };
    const run = (safety?: { maxRuleDurationSeconds: number }) =>
      runGameMasterTurn({
        gameMaster: createGameMaster({ provider: scriptedProvider([proposal(objective)]) }),
        state: runningState('tag'),
        ctx: at(NOW),
        ...(safety ? { safety } : {}),
      });
    expect((await run()).ok).toBe(true);
    const strict = await run({ maxRuleDurationSeconds: 30 });
    expect(!strict.ok && strict.error.stage).toBe('SAFETY');
  });

  it('reports a model failure at the proposal stage and applies nothing', async () => {
    const state = deepFreeze(runningState('tag'));
    const snapshot = structuredClone(state);
    const result = await turn(
      new ModelProviderError('PROVIDER_UNREACHABLE', 'ollama is down'),
      state,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('PROPOSAL');
    if (result.error.stage === 'PROPOSAL') {
      expect(result.error.error.code).toBe('MODEL_UNAVAILABLE');
    }
    expect(state).toEqual(snapshot);
  });

  it('reports an engine-only event at the proposal stage', async () => {
    const result = await turn(proposal({ type: 'GAME_END', reason: 'ROUNDS_COMPLETE' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('PROPOSAL');
    if (result.error.stage === 'PROPOSAL') expect(result.error.error.code).toBe('INVALID_PROPOSAL');
  });

  it('does not call the model for a game that is not running', async () => {
    const provider = scriptedProvider([proposal(zone)]);
    const result = await runGameMasterTurn({
      gameMaster: createGameMaster({ provider }),
      state: lobbyState('tag'),
      ctx: at(5),
    });
    expect(result.ok).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('the hand-off owns no rules and has one way into the engine', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(directory, 'handoff.ts'), 'utf-8');

  it('uses only the engine validate and apply functions of the trust boundary', () => {
    const imported = [
      ...source.matchAll(/import\s+\{([^}]*)\}\s+from\s+'@touchgrass\/game-engine'/g),
    ]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim())
      .filter((name) => name !== '' && !name.startsWith('type '));
    expect(imported.sort()).toEqual(['applyValidatedEvent', 'validateExternalEvent']);
  });

  it('reaches the engine apply function only with what the safety package released', () => {
    const imported = [...source.matchAll(/import\s+\{([^}]*)\}\s+from\s+'@touchgrass\/safety'/g)]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim())
      .filter((name) => name !== '' && !name.startsWith('type '));
    expect(imported.sort()).toEqual(['releaseClearedEvent', 'validateSafety']);

    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const calls = [...code.matchAll(/applyValidatedEvent\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls).toEqual(['state, released.value, ctx']);
    // The engine's validated event is passed to the safety validator and nowhere else.
    expect(code.match(/validated\.value\b(?!\.(?:kind|proposal|cleared))/g)).toHaveLength(1);
    expect(code).toContain('validateSafety(validated.value, state, safety)');
  });

  it('keeps the Game Master module free of it', () => {
    const gameMaster = readFileSync(
      join(directory, '..', 'game-master', 'game-master.ts'),
      'utf-8',
    );
    expect(gameMaster).not.toMatch(
      /handoff|applyValidatedEvent|validateExternalEvent|@touchgrass\/safety/,
    );
  });
});
