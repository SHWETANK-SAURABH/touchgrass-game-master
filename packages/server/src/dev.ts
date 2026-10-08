import { createInterface } from 'node:readline';
import { createJoinCode, createSessionId, seedFromString } from '@touchgrass/shared';
import { createMongoSessionStore } from '@touchgrass/session-store/mongodb';
import { parseServerConfig } from './config';
import { startPersistentServer } from './persistent-server';

/**
 * Development only: `npm run server:dev`.
 *
 * Serves one game over WebSocket, kept in MongoDB. It needs a MongoDB server
 * and its connection string:
 *
 *   MONGODB_URI          required, e.g. mongodb://127.0.0.1:27017
 *   MONGODB_DATABASE     default "touchgrass"
 *   MONGODB_COLLECTION   default "sessions"
 *   SERVER_PORT          default 3001
 *   SERVER_GAME          game definition id for a new game (default tag)
 *   SESSION_ID           load this stored session instead of creating one
 *
 * A new game is saved once, when it is created. After that nothing is saved
 * unless you type `save` here. This terminal is the only way to ask: there is
 * no network command for it, because nothing authenticates who would be asking.
 *
 * It is not a deployment: one game, no authentication, an unencrypted socket,
 * and nothing advances time.
 */

const config = parseServerConfig(process.env);
if (!config.ok) {
  console.error('The server is not configured:');
  for (const issue of config.error.issues) console.error(`  ${issue}`);
  process.exit(1);
}

// The application makes the store, from its configuration, and owns it.
const store = createMongoSessionStore(config.value.mongo);

const sessionId = process.env.SESSION_ID?.trim();
const gameId = process.env.SERVER_GAME?.trim() || 'tag';
const newSessionId = createSessionId();

const started = await startPersistentServer({
  store,
  port: config.value.port,
  game: sessionId
    ? { load: sessionId }
    : {
        create: {
          type: 'CREATE_SESSION',
          sessionId: newSessionId,
          gameId,
          joinCode: createJoinCode(),
          randomSeed: seedFromString(newSessionId),
        },
      },
});

if (!started.ok) {
  // The code and message only. A connection string never reaches this point.
  console.error(`Could not start: ${started.error.code}: ${started.error.message}`);
  await store.close();
  process.exit(1);
}

const server = started.value;
const state = server.session.getState();

console.log(`TouchGrass server (development) listening on ws://localhost:${server.port}`);
console.log(`${sessionId ? 'Loaded' : 'Created and saved'} session: ${server.session.id}`);
console.log(`Game: ${state.gameId}   Status: ${state.status}   Join code: ${state.joinCode}`);
// Printed on purpose, here only: this is how a developer gets the host role
// locally. It is new every time the server starts, and it is not stored.
console.log(`Host token: ${server.hostToken}`);
console.log('Nothing is saved automatically. Type "save" to save, "quit" to stop.');

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

const terminal = createInterface({ input: process.stdin });
terminal.on('line', (line) => {
  const command = line.trim().toLowerCase();
  if (command === 'save') {
    void server.save().then((saved) => {
      console.log(saved.ok ? 'Saved.' : `Not saved: ${saved.error.code}: ${saved.error.message}`);
    });
  } else if (command === 'quit') {
    void shutdown();
  } else if (command !== '') {
    console.log('Commands: save, quit');
  }
});

process.once('SIGINT', () => {
  void shutdown();
});
