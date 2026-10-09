import { NextResponse } from 'next/server';
import { getServerEnv } from '@touchgrass/shared';
import { getPlayConfig } from '@/lib/game-server';

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
  // Behind a host that ends TLS for us, the original scheme is in this header.
  const scheme =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
    new URL(request.url).protocol.replace(':', '');
  return NextResponse.json(await getPlayConfig(env, fetch, scheme === 'https'), {
    headers: { 'cache-control': 'no-store' },
  });
}
