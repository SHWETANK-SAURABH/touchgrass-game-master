import { z } from 'zod';
import { type Result, err, ok } from '@touchgrass/shared';
import {
  type ErrorReportingConfig,
  type GameMasterConfig,
  type LifecycleConfig,
  type ServerConfig,
  type ServerConfigError,
  parseErrorReportingConfig,
  parseGameMasterConfig,
  parseLifecycleConfig,
  parseServerConfig,
} from './config';

/**
 * The whole configuration of the production server, read once.
 *
 * It is the existing parsers (the store and port, the session lifecycle, the
 * Game Master, error reporting) put together, plus the few settings only a
 * deployed server has. One call reads the environment, and the result is either
 * everything the server needs or the full list of what is wrong. Nothing else in
 * the production entry point looks at the environment, apart from the model
 * settings, which the model code already validates for itself.
 *
 * A problem is reported by the name of the variable. A value is never repeated
 * back: not a connection string, not a key, not a token.
 *
 * The defaults are the cautious ones. The server listens on the loopback
 * address unless told otherwise, the admin endpoints do not exist unless a
 * token is set, and the Game Master and error reporting are off.
 */

export const DEFAULT_SERVER_HOST = '127.0.0.1';
/** A shutdown that has not finished after this long is abandoned: twenty-five seconds. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
/** How often attached sockets are pinged: thirty seconds. */
export const DEFAULT_WS_HEARTBEAT_MS = 30_000;
/** How long a store operation may look for a database server: five seconds. */
export const DEFAULT_MONGODB_TIMEOUT_MS = 5_000;
/** How often the clock of every loaded game is brought up to date: once a second. */
export const DEFAULT_SESSION_TICK_MS = 1_000;

const optionalText = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

const deploymentSchema = z.object({
  /** The address to listen on. A name or an IP address, nothing else. */
  SERVER_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:_-]{1,255}$/, 'must be a host name or an IP address')
    .default(DEFAULT_SERVER_HOST),
  /** The bearer value that opens the admin endpoints. Without it they do not exist. */
  ADMIN_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9._~+/=-]{32,256}$/, 'must be 32 to 256 characters, with no spaces')
    .optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  /** 0 turns the heartbeat off. */
  WS_HEARTBEAT_MS: z.coerce.number().int().min(0).max(600_000).default(DEFAULT_WS_HEARTBEAT_MS),
  /** 0 turns the game clock off: rounds then end only when a message arrives. */
  SESSION_TICK_MS: z.coerce.number().int().min(0).max(60_000).default(DEFAULT_SESSION_TICK_MS),
  MONGODB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(60_000)
    .default(DEFAULT_MONGODB_TIMEOUT_MS),
});

export interface ProductionConfig {
  readonly host: string;
  readonly port: number;
  readonly mongo: ServerConfig['mongo'] & { readonly serverSelectionTimeoutMs: number };
  readonly lifecycle: LifecycleConfig;
  readonly gameMaster: GameMasterConfig;
  readonly reporting: ErrorReportingConfig;
  /** Present only when the admin endpoints are to exist. Never logged. */
  readonly adminToken?: string;
  /**
   * Present only when one was given. With it, a player's token survives a
   * restart; without it, every restart ends every token. Never logged.
   */
  readonly tokenKey?: Uint8Array;
  readonly shutdownTimeoutMs: number;
  readonly heartbeatMs: number;
  /** How often loaded games are told the time. 0 means never. */
  readonly tickMs: number;
}

/** What is configured, as yes or no and plain names. Safe to log: it holds no value that was set. */
export interface ProductionConfigSummary {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly gameMaster: boolean;
  readonly gameMasterTools: readonly string[];
  readonly errorReporting: boolean;
  readonly adminEndpoints: boolean;
  readonly tokenKeyConfigured: boolean;
  readonly idleMs: number;
  readonly heartbeatMs: number;
}

export function summarizeProductionConfig(config: ProductionConfig): ProductionConfigSummary {
  return {
    host: config.host,
    port: config.port,
    database: config.mongo.databaseName,
    gameMaster: config.gameMaster.enabled,
    gameMasterTools: config.gameMaster.tools,
    errorReporting: config.reporting.enabled,
    adminEndpoints: config.adminToken !== undefined,
    tokenKeyConfigured: config.tokenKey !== undefined,
    idleMs: config.lifecycle.idleMs,
    heartbeatMs: config.heartbeatMs,
  };
}

export function parseProductionConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<ProductionConfig, ServerConfigError> {
  const server = parseServerConfig(env);
  const lifecycle = parseLifecycleConfig(env);
  const gameMaster = parseGameMasterConfig(env);
  const reporting = parseErrorReportingConfig(env);
  const deployment = deploymentSchema.safeParse({
    SERVER_HOST: optionalText(env.SERVER_HOST),
    ADMIN_TOKEN: optionalText(env.ADMIN_TOKEN),
    SHUTDOWN_TIMEOUT_MS: optionalText(env.SHUTDOWN_TIMEOUT_MS),
    WS_HEARTBEAT_MS: optionalText(env.WS_HEARTBEAT_MS),
    SESSION_TICK_MS: optionalText(env.SESSION_TICK_MS),
    MONGODB_TIMEOUT_MS: optionalText(env.MONGODB_TIMEOUT_MS),
  });

  // Everything that is wrong is reported together, by name.
  const issues: string[] = [];
  for (const part of [server, lifecycle, gameMaster, reporting]) {
    if (!part.ok) issues.push(...part.error.issues);
  }
  if (!deployment.success) {
    issues.push(
      ...deployment.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  // The key player tokens are worked out from, as base64 or base64url. It is
  // checked on its own, so a problem with it is named whatever else is wrong.
  let tokenKey: Uint8Array | undefined;
  const encodedKey = optionalText(env.SESSION_TOKEN_KEY);
  if (encodedKey !== undefined) {
    const decoded = /^[A-Za-z0-9+/_=-]+$/.test(encodedKey)
      ? new Uint8Array(Buffer.from(encodedKey, 'base64'))
      : new Uint8Array(0);
    if (decoded.byteLength < 32) {
      issues.push('SESSION_TOKEN_KEY: must be base64 that decodes to at least 32 bytes');
    } else {
      tokenKey = decoded;
    }
  }

  if (
    issues.length > 0 ||
    !server.ok ||
    !lifecycle.ok ||
    !gameMaster.ok ||
    !reporting.ok ||
    !deployment.success
  ) {
    return err({ code: 'INVALID_CONFIGURATION', issues });
  }

  return ok({
    host: deployment.data.SERVER_HOST,
    port: server.value.port,
    mongo: {
      ...server.value.mongo,
      serverSelectionTimeoutMs: deployment.data.MONGODB_TIMEOUT_MS,
    },
    lifecycle: lifecycle.value,
    gameMaster: gameMaster.value,
    reporting: reporting.value,
    ...(deployment.data.ADMIN_TOKEN === undefined
      ? {}
      : { adminToken: deployment.data.ADMIN_TOKEN }),
    ...(tokenKey === undefined ? {} : { tokenKey }),
    shutdownTimeoutMs: deployment.data.SHUTDOWN_TIMEOUT_MS,
    heartbeatMs: deployment.data.WS_HEARTBEAT_MS,
    tickMs: deployment.data.SESSION_TICK_MS,
  });
}
