import { describe, expect, it } from 'vitest';
import { createRng, fixedClock, seedFromString, shuffle } from './determinism';

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('keeps next() inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps nextInt() inside [0, bound)', () => {
    const rng = createRng(9);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.nextInt(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
    }
  });

  it('rejects non-positive bounds', () => {
    const rng = createRng(1);
    expect(() => rng.nextInt(0)).toThrow(/positive integer/);
    expect(() => rng.nextInt(-3)).toThrow(/positive integer/);
    expect(() => rng.nextInt(1.5)).toThrow(/positive integer/);
  });
});

describe('seedFromString', () => {
  it('is stable for the same input', () => {
    expect(seedFromString('ses_abc')).toBe(seedFromString('ses_abc'));
  });

  it('separates similar session ids', () => {
    expect(seedFromString('ses_abc')).not.toBe(seedFromString('ses_abd'));
  });
});

describe('shuffle', () => {
  it('is a permutation and leaves the input untouched', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozen = [...input];
    const shuffled = shuffle(input, createRng(123));
    expect(input).toEqual(frozen);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(frozen);
  });

  it('is reproducible for a given seed', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    expect(shuffle(input, createRng(5))).toEqual(shuffle(input, createRng(5)));
  });
});

describe('fixedClock', () => {
  it('never advances', () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
  });
});
