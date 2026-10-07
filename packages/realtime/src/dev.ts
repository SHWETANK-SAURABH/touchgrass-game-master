import { createJoinCode, createSessionId, seedFromString, systemClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { createHostedGame } from './hosted-game';
import { createRealtimeServer } from './ws-server';

/**
 * Development only: `npm run realtime:dev`.
 *
 * Starts one realtime server around one new game so the transport can be tried
 * by hand, and prints the join code and the host token. It is not a deployment:
 * one game, in memory, no authentication, an unencrypted socket, and nothing
 * advances time. Stop it with Ctrl+C and the game and every token are gone.
 *
 *   REALTIME_PORT   port to listen on (default 3001)
 *   REALTIME_GAME   game definition id (default tag)
 */

const port = Number(process.env.REALTIME_PORT ?? 3001);
const gameId = process.env.REALTIME_GAME ?? 'tag';
const sessionId = createSessionId();

const game = createHostedGame(
  {
    type: 'CREATE_SESSION',
    sessionId,
    gameId,
    joinCode: createJoinCode(),
    randomSeed: seedFromString(sessionId),
  },
  contextAt(systemClock),
);

if (!game.ok) {
  console.error(`Could not create a "${gameId}" game: ${game.error.message}`);
  process.exit(1);
}

const server = await createRealtimeServer({ room: game.value.room, port });

console.log(`TouchGrass realtime (development) listening on ws://localhost:${server.port}`);
console.log(`Game: ${gameId}   Join code: ${game.value.session.getState().joinCode}`);
// Printed on purpose, here only: this is how a developer gets the host role
// locally. Nothing else in the package logs a token.
console.log(`Host token: ${game.value.hostToken}`);
console.log('One game, in memory, no authentication, unencrypted. Nothing advances time.');

process.once('SIGINT', () => {
  void server.close().then(() => process.exit(0));
});
