import { createHmac, randomBytes } from 'node:crypto';

/**
 * Player tokens that can be made again.
 *
 * A room's player token is a bearer capability: whoever presents it is that
 * player. A token that is only a random value lives in one room and dies with
 * it, so a player cannot come back to a session that was unloaded and loaded
 * again. A token made here is worked out from three things instead:
 *
 *   the key          held in memory by whoever made this, and never sent
 *   the session id   so a token is for one session and no other
 *   the player id    so a token is for one player and no other
 *
 * The same three give the same token every time. Nothing is stored: no token,
 * and no trace of one, enters GameState, a snapshot or the database. A new room
 * for the same session works the same tokens out again from the players the
 * restored game has.
 *
 * Without the key a token cannot be made, and one player's token says nothing
 * about another's.
 */

/** Makes the token for a player of one session. */
export type PlayerTokens = (sessionId: string) => (playerId: string) => string;

/**
 * `key` is at least 32 random bytes. Left out, a new one is made, and the
 * tokens last as long as this object does: one process at most.
 */
export function createPlayerTokens(key: Uint8Array = randomBytes(32)): PlayerTokens {
  if (key.byteLength < 32) throw new Error('A player token key needs at least 32 bytes.');
  const held = Buffer.from(key);
  return (sessionId) => (playerId) =>
    createHmac('sha256', held)
      // The lengths are part of what is signed, so no two pairs of ids can
      // run together into the same text.
      .update(`${sessionId.length}:${sessionId}|${playerId.length}:${playerId}`, 'utf8')
      .digest('base64url');
}
