import { NextResponse } from 'next/server';
import { getServerEnv } from '@touchgrass/shared';
import { getPlayConfig, siteOriginOf } from '@/lib/game-server';

/**
 * Whether games can be played from this site right now, and where a browser
 * connects to play. It gives the address and nothing else: no token.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let env;
  try {
    env = getServerEnv();
  } catch {
    return NextResponse.json(
      { enabled: false, reason: 'NOT_CONFIGURED' },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json(await getPlayConfig(env, fetch, siteOriginOf(request)), {
    headers: { 'cache-control': 'no-store' },
  });
}
