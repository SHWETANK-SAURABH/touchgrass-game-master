import { createLogger, parseServerEnv } from '@touchgrass/shared';
import { createMongoSessionStore } from '@touchgrass/session-store/mongodb';
import type { GameMasterTurnsOptions } from './game-master-turns';
import { parseProductionConfig, summarizeProductionConfig } from './production-config';
import { startProductionServer } from './production-server';
import { type ErrorReporter, noopReporter } from './reporting';

/**
 * The production entry point: `node dist/server/main.mjs`.
 *
 * It reads the configuration once, builds the one store, starts the server, and
 * waits to be told to stop. It has no terminal commands and prints no token:
 * sessions are created through the admin endpoint. Everything it writes is one
 * JSON line.
 *
 *   SIGTERM, SIGINT   stop gracefully; exit 0 if every session was saved, 1 if not
 *   a second signal   exit at once with 1
 *
 * It exits with 1, having started nothing, if the configuration is not valid or
 * the port cannot be bound. It does not exit because the database or the model
 * runtime is away: it starts, says it is not ready, and becomes ready when the
 * database answers.
 */

const logger = createLogger({ name: 'server' });

const parsed = parseProductionConfig(process.env);
if (!parsed.ok) {
  // The names of the variables that are wrong. Never what they were set to.
  logger.error('invalid configuration', { issues: parsed.error.issues });
  process.exit(1);
}
const config = parsed.value;

// With error reporting off, the Sentry SDK is not even loaded.
const reporter: ErrorReporter = config.reporting.enabled
  ? (await import('./sentry')).createSentryReporter(config.reporting)
  : noopReporter;

// With the Game Master off, the model code is not even loaded.
let gameMaster: GameMasterTurnsOptions | undefined;
if (config.gameMaster.enabled) {
  try {
    const { createGameMasterFromEnv, selectGameMasterTools } =
      await import('@touchgrass/ai/game-master');
    gameMaster = {
      gameMaster: createGameMasterFromEnv(parseServerEnv(process.env), {
        tools: selectGameMasterTools(config.gameMaster.tools),
        onToolError: (tool, error) => {
          reporter.captureError(error, { area: 'tool', tool });
        },
      }),
      timeoutMs: config.gameMaster.timeoutMs,
    };
  } catch {
    logger.error('invalid configuration', {
      issues: ['The Game Master is enabled: check the MODEL_* settings and GAME_MASTER_TOOLS.'],
    });
    process.exit(1);
  }
}

// The one store, from the configuration. It connects when it is first used.
const store = createMongoSessionStore(config.mongo);

const started = await startProductionServer({
  config,
  store,
  logger,
  reporter,
  ...(gameMaster ? { gameMaster } : {}),
});
if (!started.ok) {
  logger.error('could not start', { code: started.error.code });
  await store.close();
  process.exit(1);
}
const server = started.value;

logger.info('listening', { ...summarizeProductionConfig(config), port: server.port });
if (!config.tokenKey) {
  logger.warn('no SESSION_TOKEN_KEY: player tokens will not survive a restart');
}
// Said once at start-up, so the reason for a failing readiness check is in the log.
void server.readiness().then((state) => {
  if (state.status !== 'ready') logger.warn('not ready: the session store did not answer');
});

let stopping = false;
const stop = (reason: string, failed = false): void => {
  if (stopping) {
    // Asked twice: stop waiting.
    logger.error('forced exit', { reason });
    process.exit(1);
  }
  stopping = true;
  logger.info('shutting down', { reason });
  void server.shutdown().then(
    (result) => {
      logger.info('stopped', { ...result });
      process.exit(result.ok && !failed ? 0 : 1);
    },
    () => {
      logger.error('shutdown failed');
      process.exit(1);
    },
  );
};

process.on('SIGTERM', () => {
  stop('SIGTERM');
});
process.on('SIGINT', () => {
  stop('SIGINT');
});

// Something nothing caught. It is reported, and the process stops as cleanly as
// it still can: carrying on in an unknown state would be worse.
const fatal = (kind: string) => (error: unknown) => {
  reporter.captureError(error, { area: 'server', stage: kind });
  logger.error('fatal error', { kind });
  stop(kind, true);
};
process.on('uncaughtException', fatal('uncaught_exception'));
process.on('unhandledRejection', fatal('unhandled_rejection'));
