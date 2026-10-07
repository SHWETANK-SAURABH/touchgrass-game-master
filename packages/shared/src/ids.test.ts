import { describe, expect, it } from 'vitest';
import { createRng } from './determinism';
import { createJoinCode, createSessionId, isValidJoinCode } from './ids';

describe('createJoinCode', () => {
  it('omits glyphs that are ambiguous when a code is shouted across a field', () => {
    const code = createJoinCode(200, createRng(1));
    expect(code).not.toMatch(/[01OIL]/);
  });

  it('honours the requested length and is reproducible for a seed', () => {
    expect(createJoinCode(6, createRng(99))).toHaveLength(6);
    expect(createJoinCode(6, createRng(99))).toBe(createJoinCode(6, createRng(99)));
  });

  it('round-trips through its own validator', () => {
    expect(isValidJoinCode(createJoinCode(6, createRng(3)))).toBe(true);
  });

  it('rejects wrong length and excluded characters', () => {
    expect(isValidJoinCode('ABC')).toBe(false);
    expect(isValidJoinCode('ABCDE0')).toBe(false);
    expect(isValidJoinCode('abcdef')).toBe(false);
  });
});

describe('createSessionId', () => {
  it('is prefixed and unique', () => {
    const a = createSessionId();
    expect(a.startsWith('ses_')).toBe(true);
    expect(a).not.toBe(createSessionId());
  });
});
