import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@touchgrass/session-store';
import type { SessionHandle } from './session-handle';
import { type SessionServer, startSessionServer } from './session-server';
import {
  Client,
  type Message,
  READY,
  SESSION_CLOSED,
  heldStore,
  settled,
  until,
} from './socket-test-support';
import { CODE, at, codeOf, createCommand, testClock, unwrap } from './test-support';

/**
 * Reconnecting, over real sockets, to a real session server.
 *
 * The key the player tokens are made from is fixed here so that two servers in
 * one test can share it. It protects nothing.
 */

const KEY = new Uint8Array(32).fill(7);
const INVALID_TOKEN = { type: 'error', code: 'INVALID_TOKEN' };
const NOT_JOINED = { type: 'error', code: 'NOT_JOINED' };

let running: SessionServer[] = [];

async function start(backing = heldStore(), tokenKey: Uint8Array | null = KEY) {
  let minted = 0;
  const clock = testClock();
  const server = unwrap(
    await startSessionServer({
      store: backing.store,
      port: 0,
      clock,
      createToken: () => {
        minted += 1;
        return `host-token-${minted}`;
      },
      ...(tokenKey ? { tokenKey } : {}),
    }),
  );
  running.push(server);
  const create = async (sessionId: string): Promise<SessionHandle> =>
    unwrap(await server.registry.create(createCommand(sessionId), at(0)));
  const loaded = (sessionId: string): SessionHandle => {
    const handle = server.registry.get(sessionId);
    if (!handle) throw new Error(`session ${sessionId} is not loaded`);
    return handle;
  };
  return { ...backing, server, clock, create, loaded };
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.shutdown()));
  running = [];
});

/** Closes a client's socket and waits until the server has noticed. */
async function drop(client: Client, server: SessionServer): Promise<void> {
  const before = server.socketCount();
  client.socket.close();
  await client.closed;
  await until(() => server.socketCount() < before);
}

/** Connects and resumes. Returns the client and the server's reply. */
async function resume(
  server: SessionServer,
  sessionId: string,
  token: string,
): Promise<{ client: Client; reply: Message }> {
  const client = await Client.open(server.port, sessionId);
  client.send({ type: 'resume', token });
  return { client, reply: await client.next() };
}

const players = (handle: SessionHandle) => handle.session.getState().players;
const names = (handle: SessionHandle): string[] => players(handle).map((p) => p.displayName);

describe('A. reconnecting to a session that stayed loaded', () => {
  it('gives the player back the same identity, and changes nothing in the game', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);
    // The connection went. The player did not.
    expect(a.room.connectionCount()).toBe(0);
    expect(names(a)).toEqual(['Ada']);
    const untouched = a.session.getState();

    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply.type).toBe('joined');
    expect(reply.playerId).toBe(ada.playerId);
    expect(reply.token).toBeUndefined();
    expect(reply.state?.players.map((player) => player.displayName)).toEqual(['Ada']);
    expect(a.session.getState()).toBe(untouched);
    expect(a.room.connectionCount()).toBe(1);
    expect(server.registry.get('a')).toBe(a);

    // And it is the player again: it can act.
    client.send(READY);
    expect((await client.next()).type).toBe('update');
  });

  it('keeps a command that was sent just before the socket closed', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    first.send(READY);
    await drop(first, server);
    expect(players(a).map((player) => player.ready)).toEqual([true]);

    const { reply } = await resume(server, 'a', ada.token);
    expect(reply.playerId).toBe(ada.playerId);
  });

  it('works while a save of that session is still at the store', async () => {
    const { server, create, held, hold, release } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    hold('save');
    const saving = a.save();
    await until(() => held.length === 1);

    await drop(first, server);
    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply.playerId).toBe(ada.playerId);
    client.send(READY);
    expect((await client.next()).type).toBe('update');

    release('save');
    held[0]?.finish();
    unwrap(await saving);
    // What happened during the save is still unsaved, as before.
    expect(a.hasUnsavedChanges()).toBe(true);
  });
});

describe('B. reconnecting after the session was unloaded and loaded again', () => {
  it('gives the player back the same identity in a new room, from the stored game', async () => {
    const { server, create, loaded } = await start();
    const old = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    first.send(READY);
    await first.next();
    await drop(first, server);
    unwrap(await old.shutdown());
    expect(server.registry.get('a')).toBeUndefined();

    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply.type).toBe('joined');
    expect(reply.playerId).toBe(ada.playerId);
    expect(reply.token).toBeUndefined();

    const now = loaded('a');
    expect(now).not.toBe(old);
    expect(now.room).not.toBe(old.room);
    expect(now.session).not.toBe(old.session);
    expect(old.room.isClosed()).toBe(true);
    expect(now.room.connectionCount()).toBe(1);
    // Who she is came out of the store: same id, same name, still ready.
    expect(players(now)).toMatchObject([{ id: ada.playerId, displayName: 'Ada', ready: true }]);
    // Loading and resuming changed nothing, so there is nothing to save.
    expect(now.hasUnsavedChanges()).toBe(false);

    // Acting now changes the new session and not the old one.
    const frozen = old.session.getState();
    const second = await Client.open(server.port, 'a');
    await second.join('Bo');
    expect((await client.next()).type).toBe('update');
    expect(names(now)).toEqual(['Ada', 'Bo']);
    expect(old.session.getState()).toBe(frozen);
  });

  it('gives a new host token, and the old one opens nothing', async () => {
    const { server, create, loaded } = await start();
    const old = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    unwrap(await old.shutdown());
    await first.closed;

    const { client } = await resume(server, 'a', ada.token);
    client.send({ type: 'host_auth', token: old.hostToken });
    expect(await client.next()).toEqual(INVALID_TOKEN);
    expect(loaded('a').hostToken).not.toBe(old.hostToken);
  });

  it('does not bring back a player whose join was never saved', async () => {
    const { server, create, loaded } = await start();
    const old = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    // Unloaded without saving: the stored game has no Ada.
    await old.close();
    await first.closed;

    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply).toEqual(INVALID_TOKEN);
    expect(names(loaded('a'))).toEqual([]);
    client.send(READY);
    expect(await client.next()).toEqual(NOT_JOINED);
  });

  it('waits for the final save, then resumes into what it stored', async () => {
    const { server, create, loaded, calls, held, hold, release } = await start();
    const old = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    hold('save');
    const stopping = old.shutdown();
    await until(() => held.length === 1);
    const loads = calls.load;

    const back = await Client.open(server.port, 'a');
    back.send({ type: 'resume', token: ada.token });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(calls.load).toBe(loads);
    expect(back.pending()).toBe(0);

    release('save');
    held[0]?.finish();
    unwrap(await stopping);
    const reply = await back.next();
    expect([reply.type, reply.playerId]).toEqual(['joined', ada.playerId]);
    expect(names(loaded('a'))).toEqual(['Ada']);
  });
});

describe('C. a resume with a token that is not valid', () => {
  it('is refused, attaches nobody, and changes nothing', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);
    const untouched = a.session.getState();

    const client = await Client.open(server.port, 'a');
    const wrong = [
      'nonsense',
      `${ada.token}x`,
      ada.token.slice(0, -1),
      ada.token.split('').reverse().join(''),
      a.hostToken,
      ada.playerId,
    ];
    for (const token of wrong) client.send({ type: 'resume', token });
    for (const _ of wrong) expect(await client.next()).toEqual(INVALID_TOKEN);
    // A token that is not even a token is not a message.
    client.send({ type: 'resume', token: '' });
    client.send({ type: 'resume' });
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    expect(await client.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });

    expect(a.session.getState()).toBe(untouched);
    expect(a.room.connectionCount()).toBe(0);
    expect(a.hasUnsavedChanges()).toBe(true);
    client.send(READY);
    expect(await client.next()).toEqual(NOT_JOINED);
    // The connection was not closed for it, and the real token still works on it.
    client.send({ type: 'resume', token: ada.token });
    expect((await client.next()).playerId).toBe(ada.playerId);
  });
});

describe('D. a token from another session', () => {
  it('is refused at the other session, loaded or reloaded, and leaves it unchanged', async () => {
    const { server, create, loaded } = await start();
    const a = await create('a');
    const b = await create('b');
    const inA = await Client.open(server.port, 'a');
    const inB = await Client.open(server.port, 'b');
    const ada = await inA.join('Ada');
    const bo = await inB.join('Bo');
    const untouched = b.session.getState();

    const { client, reply } = await resume(server, 'b', ada.token);
    expect(reply).toEqual(INVALID_TOKEN);
    client.send(READY);
    expect(await client.next()).toEqual(NOT_JOINED);
    expect(b.session.getState()).toBe(untouched);
    expect(b.room.connectionCount()).toBe(1);
    await settled(inB);
    expect(inB.pending()).toBe(0);

    // The same after both have been through the store.
    unwrap(await a.shutdown());
    unwrap(await b.shutdown());
    expect((await resume(server, 'b', ada.token)).reply).toEqual(INVALID_TOKEN);
    expect((await resume(server, 'a', bo.token)).reply).toEqual(INVALID_TOKEN);
    expect((await resume(server, 'a', ada.token)).reply.playerId).toBe(ada.playerId);
    expect((await resume(server, 'b', bo.token)).reply.playerId).toBe(bo.playerId);
    expect(names(loaded('a'))).toEqual(['Ada']);
    expect(names(loaded('b'))).toEqual(['Bo']);
  });
});

describe('E. one player and another player’s identity', () => {
  it('makes a connection exactly the player its token is for, before and after a reload', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const [one, two] = await Promise.all([
      Client.open(server.port, 'a'),
      Client.open(server.port, 'a'),
    ]);
    const ada = await one.join('Ada');
    const al = await two.join('Al');
    expect(ada.token).not.toBe(al.token);
    expect(ada.playerId).not.toBe(al.playerId);

    for (const round of ['loaded', 'reloaded']) {
      if (round === 'reloaded') unwrap(await a.shutdown());
      const asAl = await resume(server, 'a', al.token);
      expect(asAl.reply.playerId, round).toBe(al.playerId);
      // Already Al, it cannot also become Ada, even with her token.
      asAl.client.send({ type: 'resume', token: ada.token });
      expect(await asAl.client.next()).toEqual({ type: 'error', code: 'ALREADY_JOINED' });
    }
  });

  it('cannot be reached by knowing the other player’s id', async () => {
    const { server, create } = await start();
    await create('a');
    const one = await Client.open(server.port, 'a');
    const two = await Client.open(server.port, 'a');
    const ada = await one.join('Ada');
    const al = await two.join('Al');
    // Everyone is told every player id. None of them is a token, or part of one.
    const heard = one.raw.concat(two.raw).join('');
    expect(heard).toContain(al.playerId);
    expect(heard.split(al.token)).toHaveLength(2);
    expect(heard.split(ada.token)).toHaveLength(2);
    expect((await resume(server, 'a', al.playerId)).reply).toEqual(INVALID_TOKEN);
  });
});

describe('F. resuming as a player who is still connected', () => {
  it('takes the player over: the old socket is told and closed, the new one is the player', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const old = await Client.open(server.port, 'a');
    const other = await Client.open(server.port, 'a');
    const ada = await old.join('Ada');
    await other.join('Bo');
    await old.next();
    const untouched = a.session.getState();

    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply.playerId).toBe(ada.playerId);
    expect(await old.next()).toEqual({ type: 'error', code: 'CONNECTION_REPLACED' });
    await old.closed;
    await until(() => server.socketCount() === 2);
    expect(a.room.connectionCount()).toBe(2);
    expect(a.session.getState()).toBe(untouched);

    // One connection is the player. It acts, and the old one hears nothing more.
    client.send(READY);
    expect((await client.next()).type).toBe('update');
    expect((await other.next()).type).toBe('update');
    expect(old.pending()).toBe(0);
    expect(players(a).map((player) => player.ready)).toEqual([true, false]);
  });

  it('settles two resumes that arrive together: one socket is the player, the other is closed', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);

    const [one, two] = await Promise.all([
      Client.open(server.port, 'a'),
      Client.open(server.port, 'a'),
    ]);
    one.send({ type: 'resume', token: ada.token });
    two.send({ type: 'resume', token: ada.token });
    const replies = [await one.next(), await two.next()];
    expect(replies.map((reply) => reply.playerId)).toEqual([ada.playerId, ada.playerId]);

    // Whichever the server handled first was replaced by the other.
    await until(() => server.socketCount() === 1);
    expect(a.room.connectionCount()).toBe(1);
    const [loser, winner] = one.socket.readyState === WebSocket.OPEN ? [two, one] : [one, two];
    expect(await loser.next()).toEqual({ type: 'error', code: 'CONNECTION_REPLACED' });
    await loser.closed;
    winner.send(READY);
    expect((await winner.next()).type).toBe('update');
  });
});

describe('G. other players in the session', () => {
  it('are not disturbed by one player dropping and coming back', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const one = await Client.open(server.port, 'a');
    const two = await Client.open(server.port, 'a');
    const ada = await one.join('Ada');
    const bo = await two.join('Bo');
    await one.next();

    await drop(one, server);
    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply.playerId).toBe(ada.playerId);
    // Nothing changed in the game, so Bo was told nothing and is still Bo.
    await settled(two);
    expect(two.pending()).toBe(0);
    expect(a.room.connectionCount()).toBe(2);

    two.send(READY);
    expect((await two.next()).type).toBe('update');
    expect((await client.next()).type).toBe('update');
    expect(players(a).find((player) => player.id === bo.playerId)?.ready).toBe(true);
  });
});

describe('H. other sessions', () => {
  it('are not disturbed by a player of one session dropping, its reload, and their return', async () => {
    const { server, create, calls } = await start();
    const one = await create('one');
    const two = await create('two');
    const inOne = await Client.open(server.port, 'one');
    const inTwo = await Client.open(server.port, 'two');
    const ada = await inOne.join('Ada');
    await inTwo.join('Bo');
    const untouched = two.session.getState();
    const loads = calls.load;

    await drop(inOne, server);
    unwrap(await one.shutdown());
    const { reply } = await resume(server, 'one', ada.token);
    expect(reply.playerId).toBe(ada.playerId);

    expect(server.registry.get('two')).toBe(two);
    expect(two.session.getState()).toBe(untouched);
    expect(two.room.connectionCount()).toBe(1);
    expect(two.room.isClosed()).toBe(false);
    await settled(inTwo);
    expect(inTwo.pending()).toBe(0);
    // Only session one was read from the store.
    expect(calls.load).toBe(loads + 1);
    inTwo.send(READY);
    expect((await inTwo.next()).type).toBe('update');
  });
});

describe('I. several connections returning to an unloaded session at once', () => {
  it('load it once, and all resume into the one room', async () => {
    const { server, create, loaded, calls, held, hold, release } = await start();
    const old = await create('a');
    const firsts = await Promise.all([1, 2, 3].map(() => Client.open(server.port, 'a')));
    const joined = [];
    for (const [index, client] of firsts.entries()) joined.push(await client.join(`P${index}`));
    unwrap(await old.shutdown());
    await Promise.all(firsts.map((client) => client.closed));
    const loads = calls.load;

    hold('load');
    const back = await Promise.all([1, 2, 3].map(() => Client.open(server.port, 'a')));
    for (const [index, client] of back.entries()) {
      client.send({ type: 'resume', token: joined[index]?.token });
    }
    await until(() => held.length === 1);
    expect(server.registry.get('a')).toBeUndefined();

    release('load');
    held[0]?.finish();
    const replies = await Promise.all(back.map((client) => client.next()));
    expect(replies.map((reply) => reply.playerId)).toEqual(joined.map((player) => player.playerId));
    expect(calls.load).toBe(loads + 1);
    expect(held).toEqual([]);
    const now = loaded('a');
    expect(now.room.connectionCount()).toBe(3);

    // One room: what one of them does, all of them hear.
    back[0]?.send(READY);
    for (const client of back) expect((await client.next()).type).toBe('update');
  });
});

describe('J. reconnecting to a session that was deleted', () => {
  it('is refused at the door, before any token is read', async () => {
    const { server, create, calls } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);
    unwrap(await a.shutdown());
    unwrap(await server.registry.delete('a'));

    const client = await Client.open(server.port, 'a');
    client.send({ type: 'resume', token: ada.token });
    expect(await client.next()).toEqual({ type: 'error', code: 'SESSION_NOT_FOUND' });
    await client.closed;
    expect(client.pending()).toBe(0);
    expect(server.registry.get('a')).toBeUndefined();
    await until(() => server.socketCount() === 0);
    // Nothing was written back.
    expect(calls.save).toBe(2);
  });

  it('does not let the old token into a new session made under the same id', async () => {
    const { server, create, loaded } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    unwrap(await a.shutdown());
    unwrap(await server.registry.delete('a'));
    await create('a');

    // The new game has no such player, so there is nobody for the token to be.
    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply).toEqual(INVALID_TOKEN);
    expect(names(loaded('a'))).toEqual([]);
    expect((await client.join('Someone else')).playerId).not.toBe(ada.playerId);
  });
});

describe('K. reconnecting while something is shutting down', () => {
  it('is refused while the server is stopping, and nothing is left attached', async () => {
    const { server, create, calls, held, hold, release } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);
    hold('save');
    const stopping = server.shutdown();
    await until(() => held.length === 1);
    const loads = calls.load;

    const late = await Client.open(server.port, 'a');
    late.send({ type: 'resume', token: ada.token });
    expect(await late.next()).toEqual(SESSION_CLOSED);
    await late.closed;
    expect(late.pending()).toBe(0);
    expect(a.room.connectionCount()).toBe(0);
    expect(calls.load).toBe(loads);

    release('save');
    held[0]?.finish();
    unwrap(await stopping);
    expect(server.socketCount()).toBe(0);
  });

  it('is closed with the rest when the session is unloaded right after the resume', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);

    const { client, reply } = await resume(server, 'a', ada.token);
    expect(reply.playerId).toBe(ada.playerId);
    unwrap(await a.shutdown());
    expect(await client.next()).toEqual(SESSION_CLOSED);
    await client.closed;
    await until(() => server.socketCount() === 0);
    expect(a.room.connectionCount()).toBe(0);
    expect(a.room.playerIdOf).toBeDefined();
    expect(server.registry.get('a')).toBeUndefined();
  });

  it('leaves nothing behind when the socket closes right after the resume', async () => {
    const { server, create } = await start();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);

    const client = await Client.open(server.port, 'a');
    client.send({ type: 'resume', token: ada.token });
    client.socket.close();
    await client.closed;
    await until(() => server.socketCount() === 0);
    expect(a.room.connectionCount()).toBe(0);
    // She can still come back.
    expect((await resume(server, 'a', ada.token)).reply.playerId).toBe(ada.playerId);
  });
});

describe('L. what a returning player finds', () => {
  it('is the game as it was saved: roles, the round, and the score they had earned', async () => {
    const { server, clock, create, loaded } = await start();
    const old = await create('a');
    const clients = await Promise.all([1, 2, 3].map(() => Client.open(server.port, 'a')));
    const joined = [];
    for (const [index, client] of clients.entries()) joined.push(await client.join(`P${index}`));
    clock.set(1_000);
    for (const client of clients) client.send(READY);
    await until(() => old.session.getState().status === 'active');

    // The tagger tags a runner, which scores.
    const tagger = players(old).find((player) => player.roleId === 'tagger');
    const runner = players(old).find((player) => player.roleId === 'runner');
    if (!tagger || !runner) throw new Error('fixture failed');
    const taggerIndex = joined.findIndex((player) => player.playerId === tagger.id);
    clock.set(6_000);
    clients[taggerIndex]?.send({
      type: 'action',
      intent: { type: 'PLAYER_TAGGED', targetPlayerId: runner.id },
    });
    await until(() => players(old).some((player) => player.score > 0));
    const saved = old.session.getState();

    unwrap(await old.shutdown());
    await Promise.all(clients.map((client) => client.closed));

    const { reply } = await resume(server, 'a', joined[taggerIndex]?.token ?? '');
    expect(reply.playerId).toBe(tagger.id);
    const now = loaded('a');
    expect(now.session).not.toBe(old.session);
    expect(now.session.getState()).toEqual(saved);
    expect(now.session.getState().status).toBe('active');
    const me = players(now).find((player) => player.id === tagger.id);
    const before = saved.players.find((player) => player.id === tagger.id);
    expect(me).toEqual(before);
    expect(me?.score).toBeGreaterThan(0);
  });
});

describe('the key the tokens are made from', () => {
  it('lets a player return to another server that has the same key and the same store', async () => {
    const inner = new InMemorySessionStore();
    const first = await start(heldStore(inner));
    await first.create('a');
    const client = await Client.open(first.server.port, 'a');
    const ada = await client.join('Ada');
    unwrap(await first.server.shutdown());

    const second = await start(heldStore(inner));
    const { reply } = await resume(second.server, 'a', ada.token);
    expect(reply.playerId).toBe(ada.playerId);
  });

  it('is new for each server unless one is given, so a token does not outlive its server', async () => {
    const inner = new InMemorySessionStore();
    const first = await start(heldStore(inner), null);
    const old = await first.create('a');
    const client = await Client.open(first.server.port, 'a');
    const ada = await client.join('Ada');
    // Within that server it survives a reload.
    unwrap(await old.shutdown());
    expect((await resume(first.server, 'a', ada.token)).reply.playerId).toBe(ada.playerId);
    unwrap(await first.server.shutdown());

    const second = await start(heldStore(inner), null);
    expect((await resume(second.server, 'a', ada.token)).reply).toEqual(INVALID_TOKEN);
    expect(names(second.loaded('a'))).toEqual(['Ada']);
  });

  it('stores nothing: no token is in the game, a snapshot, or anything a client is sent later', async () => {
    const { server, create, inner } = await start();
    const a = await create('a');
    const one = await Client.open(server.port, 'a');
    const two = await Client.open(server.port, 'a');
    const ada = await one.join('Ada');
    const bo = await two.join('Bo');
    await one.next();
    unwrap(await a.save());

    const stored = JSON.stringify(unwrap(await inner.load('a')));
    for (const token of [ada.token, bo.token, a.hostToken]) {
      expect(stored.includes(token)).toBe(false);
      expect(JSON.stringify(a.session.getState()).includes(token)).toBe(false);
    }
    // Each token was sent once, to its own player, in the reply to the join.
    expect(one.raw.join('').split(ada.token)).toHaveLength(2);
    expect(one.raw.join('').includes(bo.token)).toBe(false);
    expect(two.raw.join('').includes(ada.token)).toBe(false);
    expect(codeOf(await server.registry.delete('a'))).toBe('SESSION_LOADED');
  });
});

describe('a player who has left for good', () => {
  it('cannot resume, loaded or reloaded', async () => {
    const { server, create, loaded } = await start();
    const a = await create('a');
    const client = await Client.open(server.port, 'a');
    const ada = await client.join('Ada');
    client.send({ type: 'leave' });
    expect((await client.next()).type).toBe('update');

    expect((await resume(server, 'a', ada.token)).reply).toEqual(INVALID_TOKEN);
    unwrap(await a.shutdown());
    expect((await resume(server, 'a', ada.token)).reply).toEqual(INVALID_TOKEN);
    expect(players(loaded('a')).map((player) => player.status)).toEqual(['left']);
    expect(CODE).toBe(loaded('a').session.getState().joinCode);
  });
});
