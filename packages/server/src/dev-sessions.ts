import { createInterface } from 'node:readline';
import { createJoinCode, createSessionId, seedFromString, systemClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { createMongoSessionStore } from '@touchgrass/session-store/mongodb';
import { parseLifecycleConfig, parseServerConfig } from './config';
import { startSessionServer } from './session-server';

/**
 * Development only: `npm run sessions:dev`.
 *
 * Serves many games from one WebSocket listener, kept in MongoDB. A client
 * connects to `ws://localhost:<port>/sessions/<sessionId>`.
 *
 *   MONGODB_URI                required, e.g. mongodb://127.0.0.1:27017
 *   MONGODB_DATABASE           default "touchgrass"
 *   MONGODB_COLLECTION         default "sessions"
 *   SERVER_PORT                default 3001
 *   SESSION_IDLE_MS            evict a session unused for this long (default 30 minutes)
 *   SESSION_FINISHED_IDLE_MS   the same, once its game is over (default 0)
 *   SESSION_SWEEP_MS           how often to look for sessions to evict (default 1 minute)
 *
 * Sessions are not created over the network. This terminal is where they are
 * made and managed, because nothing authenticates who would be asking:
 *
 *   create [gameId]   make a game (default tag) and print how to reach it
 *   list              the sessions in memory
 *   save <id>         save one now
 *   evict <id>        release one from memory, saving it first if needed
 *   quit              save what is unsaved and stop
 *
 * A stored session that is not in memory is loaded when someone connects to it,
 * and evicted again once it has gone unused for long enough. Evicting never
 * deletes: the game stays in MongoDB.
 *
 * `quit` and Ctrl+C stop gracefully. If a session cannot be saved on the way
 * out, the error is printed and the exit status is non-zero.
 *
 * It is not a deployment: no authentication, an unencrypted socket, one
 * process, and nothing advances time.
 */

const config = parseServerConfig(process.env);
const lifecycle = parseLifecycleConfig(process.env);
if (!config.ok || !lifecycle.ok) {
  console.error('The server is not configured:');
  for (const result of [config, lifecycle]) {
    if (!result.ok) for (const issue of result.error.issues) console.error(`  ${issue}`);
  }
  process.exit(1);
}

// The application makes the one store, from its configuration.
const store = createMongoSessionStore(config.value.mongo);

const started = await startSessionServer({
  store,
  port: config.value.port,
  idleMs: lifecycle.value.idleMs,
  finishedIdleMs: lifecycle.value.finishedIdleMs,
  // The session id, what happened, and an error code at most.
  onEvent: (event) => {
    console.log(`[session ${event.sessionId}] ${event.type}${event.code ? `: ${event.code}` : ''}`);
  },
});

if (!started.ok) {
  // The code and message only. A connection string never reaches this point.
  console.error(`Could not start: ${started.error.code}: ${started.error.message}`);
  await store.close();
  process.exit(1);
}

const server = started.value;
const { registry } = server;

console.log(`TouchGrass sessions server (development) listening on port ${server.port}`);
console.log(`Connect to ws://localhost:${server.port}/sessions/<sessionId>`);
console.log('Commands: create [gameId], list, save <id>, evict <id>, quit');

// The one timer: it only asks the registry to look. The registry has none.
const sweep = setInterval(() => {
  void registry.evictIdle();
}, lifecycle.value.sweepMs);

const create = async (gameId: string): Promise<void> => {
  const sessionId = createSessionId();
  const created = await registry.create(
    {
      type: 'CREATE_SESSION',
      sessionId,
      gameId,
      joinCode: createJoinCode(),
      randomSeed: seedFromString(sessionId),
    },
    contextAt(systemClock),
  );
  if (!created.ok) {
    console.log(`Not created: ${created.error.code}: ${created.error.message}`);
    return;
  }
  const state = created.value.session.getState();
  console.log(`Address: ws://localhost:${server.port}/sessions/${sessionId}`);
  console.log(`Game: ${state.gameId}   Join code: ${state.joinCode}`);
  // Printed on purpose, here only: this is how a developer gets the host role
  // locally. It is new every time the session is loaded, and it is not stored.
  console.log(`Host token: ${created.value.hostToken}`);
};

/**
 * Stops gracefully: the sweep first, then the server, which closes every
 * session's connections, saves what is unsaved and closes the store.
 */
const shutdown = async (): Promise<void> => {
  clearInterval(sweep);
  try {
    const result = await server.shutdown();
    if (!result.ok) {
      console.error(`The server did not stop cleanly: ${result.error.message}`);
      for (const failure of result.error.failures) {
        console.error(`  ${failure.sessionId}: ${failure.error.code}: ${failure.error.message}`);
      }
      process.exit(1);
    }
    console.log('Stopped.');
    process.exit(0);
  } catch {
    console.error('The server did not stop cleanly.');
    process.exit(1);
  }
};

const terminal = createInterface({ input: process.stdin });
terminal.on('line', (line) => {
  const [command = '', argument = ''] = line.trim().split(/\s+/);
  switch (command.toLowerCase()) {
    case 'create':
      void create(argument || 'tag');
      break;
    case 'list':
      for (const info of registry.sessions()) {
        console.log(`${info.sessionId}  ${info.state}  connections: ${info.connections}`);
      }
      break;
    case 'save': {
      const handle = registry.get(argument);
      if (!handle) console.log('That session is not in memory.');
      else {
        void handle.save().then((saved) => {
          console.log(saved.ok ? 'Saved.' : `Not saved: ${saved.error.code}`);
        });
      }
      break;
    }
    case 'evict':
      void registry.evict(argument).then((evicted) => {
        console.log(evicted.ok ? 'Not in memory now.' : `Not evicted: ${evicted.error.code}`);
      });
      break;
    case 'quit':
      void shutdown();
      break;
    case '':
      break;
    default:
      console.log('Commands: create [gameId], list, save <id>, evict <id>, quit');
  }
});

process.once('SIGINT', () => {
  void shutdown();
});
