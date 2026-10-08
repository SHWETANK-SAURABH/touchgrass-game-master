import { z } from 'zod';
import { type Result, err, ok } from '@touchgrass/shared';
import { DEFAULT_GAME_MASTER_TIMEOUT_MS } from './game-master-turns';
import { DEFAULT_FINISHED_IDLE_MS, DEFAULT_SESSION_IDLE_MS } from './session-registry';

/**
 * Configuration for the persistent server, read from the environment.
 *
 * This is the one place MongoDB settings enter the application. The store
 * adapter reads no environment variable; it is handed these values. Nothing
 * here is a secret and nothing has a production default: the connection string
 * must be supplied.
 */

export const DEFAULT_DATABASE_NAME = 'touchgrass';
export const DEFAULT_SERVER_PORT = 3001;
/** How often the multi-session development server looks for sessions to evict. */
export const DEFAULT_SESSION_SWEEP_MS = 60_000;

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const serverConfigSchema = z.object({
  /** A MongoDB connection string. Required: there is no default server. */
  MONGODB_URI: z
    .string({ error: 'MONGODB_URI is required for the persistent server.' })
    .trim()
    .min(1, 'MONGODB_URI is required for the persistent server.'),
  MONGODB_DATABASE: optionalText,
  MONGODB_COLLECTION: optionalText,
  SERVER_PORT: z.coerce.number().int().min(0).max(65_535).default(DEFAULT_SERVER_PORT),
});

export interface ServerConfig {
  readonly mongo: {
    readonly uri: string;
    readonly databaseName: string;
    /** Left undefined to use the store's own default. */
    readonly collectionName?: string;
  };
  readonly port: number;
}

/** What was wrong with the configuration, by variable name. The values are never included. */
export interface ServerConfigError {
  readonly code: 'INVALID_CONFIGURATION';
  readonly issues: readonly string[];
}

export function parseServerConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<ServerConfig, ServerConfigError> {
  const parsed = serverConfigSchema.safeParse(env);
  if (!parsed.success) {
    return err({
      code: 'INVALID_CONFIGURATION',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  const { MONGODB_URI, MONGODB_DATABASE, MONGODB_COLLECTION, SERVER_PORT } = parsed.data;
  return ok({
    mongo: {
      uri: MONGODB_URI,
      databaseName: MONGODB_DATABASE ?? DEFAULT_DATABASE_NAME,
      ...(MONGODB_COLLECTION ? { collectionName: MONGODB_COLLECTION } : {}),
    },
    port: SERVER_PORT,
  });
}

const milliseconds = (fallback: number, least: number) =>
  z.coerce.number().int().min(least).max(86_400_000).default(fallback);

const lifecycleConfigSchema = z.object({
  SESSION_IDLE_MS: milliseconds(DEFAULT_SESSION_IDLE_MS, 0),
  SESSION_FINISHED_IDLE_MS: milliseconds(DEFAULT_FINISHED_IDLE_MS, 0),
  SESSION_SWEEP_MS: milliseconds(DEFAULT_SESSION_SWEEP_MS, 100),
});

/** When a loaded session may be evicted, and how often to look. */
export interface LifecycleConfig {
  /** A session with no connections for this long may be evicted. */
  readonly idleMs: number;
  /** The same, for a session whose game is over. */
  readonly finishedIdleMs: number;
  /** How often to look for sessions to evict. */
  readonly sweepMs: number;
}

/**
 * The session lifecycle settings for the multi-session server. Every one has a
 * default, and the defaults live with the registry and here, nowhere else.
 */
export function parseLifecycleConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<LifecycleConfig, ServerConfigError> {
  const blank = (value: string | undefined) =>
    value === undefined || value.trim() === '' ? undefined : value;
  const parsed = lifecycleConfigSchema.safeParse({
    SESSION_IDLE_MS: blank(env.SESSION_IDLE_MS),
    SESSION_FINISHED_IDLE_MS: blank(env.SESSION_FINISHED_IDLE_MS),
    SESSION_SWEEP_MS: blank(env.SESSION_SWEEP_MS),
  });
  if (!parsed.success) {
    return err({
      code: 'INVALID_CONFIGURATION',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return ok({
    idleMs: parsed.data.SESSION_IDLE_MS,
    finishedIdleMs: parsed.data.SESSION_FINISHED_IDLE_MS,
    sweepMs: parsed.data.SESSION_SWEEP_MS,
  });
}

const flag = z
  .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const toolList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );

const gameMasterConfigSchema = z.object({
  GAME_MASTER_ENABLED: flag,
  GAME_MASTER_TOOLS: toolList,
  GAME_MASTER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300_000)
    .default(DEFAULT_GAME_MASTER_TIMEOUT_MS),
});

/** Whether the multi-session server has a Game Master, and how long a turn may take. */
export interface GameMasterConfig {
  /** Off unless asked for: the games need no model to run. */
  readonly enabled: boolean;
  /** How long one turn may wait for the model. */
  readonly timeoutMs: number;
  /**
   * The names of the read-only tools the Game Master is given. Empty unless
   * asked for: with none, the model is asked exactly as it is without tools.
   * Whether each name is a tool that exists is checked where the tools are.
   */
  readonly tools: readonly string[];
}

/**
 * The Game Master switch for the multi-session server. Which model, and where
 * it runs, are the shared `MODEL_*` settings and are not read here.
 */
export function parseGameMasterConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<GameMasterConfig, ServerConfigError> {
  const blank = (value: string | undefined) =>
    value === undefined || value.trim() === '' ? undefined : value.trim().toLowerCase();
  const parsed = gameMasterConfigSchema.safeParse({
    GAME_MASTER_ENABLED: blank(env.GAME_MASTER_ENABLED),
    GAME_MASTER_TOOLS: blank(env.GAME_MASTER_TOOLS),
    GAME_MASTER_TIMEOUT_MS: blank(env.GAME_MASTER_TIMEOUT_MS),
  });
  if (!parsed.success) {
    return err({
      code: 'INVALID_CONFIGURATION',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return ok({
    enabled: parsed.data.GAME_MASTER_ENABLED,
    timeoutMs: parsed.data.GAME_MASTER_TIMEOUT_MS,
    tools: parsed.data.GAME_MASTER_TOOLS,
  });
}

const errorReportingSchema = z
  .object({
    SENTRY_ENABLED: flag,
    SENTRY_DSN: z.string().trim().min(1).optional(),
    SENTRY_ENVIRONMENT: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'must be a short plain name')
      .default('development'),
  })
  .refine((value) => !value.SENTRY_ENABLED || value.SENTRY_DSN !== undefined, {
    path: ['SENTRY_DSN'],
    message: 'SENTRY_DSN is required when SENTRY_ENABLED is true.',
  });

/** Whether unexpected errors are reported to Sentry, and where. */
export type ErrorReportingConfig =
  /** Off: nothing is reported, and the Sentry SDK is not loaded. */
  | { readonly enabled: false }
  | { readonly enabled: true; readonly dsn: string; readonly environment: string };

/**
 * Error reporting is off unless it is switched on, and then it needs to be told
 * where to send. A DSN that is set while reporting is off is ignored.
 */
export function parseErrorReportingConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<ErrorReportingConfig, ServerConfigError> {
  const blank = (value: string | undefined) =>
    value === undefined || value.trim() === '' ? undefined : value.trim();
  const parsed = errorReportingSchema.safeParse({
    SENTRY_ENABLED: blank(env.SENTRY_ENABLED)?.toLowerCase(),
    SENTRY_DSN: blank(env.SENTRY_DSN),
    SENTRY_ENVIRONMENT: blank(env.SENTRY_ENVIRONMENT),
  });
  if (!parsed.success) {
    return err({
      code: 'INVALID_CONFIGURATION',
      // The names of the variables, and never what they were set to.
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  const { SENTRY_ENABLED, SENTRY_DSN, SENTRY_ENVIRONMENT } = parsed.data;
  return ok(
    SENTRY_ENABLED && SENTRY_DSN
      ? { enabled: true, dsn: SENTRY_DSN, environment: SENTRY_ENVIRONMENT }
      : { enabled: false },
  );
}
