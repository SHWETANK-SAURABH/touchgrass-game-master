import { NextResponse } from 'next/server';
import { createModelProviderFromEnv } from '@touchgrass/ai';
import { GAME_IDS } from '@touchgrass/game-definitions';
import { HAZARD_CATEGORY_IDS } from '@touchgrass/safety';
import { getServerEnv, toErrorMessage } from '@touchgrass/shared';

/**
 * Liveness and readiness in one response.
 *
 * It reads validated configuration from `shared`, builds a provider through the
 * `ai` abstraction without naming Ollama, probes the open-weight runtime, and
 * counts what `game-definitions` and `safety` actually contain.
 *
 * This is the web app's own health. The game server is a separate process with
 * its own `/healthz` and `/readyz`; see DEPLOYMENT.md.
 *
 * `model.ok: false` is reported with HTTP 200 and `status: "degraded"` on purpose.
 * The app serves game rules and the lobby perfectly well without a model; only
 * the Game Master is unavailable. Returning 503 here would take the whole
 * deployment down for a feature that has a documented fallback.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const startedAt = performance.now();

  let env;
  try {
    env = getServerEnv();
  } catch (cause) {
    // A configuration fault IS fatal: nothing downstream can be trusted.
    return NextResponse.json(
      {
        status: 'misconfigured',
        error: toErrorMessage(cause),
        checkedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }

  const provider = createModelProviderFromEnv(env);
  const model = await provider.health();

  return NextResponse.json(
    {
      status: model.ok ? 'ok' : 'degraded',
      // The web app's part of the project. It does not say what the game server can do.
      phase: 'web-catalogue',
      checkedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAt),
      model,
      content: {
        games: GAME_IDS.length,
        gameIds: GAME_IDS,
        hazardCategories: HAZARD_CATEGORY_IDS.length,
      },
      // Not in this web app. Realtime play, the Game Master and persistence are
      // in the game server, which this site does not connect to.
      notImplemented: ['game-ui'],
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
