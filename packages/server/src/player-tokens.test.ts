import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPlayerTokens } from './player-tokens';

/** Fixed, readable keys. They protect nothing: they exist only in these tests. */
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);

describe('player tokens that can be made again', () => {
  it('gives the same player of the same session the same token every time', () => {
    const tokens = createPlayerTokens(KEY);
    const first = tokens('a')('player-1');
    expect(tokens('a')('player-1')).toBe(first);
    // A second maker with the same key agrees, as a later process would.
    expect(createPlayerTokens(new Uint8Array(KEY))('a')('player-1')).toBe(first);
  });

  it('gives every player, session and key a different token', () => {
    const tokens = createPlayerTokens(KEY);
    const all = [
      tokens('a')('player-1'),
      tokens('a')('player-2'),
      tokens('b')('player-1'),
      tokens('b')('player-2'),
      createPlayerTokens(OTHER_KEY)('a')('player-1'),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not let two pairs of ids run together into one token', () => {
    const tokens = createPlayerTokens(KEY);
    expect(tokens('ab')('c')).not.toBe(tokens('a')('bc'));
    expect(tokens('a|1:b')('c')).not.toBe(tokens('a')('b|1:c'));
    expect(tokens('')('abc')).not.toBe(tokens('abc')(''));
  });

  it('makes a token that fits the protocol and carries neither id', () => {
    const token = createPlayerTokens(KEY)('session-one')('player-one');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain('session');
    expect(token).not.toContain('player');
  });

  it('makes a key of its own when none is given, different each time', () => {
    const one = createPlayerTokens();
    const two = createPlayerTokens();
    expect(one('a')('player-1')).toBe(one('a')('player-1'));
    expect(one('a')('player-1')).not.toBe(two('a')('player-1'));
  });

  it('refuses a key that is too short to be one', () => {
    expect(() => createPlayerTokens(new Uint8Array(31))).toThrow();
    expect(() => createPlayerTokens(new Uint8Array(0))).toThrow();
  });

  it('is not changed by what happens to the key it was given afterwards', () => {
    const key = new Uint8Array(KEY);
    const tokens = createPlayerTokens(key);
    const before = tokens('a')('player-1');
    key.fill(0);
    expect(tokens('a')('player-1')).toBe(before);
  });

  it('keeps nothing: no table, no store, no log', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(joinPath(directory, 'player-tokens.ts'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    expect(code).not.toMatch(/new Map|new Set|console\.|process\.env|SessionStore|writeFile/);
  });
});
