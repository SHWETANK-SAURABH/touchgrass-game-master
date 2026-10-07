import { createRng, type Rng } from './determinism';

/** Opaque identifier for a game session. */
export type SessionId = string;
/** Opaque identifier for a player within a session. */
export type PlayerId = string;

export function createSessionId(): SessionId {
  return `ses_${crypto.randomUUID()}`;
}

export function createPlayerId(): PlayerId {
  return `plr_${crypto.randomUUID()}`;
}

export function createEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

/**
 * Human-readable join code, shouted across a field rather than typed from a QR
 * scan. Ambiguous glyphs (0/O, 1/I/L) are excluded so a misheard code is a code
 * that simply does not exist, instead of one that joins the wrong session.
 */
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function createJoinCode(length = 6, rng: Rng = createRng(Date.now())): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += JOIN_CODE_ALPHABET[rng.nextInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidJoinCode(candidate: string, length = 6): boolean {
  if (candidate.length !== length) return false;
  return [...candidate].every((char) => JOIN_CODE_ALPHABET.includes(char));
}
