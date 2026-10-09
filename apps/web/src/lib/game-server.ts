import type { ServerEnv } from '@touchgrass/shared';
import { isPlayable } from './playable';

/**
 * The website's link to the game server. Server-side only.
 *
 * The game server is a separate process. This module is how the site asks it
 * whether it is up and asks it to create a game. It is the only place the admin
 * token is used, and the token never leaves the server: a browser is given the
 * address to connect to and, for the person who created a game, that game's own
 * host token.
 *
 * Every failure comes back as a short code. No address, token or error text
 * from the game server is passed on.
 */

export type PlayUnavailableReason =
  /** The site has not been told where the game server is. */
  | 'NOT_CONFIGURED'
  /** The game server did not answer, or said it is not ready. */
  | 'SERVER_UNAVAILABLE';

export type PlayConfig =
  | { readonly enabled: true; readonly wsUrl: string }
  | { readonly enabled: false; readonly reason: PlayUnavailableReason };

export type CreateSessionResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly joinCode: string;
      readonly hostToken: string;
      readonly wsUrl: string;
    }
  | {
      readonly ok: false;
      readonly code: PlayUnavailableReason | 'GAME_NOT_PLAYABLE' | 'NOT_CREATED';
    };

type Settings = Pick<ServerEnv, 'GAME_SERVER_URL' | 'GAME_SERVER_WS_URL' | 'ADMIN_TOKEN'>;
type Fetch = typeof fetch;

/** The address a browser connects to: the one given, or the server's own as ws:// or wss://. */
export function browserAddress(settings: Settings): string | null {
  if (settings.GAME_SERVER_WS_URL) return settings.GAME_SERVER_WS_URL.replace(/\/+$/, '');
  if (!settings.GAME_SERVER_URL) return null;
  return settings.GAME_SERVER_URL.replace(/^http/, 'ws').replace(/\/+$/, '');
}

const baseOf = (settings: Settings): string => (settings.GAME_SERVER_URL ?? '').replace(/\/+$/, '');

/**
 * Whether games can be played from this site right now.
 *
 * `pageIsSecure` is whether the visitor loaded the site over https. A browser
 * refuses a ws:// connection from an https page, so that pairing is reported as
 * not set up rather than left to fail when someone tries to join.
 */
export async function getPlayConfig(
  settings: Settings,
  request: Fetch = fetch,
  pageIsSecure = false,
): Promise<PlayConfig> {
  const wsUrl = browserAddress(settings);
  if (!settings.GAME_SERVER_URL || !settings.ADMIN_TOKEN || !wsUrl) {
    return { enabled: false, reason: 'NOT_CONFIGURED' };
  }
  if (pageIsSecure && wsUrl.startsWith('ws://')) {
    return { enabled: false, reason: 'NOT_CONFIGURED' };
  }
  try {
    const ready = await request(`${baseOf(settings)}/readyz`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (!ready.ok) return { enabled: false, reason: 'SERVER_UNAVAILABLE' };
  } catch {
    return { enabled: false, reason: 'SERVER_UNAVAILABLE' };
  }
  return { enabled: true, wsUrl };
}

/** Asks the game server to create a game. Only for games that can be played. */
export async function createSession(
  settings: Settings,
  gameId: unknown,
  request: Fetch = fetch,
): Promise<CreateSessionResult> {
  if (typeof gameId !== 'string' || !isPlayable(gameId)) {
    return { ok: false, code: 'GAME_NOT_PLAYABLE' };
  }
  const wsUrl = browserAddress(settings);
  if (!settings.GAME_SERVER_URL || !settings.ADMIN_TOKEN || !wsUrl) {
    return { ok: false, code: 'NOT_CONFIGURED' };
  }
  try {
    const response = await request(`${baseOf(settings)}/admin/sessions`, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
      headers: {
        authorization: `Bearer ${settings.ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ gameId }),
    });
    if (response.status >= 500) return { ok: false, code: 'SERVER_UNAVAILABLE' };
    if (response.status !== 201) return { ok: false, code: 'NOT_CREATED' };
    const body = (await response.json()) as Record<string, unknown>;
    const { sessionId, joinCode, hostToken } = body;
    if (
      typeof sessionId !== 'string' ||
      typeof joinCode !== 'string' ||
      typeof hostToken !== 'string'
    ) {
      return { ok: false, code: 'NOT_CREATED' };
    }
    return { ok: true, sessionId, joinCode, hostToken, wsUrl };
  } catch {
    return { ok: false, code: 'SERVER_UNAVAILABLE' };
  }
}
