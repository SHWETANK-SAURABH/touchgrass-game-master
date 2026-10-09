import { describe, expect, it } from 'vitest';
import { listGameDefinitions } from '@touchgrass/game-definitions';
import { browserAddress, createSession, getPlayConfig, siteOriginOf } from './game-server';
import { PLAYABLE_GAME_IDS, isPlayable, playableFirst } from './playable';

// Not a credential: a marker that must never appear in anything sent to a browser.
const ADMIN = 'LEAK_MARKER_admin_value_for_tests_only';
const settings = { GAME_SERVER_URL: 'http://example-host.invalid:3001/', ADMIN_TOKEN: ADMIN };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(reply: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fake = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve().then(reply);
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('playable games', () => {
  it('are Tag and Hide & Seek, and nothing else', () => {
    expect([...PLAYABLE_GAME_IDS]).toEqual(['tag', 'hide-and-seek']);
    expect(isPlayable('tag')).toBe(true);
    expect(isPlayable('treasure-hunt')).toBe(false);
  });

  it('are all real game definitions', () => {
    const ids = listGameDefinitions().map((game) => game.id);
    for (const id of PLAYABLE_GAME_IDS) expect(ids).toContain(id);
  });

  it('sort first', () => {
    const sorted = playableFirst([{ id: 'treasure-hunt' }, { id: 'tag' }]);
    expect(sorted.map((game) => game.id)).toEqual(['tag', 'treasure-hunt']);
  });
});

describe('browserAddress', () => {
  it('turns the server address into a WebSocket address', () => {
    expect(browserAddress(settings)).toBe('ws://example-host.invalid:3001');
    expect(browserAddress({ GAME_SERVER_URL: 'https://example-host.invalid' })).toBe(
      'wss://example-host.invalid',
    );
  });

  it('prefers the address given for browsers', () => {
    expect(
      browserAddress({ ...settings, GAME_SERVER_WS_URL: 'wss://play.example-host.invalid/' }),
    ).toBe('wss://play.example-host.invalid');
  });

  it('is absent when nothing is configured', () => {
    expect(browserAddress({})).toBeNull();
  });

  it('is the site itself when the game server is behind the same address', () => {
    const behind = { ...settings, GAME_SERVER_WS_URL: 'same-origin' };
    expect(browserAddress(behind, { host: 'play.example-host.invalid', secure: true })).toBe(
      'wss://play.example-host.invalid',
    );
    expect(browserAddress(behind, { host: 'localhost:3000', secure: false })).toBe(
      'ws://localhost:3000',
    );
  });

  it('is absent when the site address is unknown or is not a plain host', () => {
    const behind = { ...settings, GAME_SERVER_WS_URL: 'same-origin' };
    expect(browserAddress(behind)).toBeNull();
    for (const host of ['', 'a b', 'evil.invalid/path', 'user@evil.invalid', 'x"><script>']) {
      expect(browserAddress(behind, { host, secure: true })).toBeNull();
    }
  });
});

describe('siteOriginOf', () => {
  it('reads the address a proxy forwarded', () => {
    const request = new Request('http://internal.invalid:3000/api/play', {
      headers: { 'x-forwarded-host': 'play.example-host.invalid', 'x-forwarded-proto': 'https' },
    });
    expect(siteOriginOf(request)).toEqual({ host: 'play.example-host.invalid', secure: true });
  });

  it('falls back to the request itself', () => {
    expect(siteOriginOf(new Request('http://localhost:3000/api/play'))).toEqual({
      host: 'localhost:3000',
      secure: false,
    });
  });
});

describe('getPlayConfig', () => {
  it('says playing is not set up when the address or the token is missing', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    expect(await getPlayConfig({}, fetch)).toEqual({ enabled: false, reason: 'NOT_CONFIGURED' });
    expect(await getPlayConfig({ GAME_SERVER_URL: settings.GAME_SERVER_URL }, fetch)).toEqual({
      enabled: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });

  it('is enabled when the game server says it is ready', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { status: 'ok' }));
    expect(await getPlayConfig(settings, fetch)).toEqual({
      enabled: true,
      wsUrl: 'ws://example-host.invalid:3001',
    });
    expect(calls[0]?.url).toBe('http://example-host.invalid:3001/readyz');
    // The readiness check carries no credentials.
    expect(JSON.stringify(calls[0]?.init ?? {})).not.toContain(ADMIN);
  });

  it('is not set up when an https page would have to open a ws:// connection', async () => {
    const site = { host: 'play.example-host.invalid', secure: true };
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    expect(await getPlayConfig(settings, fetch, site)).toEqual({
      enabled: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
    const secure = { ...settings, GAME_SERVER_URL: 'https://example-host.invalid' };
    expect(await getPlayConfig(secure, fetch, site)).toEqual({
      enabled: true,
      wsUrl: 'wss://example-host.invalid',
    });
  });

  it('is unavailable when the game server is not ready or cannot be reached', async () => {
    expect(await getPlayConfig(settings, fakeFetch(() => json(503, {})).fetch)).toEqual({
      enabled: false,
      reason: 'SERVER_UNAVAILABLE',
    });
    const failing = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED ${ADMIN}`);
    });
    expect(await getPlayConfig(settings, failing.fetch)).toEqual({
      enabled: false,
      reason: 'SERVER_UNAVAILABLE',
    });
  });
});

describe('createSession', () => {
  const created = { sessionId: 's-1', joinCode: 'WXYZ', hostToken: 'host-token-for-s-1' };

  it('refuses a game that is not playable, without calling the game server', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, created));
    for (const gameId of ['treasure-hunt', 'nonsense', '', 7, null, undefined]) {
      expect(await createSession(settings, gameId, fetch)).toEqual({
        ok: false,
        code: 'GAME_NOT_PLAYABLE',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses when playing is not set up', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, created));
    expect(await createSession({}, 'tag', fetch)).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    expect(calls).toHaveLength(0);
  });

  it('creates the game on the game server and returns what the host needs', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, created));
    const result = await createSession(settings, 'tag', fetch);
    expect(result).toEqual({ ok: true, ...created, wsUrl: 'ws://example-host.invalid:3001' });
    expect(calls[0]?.url).toBe('http://example-host.invalid:3001/admin/sessions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ gameId: 'tag' }));
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${ADMIN}`);
    // The admin token goes to the game server and never comes back out.
    expect(JSON.stringify(result)).not.toContain(ADMIN);
  });

  it('reports a refusal, a server fault and an unreachable server as short codes', async () => {
    expect(
      await createSession(settings, 'tag', fakeFetch(() => json(401, { error: ADMIN })).fetch),
    ).toEqual({ ok: false, code: 'NOT_CREATED' });
    expect(
      await createSession(settings, 'tag', fakeFetch(() => json(503, { error: ADMIN })).fetch),
    ).toEqual({ ok: false, code: 'SERVER_UNAVAILABLE' });
    const failing = fakeFetch(() => {
      throw new Error(`connect ECONNREFUSED ${ADMIN}`);
    });
    expect(await createSession(settings, 'tag', failing.fetch)).toEqual({
      ok: false,
      code: 'SERVER_UNAVAILABLE',
    });
  });

  it('does not trust a reply that is missing a field or is not JSON', async () => {
    expect(
      await createSession(
        settings,
        'tag',
        fakeFetch(() => json(201, { sessionId: 's-1', joinCode: 'WXYZ' })).fetch,
      ),
    ).toEqual({ ok: false, code: 'NOT_CREATED' });
    expect(
      await createSession(
        settings,
        'tag',
        fakeFetch(() => new Response('<html>', { status: 201 })).fetch,
      ),
    ).toEqual({ ok: false, code: 'SERVER_UNAVAILABLE' });
  });
});
