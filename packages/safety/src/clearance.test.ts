import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyValidatedEvent, submitGameEvent } from '@touchgrass/game-engine';
import {
  type SafetyClearedEvent,
  type SafetyRejection,
  releaseClearedEvent,
  validateSafety,
} from './clearance';
import {
  NOW,
  at,
  deepFreeze,
  objectiveEvent,
  runningState,
  validatedFor,
  zoneEvent,
} from './test-support';

const SAFE = zoneEvent('the bench');
const UNSAFE = zoneEvent('the car park');

function cleared(event = SAFE, state = runningState('tag')): SafetyClearedEvent {
  const result = validateSafety(validatedFor(state, event), state);
  if (!result.ok) throw new Error('expected the event to be cleared');
  return result.value;
}

const kindOf = (result: { ok: true } | { ok: false; error: SafetyRejection }) =>
  result.ok ? 'ok' : result.error.kind;

describe('validateSafety', () => {
  it('clears a legal, safe event', () => {
    const state = runningState('tag');
    const result = validateSafety(validatedFor(state, SAFE), state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event).toEqual(SAFE);
    expect(result.value.gameId).toBe(state.id);
    expect(result.value.verdict).toMatchObject({ disposition: 'allow', violations: [] });
  });

  it('refuses a legal but unsafe event, with the verdict', () => {
    const state = runningState('tag');
    const result = validateSafety(validatedFor(state, UNSAFE), state);

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'UNSAFE') throw new Error('expected UNSAFE');
    expect(result.error.verdict.disposition).toBe('reject');
    expect(result.error.verdict.violations[0]).toMatchObject({
      hazard: 'roads-and-traffic',
      field: 'zone',
      evidence: 'car park',
    });
  });

  it.each([
    ['tag', objectiveEvent('Climb the abandoned building.')],
    ['tag', objectiveEvent('Take a photo of another player.')],
    ['hide-and-seek', objectiveEvent('Hide where nobody can see you.')],
    ['hide-and-seek', zoneEvent('behind the fence')],
  ] as const)('refuses an event the engine accepted for %s: %j', (gameId, event) => {
    const state = runningState(gameId);
    // The engine accepts it: it is a legal event for this game right now.
    const validated = validatedFor(state, event);
    expect(kindOf(validateSafety(validated, state))).toBe('UNSAFE');
  });

  it('does not clear a "revise" verdict either', () => {
    const state = runningState('tag');
    const validated = validatedFor(state, objectiveEvent('Play this round in the dark.'));
    const result = validateSafety(validated, state, { supervisedByAdult: true });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'UNSAFE') throw new Error('expected UNSAFE');
    expect(result.error.verdict.disposition).toBe('revise');
  });

  it('derives the policy itself: a caller cannot loosen it', () => {
    const state = runningState('tag');
    const long = validatedFor(
      state,
      objectiveEvent('Touch the big oak.', { durationSeconds: 150 }),
    );
    expect(kindOf(validateSafety(long, state))).toBe('UNSAFE');
    expect(kindOf(validateSafety(long, state, { maxRuleDurationSeconds: 9_999 }))).toBe('UNSAFE');
    expect(kindOf(validateSafety(long, state, { supervisedByAdult: true }))).toBe('UNSAFE');
    // It can be made stricter.
    const short = validatedFor(state, objectiveEvent('Touch the big oak.'));
    expect(kindOf(validateSafety(short, state))).toBe('ok');
    expect(kindOf(validateSafety(short, state, { maxRuleDurationSeconds: 30 }))).toBe('UNSAFE');
  });

  it('is deterministic', () => {
    const state = runningState('tag');
    const validated = validatedFor(state, UNSAFE);
    const first = validateSafety(validated, state);
    const second = validateSafety(validated, state);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('changes neither the state nor the event, whatever the verdict', () => {
    for (const event of [SAFE, UNSAFE]) {
      const state = deepFreeze(runningState('tag'));
      const snapshot = structuredClone(state);
      const validated = validatedFor(state, event);
      expect(() => validateSafety(validated, state)).not.toThrow();
      expect(state).toEqual(snapshot);
      expect(validated.event).toEqual(event);
      expect(state.activeModifiers).toEqual([]);
      expect(state.history).toHaveLength(snapshot.history.length);
    }
  });
});

describe('validateSafety: input it cannot evaluate is not cleared', () => {
  it('refuses an event the engine did not validate', () => {
    const state = runningState('tag');
    const genuine = validatedFor(state, SAFE);
    const lookAlikes = [
      { ...genuine },
      JSON.parse(JSON.stringify(genuine)) as unknown,
      { event: SAFE, source: 'game-master', gameId: state.id, historyLength: state.history.length },
      SAFE,
      null,
      undefined,
      'ZONE_CHANGE',
    ];
    for (const fake of lookAlikes) {
      const result = validateSafety(fake as never, state);
      expect(kindOf(result)).toBe('NOT_EVALUATED');
    }
  });

  it('refuses an event validated for a different game', () => {
    const state = runningState('tag', 'g1');
    const other = runningState('tag', 'g2');
    expect(kindOf(validateSafety(validatedFor(other, SAFE), state))).toBe('NOT_EVALUATED');
  });

  it('cannot be given the policy of another game by a state that names another game', () => {
    // Regression: the policy used to be looked up from the state passed in. A
    // copy of a Hide & Seek state that claimed to be Tag then got an event the
    // engine had validated for Hide & Seek cleared under Tag's looser contact
    // policy. The policy now follows the definition the engine validated under.
    const state = runningState('hide-and-seek');
    const validated = validatedFor(state, objectiveEvent('High five another player.'));
    expect(validated.definitionId).toBe('hide-and-seek');
    expect(kindOf(validateSafety(validated, state))).toBe('UNSAFE');

    const result = validateSafety(validated, { ...state, gameId: 'tag' });
    expect(kindOf(result)).toBe('NOT_EVALUATED');
    expect(Object.keys(result)).not.toContain('value');
  });

  it('refuses a state whose game has no registered definition', () => {
    const state = runningState('tag');
    const validated = validatedFor(state, SAFE);
    const result = validateSafety(validated, { ...state, gameId: 'quidditch' });
    expect(kindOf(result)).toBe('NOT_EVALUATED');
  });
});

describe('SafetyClearedEvent', () => {
  it('releases the very event the engine validated', () => {
    const state = runningState('tag');
    const validated = validatedFor(state, SAFE);
    const result = validateSafety(validated, state);
    if (!result.ok) throw new Error('expected the event to be cleared');

    const released = releaseClearedEvent(result.value);
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.value).toBe(validated);
  });

  it('cannot be fabricated, copied or rebuilt from JSON', () => {
    const genuine = cleared();
    const fakes = [
      { ...genuine },
      JSON.parse(JSON.stringify(genuine)) as unknown,
      structuredClone({ event: genuine.event, gameId: genuine.gameId, verdict: genuine.verdict }),
      {
        event: UNSAFE,
        gameId: genuine.gameId,
        verdict: {
          disposition: 'allow',
          violations: [],
          checkedFields: ['zone'],
          policyVersion: 'x',
        },
      },
      Object.create(genuine) as unknown,
      null,
      undefined,
    ];
    for (const fake of fakes) {
      expect(kindOf(releaseClearedEvent(fake as never))).toBe('NOT_EVALUATED');
    }
    // The genuine one still works afterwards.
    expect(kindOf(releaseClearedEvent(genuine))).toBe('ok');
  });

  it('cannot be edited after it is issued', () => {
    const genuine = cleared();
    const writable = genuine as unknown as {
      event: unknown;
      verdict: unknown;
    };
    expect(() => {
      writable.event = UNSAFE;
    }).toThrow(TypeError);
    expect(() => {
      writable.verdict = {};
    }).toThrow(TypeError);
    expect(() => {
      (genuine.event as { zone: string }).zone = 'the car park';
    }).toThrow(TypeError);
    expect(genuine.event).toEqual(SAFE);
  });

  it('does not expose the engine token except through release', () => {
    expect(Object.keys(cleared()).sort()).toEqual(['event', 'gameId', 'verdict']);
  });

  it('is not issued for an unsafe event, so there is nothing to release', () => {
    const state = runningState('tag');
    const result = validateSafety(validatedFor(state, UNSAFE), state);
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).not.toContain('value');
  });

  it('does not override the engine: a clearance for a state that has moved on is still refused', () => {
    const state = runningState('tag');
    const genuine = cleared(SAFE, state);
    const released = releaseClearedEvent(genuine);
    if (!released.ok) throw new Error('expected a release');

    const moved = submitGameEvent(state, { type: 'TIME_EXTENSION', seconds: 30 }, 'human', at(NOW));
    if (!moved.ok) throw new Error('fixture failed');
    const applied = applyValidatedEvent(moved.value, released.value, at(NOW + 1_000));
    expect(applied.ok).toBe(false);

    // Against the state it was validated and cleared for, the engine applies it.
    expect(applyValidatedEvent(state, released.value, at(NOW)).ok).toBe(true);
  });
});

describe('the safety package decides and does not execute', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('test'))
    .map((name) => [name, readFileSync(join(directory, name), 'utf-8')] as const);

  it('has source files to check', () => {
    expect(sources.map(([name]) => name)).toEqual(
      expect.arrayContaining(['assess.ts', 'clearance.ts', 'rules.ts', 'text.ts']),
    );
  });

  it.each(sources)('%s uses nothing of the engine that can change a game', (_name, source) => {
    const imported = [
      ...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@touchgrass\/game-engine'/g),
    ]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim())
      .filter((name) => name !== '' && !name.startsWith('type '));
    const typeOnly = /import\s+type\s+\{[^}]*\}\s+from\s+'@touchgrass\/game-engine'/.test(source);
    if (!typeOnly) expect(imported.every((name) => name === 'isValidatedGameEvent')).toBe(true);
  });

  it.each(sources)('%s consults no model, clock, network or random source', (_name, source) => {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /@touchgrass\/ai|@mastra|fetch\(|Date\.now|new Date|Math\.random|performance\.|process\.env|setTimeout|async |await /,
    );
  });
});
