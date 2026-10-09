import { NextResponse } from 'next/server';
import { getServerEnv } from '@touchgrass/shared';
import { createSession, siteOriginOf } from '@/lib/game-server';

/**
 * Creates a game on the game server, for whoever pressed "Create game".
 *
 * The site holds the game server's admin token and uses it here, on the server.
 * The browser is given only what a host needs: the new game's id, its join
 * code, its host token, and the address to connect to.
 *
 * Anyone who can reach this site can create a game. There are no accounts. The
 * only games that can be created are the ones that can be played.
 */
export const dynamic = 'force-dynamic';

const STATUS = {
  GAME_NOT_PLAYABLE: 400,
  NOT_CREATED: 502,
  NOT_CONFIGURED: 503,
  SERVER_UNAVAILABLE: 503,
} as const;

export async function POST(request: Request): Promise<NextResponse> {
  const headers = { 'cache-control': 'no-store' };
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 1_024)
      return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 413, headers });
    body = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400, headers });
  }

  let env;
  try {
    env = getServerEnv();
  } catch {
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503, headers });
  }

  const created = await createSession(
    env,
    (body as { gameId?: unknown } | null)?.gameId,
    fetch,
    siteOriginOf(request),
  );
  if (!created.ok) {
    return NextResponse.json({ error: created.code }, { status: STATUS[created.code], headers });
  }
  return NextResponse.json(
    {
      sessionId: created.sessionId,
      joinCode: created.joinCode,
      hostToken: created.hostToken,
      wsUrl: created.wsUrl,
    },
    { status: 201, headers },
  );
}
