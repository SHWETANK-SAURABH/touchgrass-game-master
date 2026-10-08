import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type Result, err } from '@touchgrass/shared';
import { InMemorySessionStore, type SessionStoreError } from '@touchgrass/session-store';
import type { ClosableSessionStore } from './persistent-server';
import { createPersistentSessions } from './persistent-sessions';
import type { SessionHandle } from './session-handle';
import { type SessionServer, startSessionServer } from './session-server';
import {
  CODE,
  at,
  codeOf,
  connection,
  createCommand,
  send,
  testClock,
  unwrap,
} from './test-support';

/**
 * Real sockets against one real listener, with a real registry behind it and
 * an in-memory store whose calls a test can hold.
 */

const STORAGE_ERROR: SessionStoreError = {
  code: 'STORAGE_ERROR',
  message: 'LEAK_MARKER the database at example-host.invalid is away.',
};

type Operation = 'save' | 'load';

function heldStore() {
  const inner = new InMemorySessionStore();
  const calls = { save: 0, load: 0, delete: 0, close: 0 };
  const events: string[] = [];
  const holding = new Set<Operation>();
  const held: { operation: Operation; sessionId: string; finish(): void }[] = [];
  const failing = { save: new Set<string>(), load: new Set<string>() };
  let closed = false;

  const gate = <T>(
    operation: Operation,
    sessionId: string,
    run: () => Promise<Result<T, SessionStoreError>>,
  ): Promise<Result<T, SessionStoreError>> => {
    calls[operation] += 1;
    const perform = async (): Promise<Result<T, SessionStoreError>> => {
      const result = closed || failing[operation].has(sessionId) ? err(STORAGE_ERROR) : await run();
      events.push(`${operation}:${sessionId}:${result.ok ? 'end' : 'failed'}`);
      return result;
    };
    if (!holding.has(operation)) return perform();
    return new Promise((resolve) => {
      const call = {
        operation,
        sessionId,
        finish() {
          held.splice(held.indexOf(call), 1);
          void perform().then(resolve);
        },
      };
      held.push(call);
    });
  };

  const store: ClosableSessionStore = {
    save: (snapshot) => gate('save', snapshot.sessionId, () => inner.save(snapshot)),
    load: (sessionId) => gate('load', sessionId, () => inner.load(sessionId)),
    delete: (sessionId) => {
      calls.delete += 1;
      return inner.delete(sessionId);
    },
    close() {
      calls.close += 1;
      events.push('store.close');
      closed = true;
      return Promise.resolve();
    },
  };
  return {
    store,
    inner,
    calls,
    events,
    held,
    failing,
    hold: (...operations: Operation[]): void => {
      for (const operation of operations) holding.add(operation);
    },
    release: (...operations: Operation[]): void => {
      for (const operation of operations) holding.delete(operation);
    },
  };
}

/** What a client was sent, decoded. */
interface Message {
  type: string;
  code?: string;
  playerId?: string;
  token?: string;
  state?: { id: string; status: string; players: { displayName: string }[] };
}

/** A client that queues what it receives so a test can await the next message. */
class Client {
  private readonly queue: Message[] = [];
  private readonly waiting: ((message: Message) => void)[] = [];
  readonly raw: string[] = [];
  readonly closed: Promise<void>;

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const text = String(event.data);
      this.raw.push(text);
      const message = JSON.parse(text) as Message;
      const next = this.waiting.shift();
      if (next) next(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', () => {
        resolve();
      });
    });
  }

  /** Connects to a path as it is given. */
  static at(port: number, path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const client = new Client(socket);
      socket.addEventListener('open', () => {
        resolve(client);
      });
      socket.addEventListener('error', () => {
        reject(new Error('the socket could not connect'));
      });
    });
  }

  static open(port: number, sessionId: string): Promise<Client> {
    return Client.at(port, `/sessions/${encodeURIComponent(sessionId)}`);
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  next(): Promise<Message> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  pending(): number {
    return this.queue.length;
  }

  async join(displayName: string): Promise<{ playerId: string; token: string; sessionId: string }> {
    this.send({ type: 'join', joinCode: CODE, displayName });
    const message = await this.next();
    if (message.type !== 'joined' || !message.playerId || !message.token || !message.state) {
      throw new Error(`expected joined, got ${message.type}`);
    }
    return { playerId: message.playerId, token: message.token, sessionId: message.state.id };
  }
}

/** Waits until the server has processed everything this client has sent so far. */
async function settled(client: Client): Promise<void> {
  client.send('?');
  for (;;) {
    const message = await client.next();
    if (message.type === 'error' && message.code === 'BAD_MESSAGE') return;
  }
}

/** Waits, a turn of the event loop at a time, for something the server does on its own. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('the condition never became true');
}

const SESSION_CLOSED = { type: 'error', code: 'SESSION_CLOSED' };
const READY = { type: 'action', intent: { type: 'PLAYER_READY' } };

let running: SessionServer[] = [];

async function start(backing = heldStore()) {
  let minted = 0;
  const server = unwrap(
    await startSessionServer({
      store: backing.store,
      port: 0,
      clock: testClock(),
      createToken: () => {
        minted += 1;
        return `token-${minted}`;
      },
    }),
  );
  running.push(server);
  const create = async (sessionId: string): Promise<SessionHandle> =>
    unwrap(await server.registry.create(createCommand(sessionId), at(0)));
  return { ...backing, server, create };
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.shutdown()));
  running = [];
});

const names = (handle: SessionHandle): string[] =>
  handle.session.getState().players.map((player) => player.displayName);

describe('one listener for many sessions', () => {
  it('serves each session at its own address, from one port', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const b = await create('b');

    const inA = await Client.open(server.port, 'a');
    const inB = await Client.open(server.port, 'b');
    expect((await inA.join('Ada')).sessionId).toBe('a');
    expect((await inB.join('Bo')).sessionId).toBe('b');

    expect(names(a)).toEqual(['Ada']);
    expect(names(b)).toEqual(['Bo']);
    expect(a.room.connectionCount()).toBe(1);
    expect(b.room.connectionCount()).toBe(1);
    expect(server.socketCount()).toBe(2);
  });

  it('uses the registry it owns, and makes no handle of its own', async () => {
    const { server, create } = await start();
    const handle = await create('a');
    const client = await Client.open(server.port, 'a');
    await client.join('Ada');
    expect(server.registry.get('a')).toBe(handle);
    expect(handle.room.connectionCount()).toBe(1);
    expect(handle.hasUnsavedChanges()).toBe(true);
  });

  it('accepts several connections to one session and tells them all', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const clients = await Promise.all(['a', 'a', 'a'].map((id) => Client.open(server.port, id)));
    for (const [index, client] of clients.entries()) {
      await client.join(`Player ${index}`);
      for (const earlier of clients.slice(0, index)) {
        expect((await earlier.next()).type).toBe('update');
      }
    }
    expect(a.room.connectionCount()).toBe(3);

    clients[0]?.send(READY);
    for (const client of clients) expect((await client.next()).type).toBe('update');
  });

  it('never lets a broadcast, a token or a host cross into another session', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const b = await create('b');
    const [a1, a2, b1] = await Promise.all([
      Client.open(server.port, 'a'),
      Client.open(server.port, 'a'),
      Client.open(server.port, 'b'),
    ]);
    const inA = await a1.join('Ada');
    const inB = await b1.join('Bo');
    const untouched = b.session.getState();

    // Activity in A: a join, an action, a host command.
    await a2.join('Al');
    await a1.next();
    a1.send(READY);
    await a1.next();
    await a2.next();
    const host = await Client.open(server.port, 'a');
    host.send({ type: 'host_auth', token: a.hostToken });
    expect((await host.next()).type).toBe('host_authorized');
    host.send({ type: 'host_command', command: { type: 'ABORT_SESSION', reason: 'rain' } });
    for (const client of [a1, a2, host]) expect((await client.next()).type).toBe('update');

    // None of it reached B.
    await settled(b1);
    expect(b1.pending()).toBe(0);
    expect(b1.raw.join('')).not.toContain('"id":"a"');
    expect(b.session.getState()).toBe(untouched);
    expect(a.session.getState().status).toBe('aborted');

    // A's capabilities are nothing at B's address, and B's nothing at A's.
    const stranger = await Client.open(server.port, 'b');
    stranger.send({ type: 'resume', token: inA.token });
    stranger.send({ type: 'host_auth', token: a.hostToken });
    expect(await stranger.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });
    expect(await stranger.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });
    const other = await Client.open(server.port, 'a');
    other.send({ type: 'resume', token: inB.token });
    other.send({ type: 'host_auth', token: b.hostToken });
    expect(await other.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });
    expect(await other.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });
  });

  it('keeps two sessions going at once, neither waiting for the other', async () => {
    const { server, create, held, hold, release } = await start();
    const a = await create('a');
    const b = await create('b');
    const inA = await Client.open(server.port, 'a');
    const inB = await Client.open(server.port, 'b');
    await inA.join('Ada');
    await inB.join('Bo');

    // A's save is at the store and not finishing.
    hold('save');
    const savingA = a.save();
    await until(() => held.length === 1);

    // B plays on and is saved, and A still takes messages meanwhile.
    release('save');
    inB.send(READY);
    expect((await inB.next()).type).toBe('update');
    unwrap(await b.save());
    expect(b.hasUnsavedChanges()).toBe(false);
    inA.send(READY);
    expect((await inA.next()).type).toBe('update');
    expect(a.hasUnsavedChanges()).toBe(true);

    held[0]?.finish();
    unwrap(await savingA);
    // A changed while its save was at the store, so it is still unsaved.
    expect(a.hasUnsavedChanges()).toBe(true);
  });

  it('answers an invalid message and keeps the connection', async () => {
    const { server, create } = await start();
    await create('a');
    const client = await Client.open(server.port, 'a');
    client.send('{"type":');
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    client.send({ type: 'join', sessionId: 'b', joinCode: CODE, displayName: 'Ada' });
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    expect((await client.join('Ada')).sessionId).toBe('a');
  });
});

describe('finding the session for a connection', () => {
  it('loads a stored session the first time someone connects to it', async () => {
    const { server, inner, calls } = await start();
    unwrap(await createPersistentSessions(inner).create(createCommand('stored'), at(0)));
    expect(server.registry.get('stored')).toBeUndefined();

    const client = await Client.open(server.port, 'stored');
    expect((await client.join('Ada')).sessionId).toBe('stored');
    const handle = server.registry.get('stored');
    expect(handle?.room.connectionCount()).toBe(1);
    expect(calls.load).toBe(1);

    // The next connection finds it loaded and does not read the store.
    const second = await Client.open(server.port, 'stored');
    await second.join('Al');
    expect(calls.load).toBe(1);
    expect(server.registry.get('stored')).toBe(handle);
  });

  it('loads once for connections that arrive together, into one room', async () => {
    const { server, inner, calls, held, hold } = await start();
    unwrap(await createPersistentSessions(inner).create(createCommand('stored'), at(0)));
    hold('load');
    const clients = await Promise.all([1, 2, 3].map(() => Client.open(server.port, 'stored')));
    for (const [index, client] of clients.entries()) {
      client.send({ type: 'join', joinCode: CODE, displayName: `Player ${index}` });
    }
    await until(() => held.length === 1);
    expect(server.registry.get('stored')).toBeUndefined();

    held[0]?.finish();
    await until(() => server.registry.get('stored')?.room.connectionCount() === 3);
    expect(calls.load).toBe(1);
    expect(held).toEqual([]);
  });

  it('refuses a session that does not exist, and registers nothing', async () => {
    const { server, calls } = await start();
    const client = await Client.open(server.port, 'nothing');
    client.send({ type: 'join', joinCode: CODE, displayName: 'Ada' });
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_NOT_FOUND' });
    await client.closed;
    expect(client.pending()).toBe(0);
    expect(server.registry.get('nothing')).toBeUndefined();
    expect(calls.save).toBe(0);
    await until(() => server.socketCount() === 0);
  });

  it('refuses an address that names no session, without asking the registry or the store', async () => {
    const { server, calls } = await start();
    for (const path of ['', '/', '/sessions/', '/sessions/a/b', '/games/a', '/sessions/%20']) {
      const client = await Client.at(server.port, path);
      expect(await client.next(), path).toEqual({ type: 'error', code: 'INVALID_SESSION_PATH' });
      await client.closed;
    }
    expect(calls).toEqual({ save: 0, load: 0, delete: 0, close: 0 });
  });

  it('refuses a session the store cannot give, and says nothing of why', async () => {
    const { server, inner, failing } = await start();
    unwrap(await createPersistentSessions(inner).create(createCommand('stored'), at(0)));
    failing.load.add('stored');
    const client = await Client.open(server.port, 'stored');
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_UNAVAILABLE' });
    await client.closed;
    expect(client.raw.join('')).not.toMatch(/LEAK_MARKER|example-host|STORAGE/);
    expect(server.registry.get('stored')).toBeUndefined();

    // Nothing was kept of the failure: it can be connected to once the store is back.
    failing.load.clear();
    const again = await Client.open(server.port, 'stored');
    expect((await again.join('Ada')).sessionId).toBe('stored');
  });

  it('does not create a session for an address', async () => {
    const { server, inner } = await start();
    const client = await Client.open(server.port, 'brand-new');
    client.send(createCommand('brand-new'));
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_NOT_FOUND' });
    await client.closed;
    expect(unwrap(await inner.load('brand-new'))).toBeNull();
  });
});

describe('a connection going away', () => {
  it('is forgotten when it closes, and the others in its session carry on', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const b = await create('b');
    const [first, second, other] = await Promise.all([
      Client.open(server.port, 'a'),
      Client.open(server.port, 'a'),
      Client.open(server.port, 'b'),
    ]);
    await first.join('Ada');
    await second.join('Al');
    await first.next();
    await other.join('Bo');

    first.socket.close();
    await first.closed;
    await until(() => a.room.connectionCount() === 1);
    expect(b.room.connectionCount()).toBe(1);
    // The player is still in the game; only the connection went.
    expect(names(a)).toEqual(['Ada', 'Al']);

    second.send(READY);
    expect((await second.next()).type).toBe('update');
    await settled(other);
    expect(other.pending()).toBe(0);
    await until(() => server.socketCount() === 2);
  });
});

describe('a session being unloaded', () => {
  async function twoSessions() {
    const backing = await start();
    const a = await backing.create('a');
    const b = await backing.create('b');
    const [a1, a2, silent, b1] = await Promise.all([
      Client.open(backing.server.port, 'a'),
      Client.open(backing.server.port, 'a'),
      Client.open(backing.server.port, 'a'),
      Client.open(backing.server.port, 'b'),
    ]);
    const inA = await a1.join('Ada');
    await a2.join('Al');
    await a1.next();
    await b1.join('Bo');
    // `silent` never sends anything. It is a connection of A all the same.
    await settled(a1);
    return { ...backing, a, b, a1, a2, silent, b1, inA };
  }

  it('closes every connection of that session, and none of any other', async () => {
    const { server, inner, a, b, a1, a2, silent, b1 } = await twoSessions();
    unwrap(await a.shutdown());

    for (const client of [a1, a2, silent]) {
      expect(await client.next()).toEqual(SESSION_CLOSED);
      await client.closed;
    }
    await until(() => server.socketCount() === 1);
    expect(server.registry.get('a')).toBeUndefined();
    expect(server.registry.get('b')).toBe(b);
    const stored = unwrap(await inner.load('a'));
    expect(stored?.state.players.map((player) => player.displayName)).toEqual(['Ada', 'Al']);

    // B plays on.
    b1.send(READY);
    expect((await b1.next()).type).toBe('update');
    expect(b.room.connectionCount()).toBe(1);
    expect(b1.pending()).toBe(0);
  });

  it('accepts nothing more through the handle that was unloaded', async () => {
    const { a } = await twoSessions();
    await a.close();
    const before = a.session.getState();

    // Trusted code still holding the old room gets nowhere with it.
    const late = connection();
    send(a.room, late, { type: 'join', joinCode: CODE, displayName: 'Late' });
    send(a.room, late, { type: 'host_auth', token: a.hostToken });
    expect(late.take()).toEqual([SESSION_CLOSED, SESSION_CLOSED]);
    expect(late.closed).toBe(true);
    expect(a.room.tick(at(10_000_000)).ok).toBe(true);
    expect(a.session.getState()).toBe(before);
    expect(codeOf(await a.save())).toBe('STORAGE_ERROR');
  });

  it('serves the session again from the store, with nothing of the old room', async () => {
    const { server, calls, a, inA } = await twoSessions();
    unwrap(await a.shutdown());
    const loads = calls.load;

    const back = await Client.open(server.port, 'a');
    back.send({ type: 'resume', token: inA.token });
    expect(await back.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });
    back.send({ type: 'host_auth', token: a.hostToken });
    expect(await back.next()).toEqual({ type: 'error', code: 'INVALID_TOKEN' });

    const reloaded = server.registry.get('a');
    expect(reloaded).toBeDefined();
    expect(reloaded).not.toBe(a);
    expect(reloaded?.room).not.toBe(a.room);
    expect(calls.load).toBe(loads + 1);
    expect(names(reloaded as SessionHandle)).toEqual(['Ada', 'Al']);
    expect(a.room.connectionCount()).toBe(0);
  });

  it('waits for the final save before a new connection loads it again', async () => {
    const { server, calls, held, hold, release, a } = await twoSessions();
    hold('save');
    const stopping = a.shutdown();
    await until(() => held.length === 1);
    const loads = calls.load;

    const back = await Client.open(server.port, 'a');
    back.send({ type: 'join', joinCode: CODE, displayName: 'Cy' });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Neither loaded nor read yet: the session is still being saved.
    expect(calls.load).toBe(loads);
    expect(back.pending()).toBe(0);

    release('save');
    held[0]?.finish();
    unwrap(await stopping);
    expect((await back.next()).type).toBe('joined');
    expect(names(server.registry.get('a') as SessionHandle)).toEqual(['Ada', 'Al', 'Cy']);
  });

  it('refuses a connection to a session that was unloaded and deleted', async () => {
    const { server, a, a1, b1 } = await twoSessions();
    // Deleting it while it is loaded is refused, and its connections are untouched.
    expect(codeOf(await server.registry.delete('a'))).toBe('SESSION_LOADED');
    await settled(a1);
    expect(a.room.connectionCount()).toBe(2);

    await a.close();
    unwrap(await server.registry.delete('a'));
    const client = await Client.open(server.port, 'a');
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_NOT_FOUND' });
    await client.closed;
    expect(server.registry.get('a')).toBeUndefined();

    b1.send(READY);
    expect((await b1.next()).type).toBe('update');
  });
});

describe('shutting the server down', () => {
  it('closes every connection of every session, saves what changed, and closes the store', async () => {
    const { server, inner, calls, events, create } = await start();
    const a = await create('a');
    await create('b');
    await create('clean');
    const [a1, a2, b1, idle] = await Promise.all([
      Client.open(server.port, 'a'),
      Client.open(server.port, 'a'),
      Client.open(server.port, 'b'),
      Client.open(server.port, 'clean'),
    ]);
    await a1.join('Ada');
    await a2.join('Al');
    await a1.next();
    await b1.join('Bo');
    await settled(idle);
    events.length = 0;

    expect(await server.shutdown()).toEqual({ ok: true, value: undefined });
    for (const client of [a1, a2, b1, idle]) {
      expect(await client.next()).toEqual(SESSION_CLOSED);
      await client.closed;
    }
    expect(server.socketCount()).toBe(0);
    expect(a.room.isClosed()).toBe(true);
    expect(events).toEqual(expect.arrayContaining(['save:a:end', 'save:b:end']));
    expect(events).not.toContain('save:clean:end');
    expect(events.at(-1)).toBe('store.close');
    expect(calls.close).toBe(1);
    const stored = unwrap(await inner.load('a'));
    expect(stored?.state.players.map((player) => player.displayName)).toEqual(['Ada', 'Al']);
    for (const id of ['a', 'b', 'clean']) expect(server.registry.get(id)).toBeUndefined();

    // The port is free: nothing is listening any more.
    await expect(Client.open(server.port, 'a')).rejects.toBeDefined();
  });

  it('refuses a connection that arrives while it is stopping', async () => {
    const { server, inner, calls, held, hold, release, create } = await start();
    unwrap(await createPersistentSessions(inner).create(createCommand('stored'), at(0)));
    await create('a');
    const client = await Client.open(server.port, 'a');
    await client.join('Ada');
    hold('save');
    const stopping = server.shutdown();
    await until(() => held.length === 1);
    expect(await client.next()).toEqual(SESSION_CLOSED);
    const loads = calls.load;

    // To the session being saved, and to one that is only stored.
    for (const id of ['a', 'stored']) {
      const late = await Client.open(server.port, id);
      late.send({ type: 'join', joinCode: CODE, displayName: 'Late' });
      expect(await late.next()).toEqual(SESSION_CLOSED);
      await late.closed;
    }
    expect(calls.load).toBe(loads);
    expect(server.registry.get('stored')).toBeUndefined();

    release('save');
    held[0]?.finish();
    unwrap(await stopping);
    const stored = unwrap(await inner.load('a'));
    expect(stored?.state.players.map((player) => player.displayName)).toEqual(['Ada']);
  });

  it('includes a session that a connection was still loading', async () => {
    const { server, inner, events, held, hold, release } = await start();
    unwrap(await createPersistentSessions(inner).create(createCommand('stored'), at(0)));
    hold('load');
    const client = await Client.open(server.port, 'stored');
    await until(() => held.length === 1);
    const stopping = server.shutdown();
    release('load');
    held[0]?.finish();

    unwrap(await stopping);
    expect(await client.next()).toEqual(SESSION_CLOSED);
    await client.closed;
    expect(events.at(-1)).toBe('store.close');
    expect(server.registry.get('stored')).toBeUndefined();
    expect(server.socketCount()).toBe(0);
  });

  it('reports a session that could not be saved, and still stops everything', async () => {
    const { server, inner, calls, failing, create } = await start();
    await create('a');
    await create('b');
    const inA = await Client.open(server.port, 'a');
    const inB = await Client.open(server.port, 'b');
    await inA.join('Ada');
    await inB.join('Bo');
    failing.save.add('a');

    const result = await server.shutdown();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.failures.map((failure) => failure.sessionId)).toEqual(['a']);
    expect(result.error.storeClosed).toBe(true);
    await Promise.all([inA.closed, inB.closed]);
    expect(calls.close).toBe(1);
    const stored = unwrap(await inner.load('b'));
    expect(stored?.state.players.map((player) => player.displayName)).toEqual(['Bo']);
    expect(server.socketCount()).toBe(0);
  });

  it('runs once however often it is called', async () => {
    const { server, calls, create } = await start();
    await create('a');
    const first = server.shutdown();
    expect(server.shutdown()).toBe(first);
    unwrap(await first);
    expect(server.shutdown()).toBe(first);
    expect(calls.close).toBe(1);
  });

  it('closes the connections when the registry is shut down directly', async () => {
    const { server, create } = await start();
    await create('a');
    const client = await Client.open(server.port, 'a');
    await client.join('Ada');
    unwrap(await server.registry.shutdown());
    expect(await client.next()).toEqual(SESSION_CLOSED);
    await client.closed;
    // The listener is still up, and turns everyone away.
    const late = await Client.open(server.port, 'a');
    expect(await late.next()).toEqual(SESSION_CLOSED);
    await late.closed;
  });
});

describe('starting', () => {
  it('reports a port that cannot be bound and leaves the store open', async () => {
    const { server, calls, store } = await start();
    const second = await startSessionServer({ store, port: server.port });
    expect(codeOf(second)).toBe('SERVER_NOT_STARTED');
    expect(calls.close).toBe(0);
  });

  it('leaves the single-game server as it was: no address is needed there', async () => {
    const { startPersistentServer } = await import('./persistent-server');
    const single = unwrap(
      await startPersistentServer({
        store: new InMemorySessionStore(),
        port: 0,
        clock: testClock(),
        game: { create: createCommand('solo') },
      }),
    );
    try {
      for (const path of ['', '/sessions/other', '/anything']) {
        const client = await Client.at(single.port, path);
        expect((await client.join(`Player ${path}`)).sessionId).toBe('solo');
      }
    } finally {
      await single.close();
    }
  });
});

describe('the session server stays a thin layer', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(joinPath(directory, 'session-server.ts'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    '',
  );

  it('gets every handle from the registry and makes none', () => {
    expect(code).not.toMatch(/createSessionHandle|hostSession|createRoom|createGameSession/);
    expect(code).not.toMatch(/restoreGameSession|loadSession|saveSession|createPersistentSessions/);
    expect(code.match(/createSessionRegistry\(/g)).toHaveLength(1);
    expect(code).toContain('registry.get(sessionId)');
    expect(code).toContain('await registry.load(sessionId)');
  });

  it('opens one listener, keeps no table, and touches no game', () => {
    expect(code.match(/createRoutedRealtimeServer\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/createRealtimeServer\(|WebSocketServer/);
    expect(code).not.toMatch(/new Map|new Set|new WeakMap/);
    expect(code).not.toMatch(/getState|applyCommand|submitAction|advanceTime|\.receive\(|\.tick\(/);
    expect(code).not.toMatch(/setTimeout|setInterval|retry|redis/i);
  });

  it('uses the store only to make the registry', () => {
    expect(code.match(/\bstore\b/g)).toEqual(['store', 'store', 'store']);
    expect(code).toContain('store: options.store,');
  });
});
