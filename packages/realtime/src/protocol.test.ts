import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  clientMessageSchema,
  encodeServerMessage,
  parseClientMessage,
  serverMessageSchema,
} from './protocol';

const json = (value: unknown): string => JSON.stringify(value);
const JOIN = { type: 'join', joinCode: 'GRASS7', displayName: 'Ada' };
const ACTION = { type: 'action', intent: { type: 'PLAYER_READY' } };

const parsed = (value: unknown) =>
  parseClientMessage(typeof value === 'string' ? value : json(value));
const isBad = (value: unknown): boolean => {
  const result = parsed(value);
  return !result.ok && result.error === 'BAD_MESSAGE';
};

describe('client envelopes', () => {
  it('accepts a join', () => {
    const result = parsed(JOIN);
    expect(result).toEqual({ ok: true, value: JOIN });
  });

  it('accepts an action and leaves the intent exactly as it arrived', () => {
    for (const intent of [
      { type: 'PLAYER_READY' },
      { type: 'PLAYER_TAGGED', targetPlayerId: 'p1' },
      // Not a valid intent. That is for the engine to say, not the envelope.
      { type: 'NOT_AN_INTENT', anything: [1, 2, { deep: true }] },
      'a string',
      42,
      null,
      [],
    ]) {
      const result = parsed({ type: 'action', intent });
      expect(result).toEqual({ ok: true, value: { type: 'action', intent } });
    }
  });

  it('has exactly six envelopes', () => {
    const types = clientMessageSchema.options.map((option) => option.shape.type.value);
    expect(types.sort()).toEqual([
      'action',
      'host_auth',
      'host_command',
      'join',
      'leave',
      'resume',
    ]);
  });

  it.each([
    ['a player id on an action', { ...ACTION, playerId: 'p0' }],
    ['an actor id on an action', { ...ACTION, actorId: 'p0' }],
    ['a player id on a join', { ...JOIN, playerId: 'p0' }],
    ['a session id on a join', { ...JOIN, sessionId: 'g1' }],
    ['a session id on an action', { ...ACTION, sessionId: 'g1' }],
    ['a game id', { ...JOIN, gameId: 'tag' }],
    ['a state', { ...ACTION, state: { status: 'completed' } }],
    ['a message id', { ...ACTION, messageId: 'm1' }],
    ['a timestamp', { ...ACTION, at: 1 }],
    ['a role', { ...JOIN, roleId: 'tagger' }],
    ['a host command field', { ...ACTION, command: { type: 'ABORT_SESSION', reason: 'x' } }],
  ])('refuses an envelope that carries %s', (_label, message) => {
    expect(isBad(message)).toBe(true);
  });

  it.each([
    ['an unknown type', { type: 'subscribe' }],
    ['a host command as a message', { type: 'ABORT_SESSION', reason: 'x' }],
    ['a command envelope', { type: 'command', command: { type: 'PAUSE_SESSION', reason: 'x' } }],
    ['a bare intent', { type: 'PLAYER_READY' }],
    ['a tick', { type: 'tick' }],
    ['no type', { joinCode: 'GRASS7', displayName: 'Ada' }],
    ['an action without an intent', { type: 'action' }],
    ['a join without a code', { type: 'join', displayName: 'Ada' }],
    ['a join without a name', { type: 'join', joinCode: 'GRASS7' }],
    ['an empty join code', { ...JOIN, joinCode: '' }],
    ['an empty name', { ...JOIN, displayName: '' }],
    ['a name that is not a string', { ...JOIN, displayName: 7 }],
    ['an over-long join code', { ...JOIN, joinCode: 'x'.repeat(65) }],
    ['an array', [JOIN]],
    ['null', null],
    ['a number', 7],
    ['a string', 'join'],
  ])('refuses %s', (_label, message) => {
    expect(isBad(message)).toBe(true);
  });

  it.each([
    ['empty text', ''],
    ['text that is not JSON', 'join GRASS7 Ada'],
    ['truncated JSON', '{"type":"join","joinCode":"GRASS7"'],
    ['JSON with a trailing comma', '{"type":"action","intent":{},}'],
  ])('refuses %s', (_label, text) => {
    expect(parseClientMessage(text)).toEqual({ ok: false, error: 'BAD_MESSAGE' });
  });

  it.each([
    ['a buffer', Buffer.from(json(JOIN))],
    ['bytes', new Uint8Array([1, 2, 3])],
    ['null', null],
    ['undefined', undefined],
    ['an object that was never serialised', JOIN],
  ])('refuses %s: only text is a message', (_label, raw) => {
    expect(parseClientMessage(raw)).toEqual({ ok: false, error: 'BAD_MESSAGE' });
  });

  it('refuses a message larger than the limit, measured in bytes', () => {
    const big = json({
      type: 'action',
      intent: { type: 'PLAYER_READY', pad: 'x'.repeat(MAX_MESSAGE_BYTES) },
    });
    expect(parseClientMessage(big)).toEqual({ ok: false, error: 'BAD_MESSAGE' });

    // 600 characters, 1800 bytes: under a character count of 1000, over a byte limit of 1000.
    const wide = json({ type: 'join', joinCode: 'GRASS7', displayName: '草'.repeat(150) });
    expect(wide.length).toBeLessThan(1_000);
    expect(parseClientMessage(wide, 400).ok).toBe(false);
    expect(parseClientMessage(json(JOIN), 400).ok).toBe(true);
  });

  it('does not treat a prototype key as an envelope field', () => {
    const text = '{"type":"action","intent":{"type":"PLAYER_READY"},"__proto__":{"playerId":"p0"}}';
    expect(parseClientMessage(text).ok).toBe(false);
  });
});

describe('server envelopes', () => {
  it('round-trips an error and a rejection', () => {
    for (const message of [
      { type: 'error', code: 'BAD_MESSAGE' },
      { type: 'error', code: 'NOT_JOINED' },
      { type: 'rejected', error: { code: 'INVALID_ROLE', message: 'A runner cannot tag.' } },
    ] as const) {
      const decoded: unknown = JSON.parse(encodeServerMessage(message));
      expect(serverMessageSchema.parse(decoded)).toEqual(message);
    }
  });

  it('has no error code outside the transport list, and no extra fields', () => {
    expect(serverMessageSchema.safeParse({ type: 'error', code: 'KABOOM' }).success).toBe(false);
    expect(
      serverMessageSchema.safeParse({ type: 'error', code: 'BAD_MESSAGE', socketId: 's1' }).success,
    ).toBe(false);
  });
});
