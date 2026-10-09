import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `vercel.json` describes the website and the game server as two services.
 * These tests keep the parts that can be checked here from drifting: the files
 * it names exist, the game server's image is the one in `Dockerfile.server`,
 * and only the players' WebSocket path is public on the game server.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (name: string): string => readFileSync(join(root, name), 'utf-8');

interface Service {
  root: string;
  entrypoint?: string;
  runtime?: string;
  bindings?: { type: string; service: string; format: string; env: string }[];
}
const config = JSON.parse(read('vercel.json')) as {
  services: Record<string, Service>;
  rewrites: { source: string; destination: { service: string } }[];
};

/** The instructions of a Dockerfile, without comments and blank lines. */
const instructions = (name: string): string[] =>
  read(name)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

describe('vercel.json', () => {
  it('builds the game server from a container file Vercel accepts, and it exists', () => {
    const game = config.services.game;
    expect(game?.runtime).toBe('container');
    expect(game?.entrypoint).toMatch(/^(Dockerfile|Containerfile)(\.vercel)?$/);
    expect(existsSync(join(root, game?.root ?? '', game?.entrypoint ?? ''))).toBe(true);
  });

  it('uses the same image as Dockerfile.server', () => {
    expect(instructions('Dockerfile.vercel')).toEqual(instructions('Dockerfile.server'));
  });

  it('gives the website the game server under the name the website reads', () => {
    expect(config.services.web?.bindings).toEqual([
      { type: 'service', service: 'game', format: 'url', env: 'GAME_SERVER_URL' },
    ]);
  });

  it('makes only the WebSocket path public on the game server, before the catch-all', () => {
    expect(config.rewrites).toEqual([
      { source: '/sessions/(.*)', destination: { service: 'game' } },
      { source: '/(.*)', destination: { service: 'web' } },
    ]);
  });
});
