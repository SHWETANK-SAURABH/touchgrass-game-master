import { createJoinCode, createSessionId, seedFromString, systemClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { createGameSession } from '@touchgrass/game-session';
import { createRealtimeServer } from './ws-server';

/**
 * Development only: `npm run realtime:dev`.
 *
 * Starts one realtime server around one new game so the transport can be tried
 * by hand. It is not a deployment: one game, in memory, no authentication, and
 * nothing advances time. Stop it with Ctrl+C and the game is gone.
 *
 *   REALTIME_PORT   port to listen on (default 3001)
 *   REALTIME_GAME   game definition id (default tag)
 */

const port = Number(process.env.REALTIME_PORT ?? 3001);
const gameId = process.env.REALTIME_GAME ?? 'tag';
const sessionId = createSessionId();

const session = createGameSession(
  {
    type: 'CREATE_SESSION',
    sessionId,
    gameId,
    joinCode: createJoinCode(),
    randomSeed: seedFromString(sessionId),
  },
  contextAt(systemClock),
);

if (!session.ok) {
  console.error(`Could not create a "${gameId}" game: ${session.error.message}`);
  process.exit(1);
}

const server = await createRealtimeServer({ session: session.value, port });

console.log(`TouchGrass realtime (development) listening on ws://localhost:${server.port}`);
console.log(`Game: ${gameId}   Join code: ${session.value.getState().joinCode}`);
console.log('One game, in memory, no authentication. Nothing advances time automatically.');

process.once('SIGINT', () => {
  void server.close().then(() => process.exit(0));
});
