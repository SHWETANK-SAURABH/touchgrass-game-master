import { z } from 'zod';
import { type Result, err, ok } from '@touchgrass/shared';
import { type EngineError, gameStateSchema, historyEntrySchema } from '@touchgrass/game-engine';

/**
 * The wire protocol.
 *
 * This module knows about messages and nothing about games. It answers one
 * question about anything a client sends: is it one of the two envelopes a
 * client may send? What an envelope asks for is decided elsewhere.
 *
 * A client may send:
 *
 *   { type: 'join', joinCode, displayName }
 *   { type: 'action', intent }
 *
 * and nothing else. There is no field for a player id, a session id, a state, a
 * message id or a command, and both envelopes are strict, so a message that
 * carries one is refused rather than having it ignored.
 *
 * `intent` is deliberately not looked at here. It is passed on exactly as it
 * arrived and validated by the engine as a player intent. Envelope validation
 * and intent validation are separate steps owned by separate packages.
 */

/** The largest client message accepted, in bytes of UTF-8. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

export const joinMessageSchema = z
  .object({
    type: z.literal('join'),
    /** Checked against the one game this server holds. It does not select a game. */
    joinCode: z.string().min(1).max(64),
    /** Bounded loosely here; the engine applies the real rule for a display name. */
    displayName: z.string().min(1).max(200),
  })
  .strict();

export const actionMessageSchema = z
  .object({
    type: z.literal('action'),
    /** Untrusted and not inspected here. Must be present. */
    intent: z.unknown().refine((value) => value !== undefined, { message: 'intent is required' }),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  actionMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Why the transport itself refused a message. Not a game rule. */
export const TRANSPORT_ERROR_CODES = [
  /** Not text, too large, not JSON, or not one of the client envelopes. */
  'BAD_MESSAGE',
  /** An action from a connection that has not joined. */
  'NOT_JOINED',
  /** A join from a connection that already has. */
  'ALREADY_JOINED',
  /** The join code is not this game's. */
  'WRONG_JOIN_CODE',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export const serverMessageSchema = z.discriminatedUnion('type', [
  /** To the connection that joined: the player it now is, and the game. */
  z
    .object({ type: z.literal('joined'), playerId: z.string().min(1), state: gameStateSchema })
    .strict(),
  /** To every joined connection, after the game changed. */
  z
    .object({
      type: z.literal('update'),
      /** The history entries the change added, in order. */
      entries: z.array(historyEntrySchema),
      state: gameStateSchema,
    })
    .strict(),
  /** To the sender only: the game refused what it asked for. */
  z
    .object({
      type: z.literal('rejected'),
      error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
    })
    .strict(),
  /** To the sender only: the transport refused the message. */
  z.object({ type: z.literal('error'), code: z.enum(TRANSPORT_ERROR_CODES) }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * Reads one incoming frame as a client message.
 *
 * `raw` is whatever arrived. Anything that is not text, is too large, is not
 * JSON, or is not exactly a client envelope gives BAD_MESSAGE. Nothing is
 * repaired and no partial message is returned.
 */
export function parseClientMessage(
  raw: unknown,
  maxBytes: number = MAX_MESSAGE_BYTES,
): Result<ClientMessage, TransportErrorCode> {
  if (typeof raw !== 'string') return err('BAD_MESSAGE');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return err('BAD_MESSAGE');

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return err('BAD_MESSAGE');
  }

  const parsed = clientMessageSchema.safeParse(decoded);
  return parsed.success ? ok(parsed.data) : err('BAD_MESSAGE');
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/** What a client is told about a refusal by the game: the code and the sentence. */
export function rejection(error: EngineError): ServerMessage {
  return { type: 'rejected', error: { code: error.code, message: error.message } };
}
