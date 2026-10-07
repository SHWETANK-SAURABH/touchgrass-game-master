import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import type * as Engine from '@touchgrass/game-engine';
import { applyValidatedEvent, contextAt } from '@touchgrass/game-engine';
import { T0, deepFreeze, runningState } from '../game-master/test-support';
import { handOffProposal } from './handoff';

/**
 * Counts the calls that reach the engine's apply function.
 *
 * The other hand-off tests show that a refused proposal leaves the state as it
 * was. These show something stronger: for a proposal refused before or at the
 * safety stage, the engine's apply function is not called at all. The real
 * function is wrapped, not replaced, so an applied proposal still goes through
 * the real engine.
 */
vi.mock('@touchgrass/game-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof Engine>();
  return { ...actual, applyValidatedEvent: vi.fn(actual.applyValidatedEvent) };
});

const applied = vi.mocked(applyValidatedEvent);
const at = (ms: number) => contextAt(fixedClock(T0 + ms));
const NOW = 61_000;
const RATIONALE = 'The round has gone quiet and needs one small change.';

const zone = (place: string) => ({
  type: 'ZONE_CHANGE',
  modifier: 'SAFE_ZONE',
  zone: place,
  durationSeconds: 60,
});

const handOff = (event: unknown) =>
  handOffProposal({ rationale: RATIONALE, event }, deepFreeze(runningState('tag')), at(NOW));

beforeEach(() => {
  applied.mockClear();
});

describe('what reaches the engine', () => {
  it('calls the engine once for a legal, safe proposal', () => {
    const result = handOff(zone('the bench'));
    expect(result.ok && result.value.outcome).toBe('APPLIED');
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unsafe zone', zone('the car park')],
    ['an unsafe zone', zone('the roof of the shed')],
    [
      'an unsafe objective',
      {
        type: 'BONUS_OBJECTIVE',
        objectiveId: 'o1',
        description: 'Climb the abandoned building.',
        points: 2,
        durationSeconds: 60,
      },
    ],
    [
      'an objective that cannot be read',
      {
        type: 'BONUS_OBJECTIVE',
        objectiveId: 'o1',
        description: 'Залезь на крышу',
        points: 2,
        durationSeconds: 60,
      },
    ],
    [
      'an objective that lasts too long',
      {
        type: 'BONUS_OBJECTIVE',
        objectiveId: 'o1',
        description: 'Touch the big oak.',
        points: 2,
        durationSeconds: 150,
      },
    ],
  ])('never calls the engine for %s', (_label, event) => {
    const result = handOff(event);
    expect(!result.ok && result.error.stage).toBe('SAFETY');
    expect(applied).not.toHaveBeenCalled();
  });

  it('never calls the engine for a proposal refused before safety', () => {
    expect(handOff({ type: 'POWER_UP', playerId: 'ghost', powerId: 'shield' }).ok).toBe(false);
    expect(handOff({ type: 'GAME_END', reason: 'ROUNDS_COMPLETE' }).ok).toBe(false);
    expect(handOff(null).ok).toBe(true);
    expect(applied).not.toHaveBeenCalled();
  });
});
