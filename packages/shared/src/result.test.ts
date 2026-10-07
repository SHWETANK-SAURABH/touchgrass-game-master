import { describe, expect, it } from 'vitest';
import { andThen, err, isErr, isOk, mapResult, ok, unwrap, unwrapOr } from './result';

describe('Result', () => {
  it('narrows with isOk / isErr', () => {
    const good = ok(1);
    const bad = err('nope');
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(1);
    if (isErr(bad)) expect(bad.error).toBe('nope');
  });

  it('maps only the success branch', () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(mapResult(err<string>('x'), (n: number) => n * 3)).toEqual(err('x'));
  });

  it('short-circuits andThen on failure', () => {
    const fail = (): ReturnType<typeof ok<number>> => {
      throw new Error('must not run');
    };
    expect(andThen(err<string>('boom'), fail)).toEqual(err('boom'));
    expect(andThen(ok(2), (n) => ok(n + 1))).toEqual(ok(3));
  });

  it('unwraps or throws', () => {
    expect(unwrap(ok('v'))).toBe('v');
    expect(() => unwrap(err({ code: 'E' }))).toThrow(/unwrap\(\)/);
    expect(unwrapOr(err<string>('e'), 'fallback')).toBe('fallback');
  });
});
