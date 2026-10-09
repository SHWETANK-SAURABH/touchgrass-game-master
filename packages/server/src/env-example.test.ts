import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseServerEnv, serverEnvSchema } from '@touchgrass/shared';
import { parseProductionConfig } from './production-config';

/**
 * `.env.example` is where a new contributor learns what can be configured. These
 * tests keep it honest: every variable the code reads is in it, every variable
 * in it is one the code reads, and it holds no value that looks like a credential.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const template = readFileSync(join(root, '.env.example'), 'utf-8');

/** `NAME=value` lines that are not comments. */
const entries = new Map(
  template
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1] ?? '', (match[2] ?? '').trim()]),
);

/** Every variable the game server and the web app read. */
const READ_BY_THE_SERVER = [
  'MONGODB_URI',
  'MONGODB_DATABASE',
  'MONGODB_COLLECTION',
  'MONGODB_TIMEOUT_MS',
  'SERVER_HOST',
  'SERVER_PORT',
  'ADMIN_TOKEN',
  'SESSION_TOKEN_KEY',
  'SESSION_IDLE_MS',
  'SESSION_FINISHED_IDLE_MS',
  'SESSION_SWEEP_MS',
  'WS_HEARTBEAT_MS',
  'SESSION_TICK_MS',
  'SHUTDOWN_TIMEOUT_MS',
  'GAME_MASTER_ENABLED',
  'GAME_MASTER_TIMEOUT_MS',
  'GAME_MASTER_TOOLS',
  'SENTRY_ENABLED',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
];
const READ_BY_THE_SHARED_SCHEMA = Object.keys(serverEnvSchema.in.shape);
/** Read by a library or a script, not by this project's own parsers. */
const READ_ELSEWHERE = ['MASTRA_TELEMETRY_DISABLED'];

describe('.env.example', () => {
  it('lists every variable the game server reads', () => {
    for (const name of READ_BY_THE_SERVER) expect(entries.has(name), name).toBe(true);
  });

  it('lists every variable of the shared environment schema', () => {
    expect(READ_BY_THE_SHARED_SCHEMA.length).toBeGreaterThan(5);
    for (const name of READ_BY_THE_SHARED_SCHEMA) expect(entries.has(name), name).toBe(true);
  });

  it('lists nothing the code does not read', () => {
    const known = new Set([...READ_BY_THE_SERVER, ...READ_BY_THE_SHARED_SCHEMA, ...READ_ELSEWHERE]);
    expect([...entries.keys()].filter((name) => !known.has(name))).toEqual([]);
  });

  it('names the variables the production configuration actually understands', () => {
    // Each of these, set to nonsense, is reported by that name: so the name is real.
    for (const [name, nonsense] of [
      ['SERVER_HOST', 'not a host!'],
      ['SERVER_PORT', 'x'],
      ['ADMIN_TOKEN', 'short'],
      ['SESSION_TOKEN_KEY', 'short'],
      ['SESSION_IDLE_MS', 'x'],
      ['SESSION_FINISHED_IDLE_MS', 'x'],
      ['SESSION_SWEEP_MS', 'x'],
      ['WS_HEARTBEAT_MS', 'x'],
      ['SESSION_TICK_MS', 'x'],
      ['SHUTDOWN_TIMEOUT_MS', 'x'],
      ['MONGODB_TIMEOUT_MS', 'x'],
      ['GAME_MASTER_ENABLED', 'x'],
      ['GAME_MASTER_TIMEOUT_MS', 'x'],
      ['SENTRY_ENABLED', 'x'],
      ['SENTRY_ENVIRONMENT', 'a b'],
    ] as const) {
      const parsed = parseProductionConfig({
        MONGODB_URI: 'mongodb://example.invalid',
        [name]: nonsense,
      });
      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) expect(parsed.error.issues.join(' '), name).toContain(name);
    }
    expect(parseProductionConfig({}).ok).toBe(false);
  });

  it('leaves every credential blank', () => {
    for (const name of [
      'MONGODB_URI',
      'ADMIN_TOKEN',
      'SESSION_TOKEN_KEY',
      'SENTRY_DSN',
      'MODEL_API_KEY',
      'REDIS_URL',
      'GAME_SERVER_URL',
      'GAME_SERVER_WS_URL',
    ]) {
      expect(entries.get(name), name).toBe('');
    }
    // Nothing in the file looks like a connection string with a password, a
    // long token, or a Sentry key.
    const values = [...entries.values()].join('\n');
    expect(values).not.toMatch(/:\/\/[^/\s:]+:[^@\s]+@/);
    expect(values).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    expect(template).not.toMatch(/https:\/\/[0-9a-f]{16,}@/);
  });

  it('says what must be kept and what must stay the same', () => {
    const about = (name: string): string => {
      const lines = template.split('\n');
      const at = lines.findIndex((line) => line.startsWith(`${name}=`));
      return lines.slice(Math.max(0, at - 8), at).join('\n');
    };
    expect(about('ADMIN_TOKEN')).toMatch(/SECRET/);
    expect(about('SESSION_TOKEN_KEY')).toMatch(/SECRET/);
    expect(about('SESSION_TOKEN_KEY')).toMatch(/THE SAME across restarts/);
    expect(about('MONGODB_URI')).toMatch(/Never put real\s+#?\s*credentials/);
  });

  it('gives defaults that are the code’s own defaults', () => {
    const defaults = parseServerEnv({});
    for (const name of [
      'MODEL_PROVIDER',
      'MODEL_NAME',
      'MODEL_BASE_URL',
      'MODEL_REQUEST_TIMEOUT_MS',
      'MODEL_MAX_RETRIES',
      'MODEL_TEMPERATURE',
      'LOG_LEVEL',
      'NODE_ENV',
    ] as const) {
      expect(entries.get(name), name).toBe(String(defaults[name]));
    }
  });
});
