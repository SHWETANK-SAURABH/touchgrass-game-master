import { z } from 'zod';
import { type Result, err, ok } from '@touchgrass/shared';
import {
  type EngineError,
  abortSessionCommandSchema,
  gameStateSchema,
  historyEntrySchema,
  pauseSessionCommandSchema,
  removePlayerCommandSchema,
  resumeSessionCommandSchema,
} from '@touchgrass/game-engine';

/**
 * The wire protocol.
 *
 * This module knows about messages and nothing about games. It answers one
 * question about anything a client sends: is it one of the envelopes a client
 * may send? What an envelope asks for, and whether this connection may ask for
 * it, is decided elsewhere.
 *
 * A client may send:
 *
 *   { type: 'join', joinCode, displayName }      become a new player
 *   { type: 'resume', token }                    become the player a token is for
 *   { type: 'action', intent }                   act as the player this connection is
 *   { type: 'leave' }                            leave, before the game starts
 *   { type: 'host_auth', token }                 become the host of this game
 *   { type: 'host_command', command }            one of four commands, as the host
 *
 * and nothing else. There is no field for a player id, a session id, a state or
 * a message id, and every envelope is strict, so a message that carries one is
 * refused rather than having it ignored.
 *
 * Two things inside envelopes are treated differently on purpose:
 *
 *  - `intent` is not looked at here. It is passed on exactly as it arrived and
 *    validated by the engine as a player intent.
 *  - `command` is checked here, against a list of exactly four host commands,
 *    using the engine's own schema for each. No other command can be expressed.
 *
 * A token is a bearer capability: a random string the server handed out. This
 * module only checks that one is present and of a sane length. Whether it is
 * valid is the room's business.
 */

/** The largest client message accepted, in bytes of UTF-8. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

const token = z.string().min(1).max(256);

export const joinMessageSchema = z
  .object({
    type: z.literal('join'),
    /** Checked against the one game this server holds. It does not select a game. */
    joinCode: z.string().min(1).max(64),
    /** Bounded loosely here; the engine applies the real rule for a display name. */
    displayName: z.string().min(1).max(200),
  })
  .strict();

export const resumeMessageSchema = z.object({ type: z.literal('resume'), token }).strict();

export const actionMessageSchema = z
  .object({
    type: z.literal('action'),
    /** Untrusted and not inspected here. Must be present. */
    intent: z.unknown().refine((value) => value !== undefined, { message: 'intent is required' }),
  })
  .strict();

export const leaveMessageSchema = z.object({ type: z.literal('leave') }).strict();

export const hostAuthMessageSchema = z.object({ type: z.literal('host_auth'), token }).strict();

/**
 * The commands a host may send. This list is the whole of it: joining a player
 * and changing the phase are not here, and neither is anything else `reduce`
 * accepts now or later. Each entry is the engine's own schema for that command.
 */
export const hostCommandSchema = z.discriminatedUnion('type', [
  pauseSessionCommandSchema,
  resumeSessionCommandSchema,
  abortSessionCommandSchema,
  removePlayerCommandSchema,
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;

export const hostCommandMessageSchema = z
  .object({ type: z.literal('host_command'), command: hostCommandSchema })
  .strict();

export const clientMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  resumeMessageSchema,
  actionMessageSchema,
  leaveMessageSchema,
  hostAuthMessageSchema,
  hostCommandMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Why the transport itself refused a message. Not a game rule. */
export const TRANSPORT_ERROR_CODES = [
  /** Not text, too large, not JSON, or not one of the client envelopes. */
  'BAD_MESSAGE',
  /** Something only a joined player may do, from a connection that is not one. */
  'NOT_JOINED',
  /** A join or resume from a connection that is already a player. */
  'ALREADY_JOINED',
  /** The join code is not this game's. */
  'WRONG_JOIN_CODE',
  /** The token is not a valid one for what it was presented as. */
  'INVALID_TOKEN',
  /** A host command from a connection that is not the host. */
  'NOT_HOST',
  /** The host token was presented while another connection is the host. */
  'HOST_ALREADY_CONNECTED',
  /** A leave after the game has started. */
  'CANNOT_LEAVE',
  /** The address a socket connected to does not name a session. */
  'INVALID_SESSION_PATH',
  /** The address names a session that does not exist. */
  'SESSION_NOT_FOUND',
  /** The session exists but could not be made ready. */
  'SESSION_UNAVAILABLE',
  /** The session is no longer being served. The connection is then closed. */
  'SESSION_CLOSED',
  /** Another connection resumed as this player. This one is then closed. */
  'CONNECTION_REPLACED',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export const serverMessageSchema = z.discriminatedUnion('type', [
  /**
   * To one connection: the player it now is, and the game. `token` is present
   * only in the reply to a join, which is the one time it is ever sent.
   */
  z
    .object({
      type: z.literal('joined'),
      playerId: z.string().min(1),
      token: token.optional(),
      state: gameStateSchema,
    })
    .strict(),
  /** To one connection: it is now the host of this game. */
  z.object({ type: z.literal('host_authorized'), state: gameStateSchema }).strict(),
  /** To every joined connection and the host, after the game changed. */
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
