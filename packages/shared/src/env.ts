import { z } from 'zod';
import { ConfigurationError } from './errors';
import { LOG_LEVELS } from './logger';

/**
 * The single source of truth for configuration.
 *
 * Two rules keep this honest:
 *
 *  1. Nothing outside this module reads `process.env`. Every consumer takes a
 *     parsed `ServerEnv`, so a missing variable is a startup failure with a
 *     readable message rather than an `undefined` that surfaces mid-game.
 *  2. Variables belonging to future phases are optional *in the schema* but
 *     documented in .env.example. We do not pretend to need a database before
 *     the code that uses one exists.
 */

/**
 * An absolute http(s) URL.
 *
 * Hand-rolled rather than `z.url()`, because the WHATWG parser accepts
 * "localhost:11434" as a URL with scheme "localhost" — exactly the typo a developer
 * makes when setting MODEL_BASE_URL, and one that would otherwise surface as an
 * unreachable-provider error at the first Game Master turn instead of at startup.
 */
const httpUrl = z.string().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an absolute http(s) URL, for example http://localhost:11434' },
);

export const MODEL_PROVIDERS = ['ollama', 'openai-compatible'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    // --- open-weight model -------------------------------------------------
    MODEL_PROVIDER: z.enum(MODEL_PROVIDERS).default('ollama'),
    MODEL_NAME: z.string().min(1).default('gemma3:4b'),
    MODEL_BASE_URL: httpUrl.default('http://localhost:11434'),
    MODEL_API_KEY: z.string().optional(),
    MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
    MODEL_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),

    // --- not read by the web app ------------------------------------------
    // The game server validates MONGODB_URI and SENTRY_DSN itself, in
    // packages/server. Nothing reads REDIS_URL: Redis is not built.
    MONGODB_URI: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    SENTRY_DSN: z.string().min(1).optional(),
  })
  .transform((env) => ({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  }));

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Treats blank strings as absent, so an empty placeholder in .env.local behaves like an unset key. */
function stripBlanks(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(stripBlanks(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example with \`npm run setup\` and fill in the values.`,
      { issueCount: parsed.error.issues.length },
    );
  }
  return parsed.data;
}

let cached: ServerEnv | undefined;

/**
 * Parses `process.env` once per process.
 *
 * Server-only. Importing this from a client component would try to read server
 * configuration in the browser, so the guard fails loudly instead of silently
 * returning defaults.
 */
export function getServerEnv(): ServerEnv {
  // Checked via globalThis rather than a bare `window`, because these packages
  // compile without the DOM lib — they are server code and should not typecheck
  // against browser globals.
  if (typeof globalThis === 'object' && 'window' in globalThis) {
    throw new ConfigurationError('getServerEnv() was called in the browser; it is server-only.');
  }
  cached ??= parseServerEnv(process.env);
  return cached;
}

/** Test-only: clears the memoised value so a test can parse a different source. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
