import { describe, expect, it } from 'vitest';
import { fixedClock, ok } from '@touchgrass/shared';
import {
  type GameState,
  applyValidatedEvent,
  contextAt,
  engineError,
  reduce,
} from '@touchgrass/game-engine';
import { T0, deepFreeze, runningState } from '../game-master/test-support';
import { type ProposalTarget, handOffProposal, handOffProposalTo } from './handoff';

const at = (ms: number) => contextAt(fixedClock(T0 + ms));
const NOW = 61_000;
const RATIONALE = 'The round has gone quiet and needs one small change.';
const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };
const proposal = (event: unknown) => ({ rationale: RATIONALE, event });

/** Something that holds a game, as a live session does, and counts what reaches it. */
function holder(initial: GameState) {
  let current = deepFreeze(initial);
  const applied: unknown[] = [];
  const target: ProposalTarget = {
    getState: () => current,
    applyEvent(validated, ctx) {
      applied.push(validated);
      const next = applyValidatedEvent(current, validated, ctx);
      if (!next.ok) return next;
      current = deepFreeze(next.value);
      return ok({ state: current });
    },
  };
  return {
    target,
    applied,
    state: () => current,
    set(next: GameState): void {
      current = deepFreeze(next);
    },
  };
}

describe('handing a proposal to something that holds a game', () => {
  it('does exactly what the hand-off for a plain state does', () => {
    const state = deepFreeze(runningState('tag'));
    const held = holder(state);
    const viaTarget = handOffProposalTo(held.target, proposal(zone), at(NOW));
    const viaState = handOffProposal(proposal(zone), state, at(NOW));
    expect(viaTarget).toEqual(viaState);
    expect(viaTarget.ok && viaTarget.value.outcome).toBe('APPLIED');
    expect(held.state().activeModifiers).toHaveLength(1);
    expect(held.applied).toHaveLength(1);
  });

  it('validates against the game the target holds now', () => {
    const held = holder(runningState('tag'));
    // The game ends after the proposal was made and before it is handed over.
    const ended = reduce(held.state(), { type: 'ABORT_SESSION', reason: 'rain' }, at(NOW));
    if (!ended.ok) throw new Error('fixture failed');
    held.set(ended.value);
    const before = held.state();

    const result = handOffProposalTo(held.target, proposal(zone), at(NOW + 1_000));
    expect(!result.ok && result.error.stage).toBe('STATE');
    expect(held.applied).toEqual([]);
    expect(held.state()).toBe(before);
  });

  it.each([
    ['a proposal that is not one', { rationale: RATIONALE, events: [zone] }, 'SCHEMA'],
    [
      'an event the engine will not have',
      proposal({ type: 'POWER_UP', playerId: 'ghost', powerId: 'shield' }),
      'STATE',
    ],
    ['an event that is not safe', proposal({ ...zone, zone: 'the car park' }), 'SAFETY'],
  ])('never reaches the apply of the target for %s', (_label, value, stage) => {
    const held = holder(runningState('tag'));
    const before = held.state();
    const result = handOffProposalTo(held.target, value, at(NOW));
    expect(!result.ok && result.error.stage).toBe(stage);
    expect(held.applied).toEqual([]);
    expect(held.state()).toBe(before);
  });

  it('applies nothing for a decision to do nothing', () => {
    const held = holder(runningState('tag'));
    const result = handOffProposalTo(held.target, proposal(null), at(NOW));
    expect(result.ok && result.value.outcome).toBe('NO_EVENT');
    expect(held.applied).toEqual([]);
  });

  it('reports a target that refuses, and hands it only what safety released', () => {
    const state = deepFreeze(runningState('tag'));
    const seen: unknown[] = [];
    const result = handOffProposalTo(
      {
        getState: () => state,
        applyEvent: (validated) => {
          seen.push(validated);
          return {
            ok: false,
            error: engineError('INVALID_STATE_TRANSITION', 'The room is closed.'),
          };
        },
      },
      proposal(zone),
      at(NOW),
    );
    expect(!result.ok && result.error.stage).toBe('APPLICATION');
    // What it was handed is a value the engine itself issued: it can be applied.
    expect(seen).toHaveLength(1);
    expect(applyValidatedEvent(state, seen[0] as never, at(NOW)).ok).toBe(true);
  });
});
