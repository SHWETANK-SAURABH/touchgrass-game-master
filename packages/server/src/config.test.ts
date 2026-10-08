import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_NAME, DEFAULT_SERVER_PORT, parseServerConfig } from './config';
import { unwrap } from './test-support';

const URI = 'mongodb://127.0.0.1:27017';

describe('parseServerConfig', () => {
  it('takes the connection string, database and collection from the environment', () => {
    const config = unwrap(
      parseServerConfig({
        MONGODB_URI: URI,
        MONGODB_DATABASE: 'games',
        MONGODB_COLLECTION: 'saved',
        SERVER_PORT: '4100',
      }),
    );
    expect(config).toEqual({
      mongo: { uri: URI, databaseName: 'games', collectionName: 'saved' },
      port: 4100,
    });
  });

  it('defaults the database and the port, and leaves the collection to the store', () => {
    const config = unwrap(parseServerConfig({ MONGODB_URI: URI }));
    expect(config).toEqual({
      mongo: { uri: URI, databaseName: DEFAULT_DATABASE_NAME },
      port: DEFAULT_SERVER_PORT,
    });
    expect(config.mongo).not.toHaveProperty('collectionName');
  });

  it('treats blank optional values as unset', () => {
    const config = unwrap(
      parseServerConfig({
        MONGODB_URI: `  ${URI}  `,
        MONGODB_DATABASE: '  ',
        MONGODB_COLLECTION: '',
      }),
    );
    expect(config.mongo).toEqual({ uri: URI, databaseName: DEFAULT_DATABASE_NAME });
  });

  it.each([
    ['nothing at all', {}],
    ['a blank connection string', { MONGODB_URI: '   ' }],
    ['an empty connection string', { MONGODB_URI: '' }],
  ])('requires a connection string: there is no default server (%s)', (_label, env) => {
    const result = parseServerConfig(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CONFIGURATION');
      expect(result.error.issues.join(' ')).toContain('MONGODB_URI');
    }
  });

  it.each(['abc', '-1', '70000', '3.5'])('refuses a port of %s', (SERVER_PORT) => {
    const result = parseServerConfig({ MONGODB_URI: URI, SERVER_PORT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.join(' ')).toContain('SERVER_PORT');
  });

  it('never repeats a value in an error, only the name of the variable', () => {
    const marker = 'mongodb://example-host.invalid/?appName=LEAK_MARKER';
    const result = parseServerConfig({ MONGODB_URI: marker, SERVER_PORT: 'LEAK_MARKER' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/LEAK_MARKER|example-host/);
  });

  it('reads only what it is given: the same input gives the same result', () => {
    const env = { MONGODB_URI: URI, MONGODB_DATABASE: 'games' };
    expect(parseServerConfig(env)).toEqual(parseServerConfig(env));
    expect(parseServerConfig.length).toBe(1);
  });
});

describe('where configuration is read', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = join(directory, '..', '..');
  const read = (folder: string): [string, string][] =>
    readdirSync(folder)
      .filter((name) => name.endsWith('.ts') && !name.includes('test'))
      .map((name) => [name, readFileSync(join(folder, name), 'utf-8')]);

  it('is read from the environment in the development entry point only', () => {
    const readers = read(directory)
      .filter(([, source]) => /process\.env/.test(source))
      .map(([name]) => name);
    expect(readers).toEqual(['dev.ts']);
  });

  it('is never read by the store, the lifecycle or the session', () => {
    for (const other of ['session-store', 'session-persistence', 'game-session']) {
      for (const [name, source] of read(join(root, other, 'src'))) {
        expect(source, `${other}/${name}`).not.toMatch(/process\.env/);
      }
    }
  });

  it('hard-codes no connection string or credential', () => {
    for (const [name, source] of read(directory)) {
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/mongodb(\+srv)?:\/\//);
      expect(code, name).not.toMatch(/password|secret/i);
    }
  });

  it('passes the parsed settings straight to the store', () => {
    const dev = readFileSync(join(directory, 'dev.ts'), 'utf-8');
    expect(dev).toContain('createMongoSessionStore(config.value.mongo)');
  });
});
