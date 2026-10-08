import { describe, expect, it } from 'vitest';
import { fixedClock } from '@touchgrass/shared';
import { contextAt, submitGameEvent, validateExternalEvent } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from './session';

const T0 = 1_700_000_000_000;
const at = (ms: number) => contextAt(fixedClock(T0 + ms));
const START = 1_000;
const NOW = START + 5_000;
const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

function running(sessionId = 'g1'): GameSession {
  const session = unwrap(
    createGameSession(
      { type: 'CREATE_SESSION', sessionId, gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
      at(0),
    ),
  );
  for (const index of [0, 1, 2]) {
    unwrap(
      session.applyCommand(
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  for (const index of [0, 1, 2]) {
    unwrap(session.submitAction(`p${index}`, { type: 'PLAYER_READY' }, at(START)));
  }
  return session;
}

const validated = (session: GameSession, event: unknown = zone, ms = NOW) =>
  unwrap(validateExternalEvent(session.getState(), event, 'game-master', at(ms)));

describe('applying an event the engine validated', () => {
  it('changes the game exactly as the engine does, and reports what was added', () => {
    const session = running();
    const before = session.getState();
    const update = unwrap(session.applyEvent(validated(session), at(NOW)));

    expect(update.state).toBe(session.getState());
    expect(update.state).toEqual(unwrap(submitGameEvent(before, zone, 'game-master', at(NOW))));
    expect(update.entries).toHaveLength(1);
    expect(update.entries[0]).toMatchObject({
      source: 'game-master',
      record: { kind: 'EVENT', event: zone },
    });
    expect(Object.isFrozen(update.state)).toBe(true);
  });

  it.each([
    ['a plain object that looks like a validated event', { event: zone, gameId: 'g1' }],
    ['the event itself', zone],
    ['nothing', undefined],
  ])('refuses %s, and changes nothing', (_label, value) => {
    const session = running();
    const before = session.getState();
    const refused = session.applyEvent(value as never, at(NOW));
    expect(!refused.ok && refused.error.code).toBe('INVALID_EVENT');
    expect(session.getState()).toBe(before);
  });

  it('refuses an event validated before the game last changed', () => {
    const session = running();
    const stale = validated(session);
    unwrap(session.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(NOW + 100)));
    const before = session.getState();
    const refused = session.applyEvent(stale, at(NOW + 200));
    expect(refused.ok).toBe(false);
    expect(session.getState()).toBe(before);
  });

  it('refuses an event validated for another game', () => {
    const one = running('one');
    const two = running('two');
    const before = two.getState();
    const refused = two.applyEvent(validated(one), at(NOW));
    expect(!refused.ok && refused.error.code).toBe('INVALID_EVENT');
    expect(two.getState()).toBe(before);
  });

  it('applies a validated event once only', () => {
    const session = running();
    const once = validated(session);
    unwrap(session.applyEvent(once, at(NOW)));
    const after = session.getState();
    expect(session.applyEvent(once, at(NOW)).ok).toBe(false);
    expect(session.getState()).toBe(after);
  });
});
