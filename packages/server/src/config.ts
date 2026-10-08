import { z } from 'zod';
import { type Result, err, ok } from '@touchgrass/shared';
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
