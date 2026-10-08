import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore } from '@touchgrass/session-store';
import { DEFAULT_SESSION_SWEEP_MS, parseLifecycleConfig } from './config';
import type { SessionHandle } from './session-handle';
import {
  DEFAULT_FINISHED_IDLE_MS,
  DEFAULT_SESSION_IDLE_MS,
  type SessionLifecycleEvent,
  createSessionRegistry,
} from './session-registry';
import { type SessionServer, startSessionServer } from './session-server';
import { Client, READY, heldStore, settled, until } from './socket-test-support';
import {
  CODE,
  type TestConnection,
  at,
  codeOf,
  connection,
  createCommand,
  join,
  send,
  testClock,
  unwrap,
} from './test-support';

/**
 * The session lifecycle: idle, finished, evicted, loaded again.
 *
 * The clock is a test clock that only moves when a test moves it, and the
 * store's calls can be held, so nothing here depends on how long anything takes.
 */

const IDLE = 10_000;
const FINISHED_IDLE = 2_000;
const KEY = new Uint8Array(32).fill(7);
const SESSION_CLOSED = { type: 'error', code: 'SESSION_CLOSED' };

function setup(backing = heldStore(), policy: { idleMs?: number; finishedIdleMs?: number } = {}) {
  const clock = testClock();
  const events: SessionLifecycleEvent[] = [];
  const registry = createSessionRegistry({
    store: backing.store,
    clock,
    tokenKey: KEY,
    idleMs: IDLE,
    finishedIdleMs: FINISHED_IDLE,
    ...policy,
    onEvent: (event) => events.push(event),
  });
  const create = async (sessionId: string): Promise<SessionHandle> =>
    unwrap(await registry.create(createCommand(sessionId), at(0)));
  const stateOf = (sessionId: string) =>
    registry.sessions().find((info) => info.sessionId === sessionId)?.state;
  const kinds = (sessionId: string) =>
    events.filter((event) => event.sessionId === sessionId).map((event) => event.type);
  return { ...backing, registry, clock, events, create, stateOf, kinds };
}

/** A player joins through the room and then drops, leaving the game changed. */
function visit(handle: SessionHandle, name = 'Ada') {
  const who = connection();
  const joined = join(handle.room, who, name);
  handle.room.disconnect(who);
  return { who, ...joined };
}

const stored = async (inner: InMemorySessionStore, sessionId: string): Promise<string[] | null> => {
  const snapshot = unwrap(await inner.load(sessionId));
  return snapshot ? snapshot.state.players.map((player) => player.displayName) : null;
};

describe('A. a session becoming idle', () => {
  it('is idle with no connections, active with one, and idle again when the last goes', async () => {
    const { registry, clock, create, stateOf, kinds } = await Promise.resolve(setup());
    const a = await create('a');
    expect(registry.sessions()).toEqual([
      { sessionId: 'a', state: 'idle', connections: 0, lastActiveAt: clock.now() },
    ]);

    clock.set(1_000);
    const [one, two] = [connection(), connection()];
    join(a.room, one, 'Ada');
    expect(stateOf('a')).toBe('active');
    a.room.attach(two);
    expect(registry.sessions()[0]).toMatchObject({ state: 'active', connections: 2 });

    clock.set(4_000);
    a.room.disconnect(one);
    expect(stateOf('a')).toBe('active');
    expect(kinds('a')).toEqual(['created']);
    clock.set(5_000);
    a.room.disconnect(two);
    expect(registry.sessions()).toEqual([
      { sessionId: 'a', state: 'idle', connections: 0, lastActiveAt: clock.now() },
    ]);
    expect(kinds('a')).toEqual(['created', 'idle']);
  });

  it('counts a connection that has not joined, and the host', async () => {
    const { create, stateOf } = setup();
    const a = await create('a');
    const [silent, host] = [connection(), connection()];
    a.room.attach(silent);
    expect(stateOf('a')).toBe('active');
    a.room.disconnect(silent);
    send(a.room, host, { type: 'host_auth', token: a.hostToken });
    expect(stateOf('a')).toBe('active');
    a.room.disconnect(host);
    expect(stateOf('a')).toBe('idle');
  });

  it('lists only what is in memory, and nothing of a game', async () => {
    const { registry, inner, create } = setup();
    const a = await create('a');
    visit(a);
    unwrap(await registry.evict('a'));
    expect(registry.sessions()).toEqual([]);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
    await create('b');
    expect(Object.keys(registry.sessions()[0] ?? {}).sort()).toEqual([
      'connections',
      'lastActiveAt',
      'sessionId',
      'state',
    ]);
  });
});

describe('B. a session that is in use', () => {
  it('is never evicted while it has a connection, however long that lasts', async () => {
    const { registry, clock, calls, create } = setup();
    const a = await create('a');
    const who = connection();
    join(a.room, who, 'Ada');
    const saves = calls.save;
    clock.set(100 * IDLE);

    expect(await registry.evictIdle()).toEqual({ evicted: [], failed: [] });
    expect(codeOf(await registry.evict('a'))).toBe('SESSION_IN_USE');
    expect(registry.get('a')).toBe(a);
    expect(a.room.isClosed()).toBe(false);
    expect(who.closed).toBe(false);
    // Refusing saved nothing and closed nothing.
    expect(calls.save).toBe(saves);
    send(a.room, who, READY, 500);
    expect(who.inbox.at(-1)?.type).toBe('update');
  });

  it('is not evicted until it has been unused for the whole idle time', async () => {
    const { registry, clock, create } = setup();
    const a = await create('a');
    clock.set(50_000);
    visit(a);

    clock.set(50_000 + IDLE - 1);
    expect((await registry.evictIdle()).evicted).toEqual([]);
    expect(registry.get('a')).toBe(a);
    clock.set(50_000 + IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
    expect(registry.get('a')).toBeUndefined();
  });

  it('counts the idle time from the last connection, not the first', async () => {
    const { registry, clock, create } = setup();
    const a = await create('a');
    clock.set(8_000);
    const who = connection();
    a.room.attach(who);
    clock.set(9_000);
    a.room.disconnect(who);

    clock.set(IDLE + 5_000);
    expect((await registry.evictIdle()).evicted).toEqual([]);
    clock.set(9_000 + IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
  });

  it('does not count what trusted code does as use', async () => {
    const { registry, inner, clock, create } = setup();
    const a = await create('a');
    clock.set(IDLE - 1);
    // A save, a tick and a direct command: none of them is a connection.
    unwrap(
      a.session.applyCommand({ type: 'ADD_PLAYER', playerId: 'p1', displayName: 'Ada' }, at(10)),
    );
    unwrap(await a.save());
    a.room.tick(at(20));
    clock.set(IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
  });
});

describe('C. an idle session being evicted', () => {
  it('leaves memory and stays in the store', async () => {
    const { registry, inner, clock, calls, create, kinds } = setup();
    const a = await create('a');
    clock.set(IDLE);

    expect(await registry.evictIdle()).toEqual({ evicted: ['a'], failed: [] });
    expect(registry.get('a')).toBeUndefined();
    expect(registry.sessions()).toEqual([]);
    expect(a.room.isClosed()).toBe(true);
    expect(await stored(inner, 'a')).toEqual([]);
    expect(calls.delete).toBe(0);
    expect(kinds('a')).toEqual(['created', 'eviction_started', 'unloaded', 'evicted']);
    // The next sweep has nothing to do.
    expect(await registry.evictIdle()).toEqual({ evicted: [], failed: [] });
  });

  it('can be asked for directly, whatever the idle time', async () => {
    const { registry, create } = setup();
    await create('a');
    unwrap(await registry.evict('a'));
    expect(registry.get('a')).toBeUndefined();
  });

  it('uses the defaults when no policy is given, from one place', async () => {
    const clock = testClock();
    const registry = createSessionRegistry({ store: new InMemorySessionStore(), clock });
    unwrap(await registry.create(createCommand('a'), at(0)));
    clock.set(DEFAULT_SESSION_IDLE_MS - 1);
    expect((await registry.evictIdle()).evicted).toEqual([]);
    clock.set(DEFAULT_SESSION_IDLE_MS);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
    expect(DEFAULT_SESSION_IDLE_MS).toBe(30 * 60_000);
    expect(DEFAULT_FINISHED_IDLE_MS).toBe(0);
  });
});

describe('D. a session whose game is over', () => {
  const abort = { type: 'ABORT_SESSION', reason: 'rain' } as const;

  it('is finished by the engine’s own terminal status, and stays loaded while connected', async () => {
    const { registry, clock, create, stateOf } = setup();
    const a = await create('a');
    const who = connection();
    join(a.room, who, 'Ada');
    expect(a.isFinished()).toBe(false);
    unwrap(a.session.applyCommand(abort, at(100)));
    expect(a.isFinished()).toBe(true);
    expect(stateOf('a')).toBe('finished');

    clock.set(100 * IDLE);
    expect((await registry.evictIdle()).evicted).toEqual([]);
    expect(registry.get('a')).toBe(a);
  });

  it('is evicted after its own, shorter, idle time, and not deleted', async () => {
    const { registry, inner, clock, create } = setup();
    const over = await create('over');
    const running = await create('running');
    visit(over);
    visit(running, 'Bo');
    unwrap(over.session.applyCommand(abort, at(100)));

    clock.set(FINISHED_IDLE - 1);
    expect((await registry.evictIdle()).evicted).toEqual([]);
    clock.set(FINISHED_IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['over']);
    expect(registry.get('running')).toBe(running);

    // It is still there to be loaded, exactly as it ended.
    expect(await stored(inner, 'over')).toEqual(['Ada']);
    const again = unwrap(await registry.load('over'));
    expect(again.session.getState().status).toBe('aborted');
    expect(again.isFinished()).toBe(true);
  });

  it('is evicted at the next sweep by default, once nobody is connected', async () => {
    const { registry, create } = setup(heldStore(), { finishedIdleMs: DEFAULT_FINISHED_IDLE_MS });
    const a = await create('a');
    const who = connection();
    join(a.room, who, 'Ada');
    unwrap(a.session.applyCommand(abort, at(100)));
    expect((await registry.evictIdle()).evicted).toEqual([]);
    a.room.disconnect(who);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
  });
});

describe('E. unsaved changes and eviction', () => {
  it('saves a changed session before releasing it', async () => {
    const { registry, inner, events, calls, create } = setup();
    const a = await create('a');
    visit(a);
    expect(a.hasUnsavedChanges()).toBe(true);
    const saves = calls.save;
    events.length = 0;

    unwrap(await registry.evict('a'));
    expect(calls.save).toBe(saves + 1);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
    expect(a.hasUnsavedChanges()).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['eviction_started', 'unloaded', 'evicted']);
  });

  it('does not write a session that has nothing unsaved', async () => {
    const { registry, calls, create } = setup();
    await create('a');
    const saves = calls.save;
    unwrap(await registry.evict('a'));
    expect(calls.save).toBe(saves);
  });

  it('keeps the session reachable until the save is stored', async () => {
    const { registry, held, hold, create, stateOf } = setup();
    const a = await create('a');
    visit(a);
    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);
    expect(registry.get('a')).toBe(a);
    expect(a.room.isClosed()).toBe(false);
    expect(stateOf('a')).toBe('closing');

    held[0]?.finish();
    unwrap(await evicting);
    expect(registry.get('a')).toBeUndefined();
    expect(a.room.isClosed()).toBe(true);
  });
});

describe('F. a save that fails during eviction', () => {
  it('leaves the session loaded, usable and unsaved, and says why', async () => {
    const { registry, inner, clock, failing, create, kinds, stateOf } = setup();
    const a = await create('a');
    visit(a);
    failing.save.add('a');
    clock.set(IDLE);

    const swept = await registry.evictIdle();
    expect(swept.evicted).toEqual([]);
    expect(swept.failed.map((failure) => [failure.sessionId, failure.error.code])).toEqual([
      ['a', 'STORAGE_ERROR'],
    ]);
    expect(codeOf(await registry.evict('a'))).toBe('STORAGE_ERROR');

    // Nothing was thrown away and nothing was closed.
    expect(registry.get('a')).toBe(a);
    expect(a.room.isClosed()).toBe(false);
    expect(a.hasUnsavedChanges()).toBe(true);
    expect(stateOf('a')).toBe('idle');
    expect(await stored(inner, 'a')).toEqual([]);
    expect(kinds('a').filter((type) => type === 'eviction_failed')).toHaveLength(2);
    expect(kinds('a')).not.toContain('evicted');
    expect(kinds('a')).not.toContain('unloaded');

    // It still takes players, and is evicted once the store is back.
    const back = connection();
    join(a.room, back, 'Bo');
    a.room.disconnect(back);
    failing.save.clear();
    clock.set(3 * IDLE);
    expect(await registry.evictIdle()).toEqual({ evicted: ['a'], failed: [] });
    expect(await stored(inner, 'a')).toEqual(['Ada', 'Bo']);
  });

  it('names the error code and nothing else from the store', async () => {
    const { registry, events, failing, create } = setup();
    const a = await create('a');
    visit(a);
    failing.save.add('a');
    await registry.evict('a');
    const failure = events.find((event) => event.type === 'eviction_failed');
    expect(failure).toEqual({
      type: 'eviction_failed',
      sessionId: 'a',
      at: expect.any(Number) as number,
      code: 'STORAGE_ERROR',
    });
    expect(JSON.stringify(events)).not.toMatch(/LEAK_MARKER|example-host/);
  });
});

describe('I and J. two sessions and eviction', () => {
  it('are evicted independently: neither waits for the other', async () => {
    const { registry, clock, held, hold, create } = setup();
    const a = await create('a');
    const b = await create('b');
    visit(a);
    visit(b, 'Bo');
    clock.set(IDLE);
    hold('save');
    const sweeping = registry.evictIdle();
    await until(() => held.length === 2);
    expect(held.map((call) => call.sessionId).sort()).toEqual(['a', 'b']);

    held.find((call) => call.sessionId === 'b')?.finish();
    await until(() => registry.get('b') === undefined);
    expect(registry.get('a')).toBe(a);
    held[0]?.finish();
    expect([...(await sweeping).evicted].sort()).toEqual(['a', 'b']);
  });

  it('leave a session that is in use, and one that cannot be saved, exactly as they were', async () => {
    const { registry, inner, clock, failing, create } = setup();
    const idle = await create('idle');
    const busy = await create('busy');
    const broken = await create('broken');
    visit(idle);
    visit(broken, 'Cy');
    const who = connection();
    join(busy.room, who, 'Bo');
    const untouched = busy.session.getState();
    who.take();
    failing.save.add('broken');
    clock.set(IDLE);

    const swept = await registry.evictIdle();
    expect(swept.evicted).toEqual(['idle']);
    expect(swept.failed.map((failure) => failure.sessionId)).toEqual(['broken']);
    expect(registry.get('busy')).toBe(busy);
    expect(registry.get('broken')).toBe(broken);
    expect(busy.session.getState()).toBe(untouched);
    expect(busy.room.isClosed()).toBe(false);
    expect(who.take()).toEqual([]);
    expect(who.closed).toBe(false);
    expect(await stored(inner, 'idle')).toEqual(['Ada']);
  });
});

describe('K. eviction while a save is running', () => {
  it('waits for that save, saves what it must, and only then releases the session', async () => {
    const { registry, inner, held, hold, counts, create } = setupCounting();
    const a = await create('a');
    visit(a);
    hold('save');
    const saving = a.save();
    await until(() => held.length === 1);

    const evicting = registry.evict('a');
    await settle();
    // One write at the store at a time, and the session is still loaded.
    expect(held).toHaveLength(1);
    expect(registry.get('a')).toBe(a);

    held[0]?.finish();
    unwrap(await saving);
    await until(() => held.length === 1 || registry.get('a') === undefined);
    held[0]?.finish();
    unwrap(await evicting);
    expect(registry.get('a')).toBeUndefined();
    expect(counts.mostAtOnce).toBe(1);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
  });
});

describe('L. something happening to the session while it is being evicted', () => {
  it('gives way to a connection that arrives during the save', async () => {
    const { registry, inner, held, hold, create, kinds } = setup();
    const a = await create('a');
    visit(a);
    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);

    const who = connection();
    join(a.room, who, 'Bo');
    held[0]?.finish();
    expect(codeOf(await evicting)).toBe('SESSION_IN_USE');

    // The session is still the same loaded one, and the player is in it.
    expect(registry.get('a')).toBe(a);
    expect(a.room.isClosed()).toBe(false);
    expect(who.closed).toBe(false);
    expect(a.room.playerIdOf(who)).toBeDefined();
    expect(kinds('a').at(-1)).toBe('eviction_failed');
    // What was saved is what there was when the save began. Bo is unsaved, not lost.
    expect(await stored(inner, 'a')).toEqual(['Ada']);
    expect(a.hasUnsavedChanges()).toBe(true);
    send(a.room, who, READY, 500);
    expect(who.inbox.at(-1)?.type).toBe('update');
  });

  it('gives way to a change made during the save, even with nobody connected', async () => {
    const { registry, held, hold, create } = setup();
    const a = await create('a');
    visit(a);
    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);
    unwrap(
      a.session.applyCommand({ type: 'ADD_PLAYER', playerId: 'p9', displayName: 'Late' }, at(50)),
    );
    held[0]?.finish();
    expect(codeOf(await evicting)).toBe('SESSION_IN_USE');
    expect(registry.get('a')).toBe(a);
    expect(a.hasUnsavedChanges()).toBe(true);
    // The next attempt saves the change and goes through.
    hold();
    const again = registry.evict('a');
    await until(() => held.length === 1);
    held[0]?.finish();
    unwrap(await again);
  });

  it('is not disturbed by a connection that came and went before it began', async () => {
    const { registry, create } = setup();
    const a = await create('a');
    const who = connection();
    a.room.attach(who);
    a.room.disconnect(who);
    unwrap(await registry.evict('a'));
    expect(registry.get('a')).toBeUndefined();
  });
});

describe('N. evicting twice', () => {
  it('is one eviction: one save, one unload, the same answer', async () => {
    const { registry, calls, held, hold, create, kinds } = setup();
    const a = await create('a');
    visit(a);
    const saves = calls.save;
    hold('save');
    const first = registry.evict('a');
    const second = registry.evict('a');
    const sweep = registry.evictIdle();
    await until(() => held.length === 1);
    held[0]?.finish();

    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await second).toEqual({ ok: true, value: undefined });
    await sweep;
    expect(calls.save).toBe(saves + 1);
    expect(kinds('a').filter((type) => type === 'eviction_started')).toHaveLength(1);
    expect(kinds('a').filter((type) => type === 'unloaded')).toHaveLength(1);
  });

  it('succeeds for a session that is not in memory, without asking the store', async () => {
    const { registry, calls, create } = setup();
    await create('a');
    unwrap(await registry.evict('a'));
    const before = { ...calls };
    expect(await registry.evict('a')).toEqual({ ok: true, value: undefined });
    expect(await registry.evict('never-existed')).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual(before);
  });

  it('can be tried again after it failed', async () => {
    const { registry, failing, create } = setup();
    const a = await create('a');
    visit(a);
    failing.save.add('a');
    expect(codeOf(await registry.evict('a'))).toBe('STORAGE_ERROR');
    failing.save.clear();
    unwrap(await registry.evict('a'));
    expect(registry.get('a')).toBeUndefined();
  });
});

describe('O. loading and evicting the same session', () => {
  it('evicts after a load that was already under way', async () => {
    const { registry, inner, calls, held, hold, create } = setup();
    const first = await create('a');
    visit(first);
    unwrap(await registry.evict('a'));
    hold('load');
    const loading = registry.load('a');
    await until(() => held.length === 1);
    const evicting = registry.evict('a');
    await settle();
    expect(registry.get('a')).toBeUndefined();

    held[0]?.finish();
    const handle = unwrap(await loading);
    unwrap(await evicting);
    expect(registry.get('a')).toBeUndefined();
    expect(handle.room.isClosed()).toBe(true);
    expect(calls.delete).toBe(0);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
  });

  it('gives a load asked for during an eviction the session that is still loaded', async () => {
    const { registry, held, hold, create } = setup();
    const a = await create('a');
    visit(a);
    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);
    // It is still registered, so this is not a second copy and reads no store.
    expect(unwrap(await registry.load('a'))).toBe(a);
    held[0]?.finish();
    unwrap(await evicting);
    expect(registry.get('a')).toBeUndefined();
  });

  it('loads a new handle once the eviction has finished', async () => {
    const { registry, create } = setup();
    const old = await create('a');
    visit(old);
    const [evicted, loaded] = await Promise.all([registry.evict('a'), registry.load('a')]);
    unwrap(evicted);
    // The load was asked for while the first handle was still registered.
    expect(unwrap(loaded)).toBe(old);
    const now = unwrap(await registry.load('a'));
    expect(now).not.toBe(old);
    expect(now.room).not.toBe(old.room);
    expect(now.room.isClosed()).toBe(false);
  });
});

describe('P and V. shutting the registry down', () => {
  it('waits for an eviction under way, refuses new ones, and closes the store last', async () => {
    const { registry, inner, events: storeEvents, calls, held, hold, create } = withStoreEvents();
    const a = await create('a');
    const b = await create('b');
    visit(a);
    visit(b, 'Bo');
    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);
    const stopping = registry.shutdown();
    await settle();
    expect(storeEvents).not.toContain('store.close');

    expect(codeOf(await registry.evict('b'))).toBe('REGISTRY_CLOSED');
    expect(await registry.evictIdle()).toEqual({ evicted: [], failed: [] });

    held[0]?.finish();
    unwrap(await evicting);
    await until(() => held.length === 1);
    held[0]?.finish();
    unwrap(await stopping);
    expect(storeEvents.at(-1)).toBe('store.close');
    expect(calls.close).toBe(1);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
    expect(await stored(inner, 'b')).toEqual(['Bo']);
    expect(registry.sessions()).toEqual([]);
  });

  it('reports a session whose eviction had failed and that still cannot be saved', async () => {
    const { registry, failing, create } = setup();
    const a = await create('a');
    const b = await create('b');
    visit(a);
    visit(b, 'Bo');
    failing.save.add('a');
    expect(codeOf(await registry.evict('a'))).toBe('STORAGE_ERROR');

    const result = await registry.shutdown();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.failures.map((failure) => failure.sessionId)).toEqual(['a']);
    expect(result.error.storeClosed).toBe(true);
    // The failure is known, not hidden: the handle still says it is unsaved.
    expect(a.hasUnsavedChanges()).toBe(true);
    expect(b.hasUnsavedChanges()).toBe(false);
  });

  it('unloads idle, active and finished sessions alike, and says so for each', async () => {
    const { registry, create, kinds } = setup();
    const idle = await create('idle');
    const active = await create('active');
    const over = await create('over');
    visit(idle);
    const who = connection();
    join(active.room, who, 'Bo');
    unwrap(over.session.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(5)));
    expect(
      registry
        .sessions()
        .map((info) => info.state)
        .sort(),
    ).toEqual(['active', 'finished', 'idle']);

    unwrap(await registry.shutdown());
    for (const id of ['idle', 'active', 'over']) expect(kinds(id).at(-1)).toBe('unloaded');
    expect(who.inbox.at(-1)).toEqual(SESSION_CLOSED);
    expect(registry.sessions()).toEqual([]);
  });
});

describe('R. what is left of an evicted session', () => {
  it('is nothing that can change the game or the store', async () => {
    const { registry, inner, calls, events, create } = setup();
    const old = await create('a');
    const visitor = visit(old);
    unwrap(await registry.evict('a'));
    const frozen = old.session.getState();
    const saves = calls.save;
    events.length = 0;

    // The old room turns everyone away, and tells the registry nothing.
    const late = connection();
    expect(old.room.attach(late)).toBe(false);
    send(old.room, late, { type: 'resume', token: visitor.token });
    expect(late.take()).toEqual([SESSION_CLOSED]);
    expect(old.room.tick(at(10_000_000)).ok).toBe(true);
    expect(old.session.getState()).toBe(frozen);
    // The old handle cannot write, and stopping it again does nothing.
    expect(codeOf(await old.save())).toBe('STORAGE_ERROR');
    await old.close();
    unwrap(await old.shutdown());
    expect(calls.save).toBe(saves);
    expect(events).toEqual([]);
    expect(registry.sessions()).toEqual([]);

    // Loaded again, everything is new, and the old objects cannot reach it.
    const now = unwrap(await registry.load('a'));
    expect(now).not.toBe(old);
    expect(now.room).not.toBe(old.room);
    expect(now.session).not.toBe(old.session);
    old.room.close();
    await old.close();
    expect(registry.get('a')).toBe(now);
    expect(now.room.isClosed()).toBe(false);
    // Deleting stays a separate thing: nothing above removed the stored game.
    expect(await stored(inner, 'a')).toEqual(['Ada']);
    expect(calls.delete).toBe(0);
  });

  it('does not accumulate: many sessions created and evicted leave nothing in memory', async () => {
    const { registry, inner, clock, create } = setup();
    for (let index = 0; index < 40; index += 1) visit(await create(`s${index}`));
    expect(registry.sessions()).toHaveLength(40);
    clock.set(IDLE);
    expect((await registry.evictIdle()).evicted).toHaveLength(40);
    expect(registry.sessions()).toEqual([]);
    for (let index = 0; index < 40; index += 1) {
      expect(registry.get(`s${index}`)).toBeUndefined();
      expect(await stored(inner, `s${index}`)).toEqual(['Ada']);
    }
  });

  it('starts no timer, and evicts nothing until it is asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { registry, clock, create } = setup();
      await create('a');
      clock.set(100 * IDLE);
      await vi.advanceTimersByTimeAsync(100 * IDLE);
      expect(vi.getTimerCount()).toBe(0);
      expect(registry.get('a')).toBeDefined();
      await registry.evictIdle();
      expect(registry.get('a')).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the registry says about its sessions', () => {
  it('tells the story of a session in order, with nothing of the game in it', async () => {
    const { registry, clock, events, create } = setup();
    const a = await create('a');
    const visitor = visit(a, 'Ada Secretname');
    clock.set(IDLE);
    await registry.evictIdle();
    unwrap(await registry.load('a'));

    expect(events.map((event) => event.type)).toEqual([
      'created',
      'idle',
      'eviction_started',
      'unloaded',
      'evicted',
      'loaded',
    ]);
    expect(events.every((event) => event.sessionId === 'a')).toBe(true);
    const told = JSON.stringify(events);
    for (const hidden of [visitor.token, a.hostToken, 'Secretname', visitor.playerId, CODE]) {
      expect(told.includes(hidden)).toBe(false);
    }
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['at', 'sessionId', 'type']);
    }
  });

  it('is not affected by a listener that throws', async () => {
    const registry = createSessionRegistry({
      store: new InMemorySessionStore(),
      onEvent: () => {
        throw new Error('the listener broke');
      },
    });
    const a = unwrap(await registry.create(createCommand('a'), at(0)));
    visit(a);
    unwrap(await registry.evict('a'));
    expect(registry.get('a')).toBeUndefined();
  });
});

// ---- over real sockets ------------------------------------------------------------------

let running: SessionServer[] = [];

async function startServer(backing = heldStore()) {
  const clock = testClock();
  const events: SessionLifecycleEvent[] = [];
  const server = unwrap(
    await startSessionServer({
      store: backing.store,
      port: 0,
      clock,
      tokenKey: KEY,
      idleMs: IDLE,
      finishedIdleMs: FINISHED_IDLE,
      onEvent: (event) => events.push(event),
    }),
  );
  running.push(server);
  const create = async (sessionId: string): Promise<SessionHandle> =>
    unwrap(await server.registry.create(createCommand(sessionId), at(0)));
  return { ...backing, server, registry: server.registry, clock, events, create };
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.shutdown()));
  running = [];
});

async function drop(client: Client, server: SessionServer): Promise<void> {
  const before = server.socketCount();
  client.socket.close();
  await client.closed;
  await until(() => server.socketCount() < before);
}

describe('G, H and Q. evicted, then reached again over the network', () => {
  it('create, join, act, drop, evict, reconnect, resume: the same player in the same game', async () => {
    const { server, registry, inner, clock, create } = await startServer();
    const old = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    first.send(READY);
    expect((await first.next()).type).toBe('update');
    unwrap(await old.save());
    await drop(first, server);
    await until(() => registry.sessions()[0]?.state === 'idle');

    clock.set(IDLE);
    expect(await registry.evictIdle()).toEqual({ evicted: ['a'], failed: [] });
    // Out of memory, with no connection left behind, and still stored.
    expect(registry.get('a')).toBeUndefined();
    expect(registry.sessions()).toEqual([]);
    expect(server.socketCount()).toBe(0);
    expect(old.room.isClosed()).toBe(true);
    expect(await stored(inner, 'a')).toEqual(['Ada']);

    const back = await Client.open(server.port, 'a');
    back.send({ type: 'resume', token: ada.token });
    const reply = await back.next();
    expect([reply.type, reply.playerId]).toEqual(['joined', ada.playerId]);

    const now = registry.get('a');
    expect(now).toBeDefined();
    expect(now).not.toBe(old);
    expect(now?.room).not.toBe(old.room);
    expect(now?.session).not.toBe(old.session);
    expect(now?.session.getState()).toEqual(old.session.getState());
    expect(now?.session.getState().players).toMatchObject([
      { id: ada.playerId, displayName: 'Ada', ready: true },
    ]);
    expect(registry.sessions()[0]).toMatchObject({ state: 'active', connections: 1 });

    // One room, one listener: an update arrives once.
    const second = await Client.open(server.port, 'a');
    await second.join('Bo');
    expect((await back.next()).type).toBe('update');
    await settled(back);
    expect(back.pending()).toBe(0);
  });

  it('is not evicted while a socket is connected, joined or not', async () => {
    const { server, registry, clock, create } = await startServer();
    const a = await create('a');
    const silent = await Client.open(server.port, 'a');
    await until(() => registry.sessions()[0]?.connections === 1);
    clock.set(100 * IDLE);
    expect((await registry.evictIdle()).evicted).toEqual([]);
    expect(codeOf(await registry.evict('a'))).toBe('SESSION_IN_USE');
    expect(registry.get('a')).toBe(a);

    // Its idle time starts when the socket goes.
    await drop(silent, server);
    await until(() => registry.sessions()[0]?.state === 'idle');
    expect((await registry.evictIdle()).evicted).toEqual([]);
    clock.set(101 * IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
  });

  it('leaves another session and its connections untouched', async () => {
    const { server, registry, clock, create } = await startServer();
    const a = await create('a');
    const b = await create('b');
    const inA = await Client.open(server.port, 'a');
    await inA.join('Ada');
    await drop(inA, server);
    const inB = await Client.open(server.port, 'b');
    await inB.join('Bo');
    const untouched = b.session.getState();

    clock.set(IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
    expect(a.room.isClosed()).toBe(true);
    expect(registry.get('b')).toBe(b);
    expect(b.session.getState()).toBe(untouched);
    await settled(inB);
    expect(inB.pending()).toBe(0);
    inB.send(READY);
    expect((await inB.next()).type).toBe('update');
  });
});

describe('M. a player coming back while their session is being evicted', () => {
  it('wins: the resume goes through and the session stays loaded', async () => {
    const { server, registry, held, hold, release, create } = await startServer();
    const a = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);
    await until(() => registry.sessions()[0]?.state === 'idle');

    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);
    const back = await Client.open(server.port, 'a');
    back.send({ type: 'resume', token: ada.token });
    expect((await back.next()).playerId).toBe(ada.playerId);

    release('save');
    held[0]?.finish();
    expect(codeOf(await evicting)).toBe('SESSION_IN_USE');
    expect(registry.get('a')).toBe(a);
    back.send(READY);
    expect((await back.next()).type).toBe('update');
  });

  it('is served from the store when they arrive just after it finished', async () => {
    const { server, registry, calls, create } = await startServer();
    const old = await create('a');
    const first = await Client.open(server.port, 'a');
    const ada = await first.join('Ada');
    await drop(first, server);
    await until(() => registry.sessions()[0]?.state === 'idle');

    const evicting = registry.evict('a');
    const back = await Client.open(server.port, 'a');
    back.send({ type: 'resume', token: ada.token });
    unwrap(await evicting);
    expect((await back.next()).playerId).toBe(ada.playerId);
    expect(registry.get('a')).toBeDefined();
    // Either the eviction saw them and stood down, or they loaded it again.
    // In both cases there is exactly one loaded session and it has them in it.
    expect(registry.sessions()).toHaveLength(1);
    expect(registry.get('a')?.room.connectionCount()).toBe(1);
    expect(calls.delete).toBe(0);
    expect(old.session.getState().players).toHaveLength(1);
  });

  it('is unaffected by a socket that drops while the session is being saved', async () => {
    const { server, registry, inner, held, hold, release, create } = await startServer();
    await create('a');
    const first = await Client.open(server.port, 'a');
    await first.join('Ada');
    await drop(first, server);
    await until(() => registry.sessions()[0]?.state === 'idle');
    hold('save');
    const evicting = registry.evict('a');
    await until(() => held.length === 1);

    // A socket arrives and is gone again before the save finishes.
    const passing = await Client.open(server.port, 'a');
    await until(() => registry.sessions()[0]?.connections === 1);
    await drop(passing, server);
    await until(() => registry.sessions()[0]?.connections === 0);

    release('save');
    held[0]?.finish();
    unwrap(await evicting);
    expect(registry.get('a')).toBeUndefined();
    expect(await stored(inner, 'a')).toEqual(['Ada']);
  });
});

describe('W. the same sessions in a later server', () => {
  it('are loaded from the store, and a player with the same key resumes', async () => {
    const inner = new InMemorySessionStore();
    const first = await startServer(heldStore(inner));
    await first.create('a');
    const client = await Client.open(first.server.port, 'a');
    const ada = await client.join('Ada');
    await drop(client, first.server);
    unwrap(await first.registry.evict('a'));
    unwrap(await first.server.shutdown());

    const second = await startServer(heldStore(inner));
    expect(second.registry.sessions()).toEqual([]);
    const back = await Client.open(second.server.port, 'a');
    back.send({ type: 'resume', token: ada.token });
    expect((await back.next()).playerId).toBe(ada.playerId);
    expect(second.events.map((event) => event.type)).toEqual(['loaded']);
  });
});

describe('the lifecycle settings', () => {
  it('have defaults, kept in one place', () => {
    expect(unwrap(parseLifecycleConfig({}))).toEqual({
      idleMs: DEFAULT_SESSION_IDLE_MS,
      finishedIdleMs: DEFAULT_FINISHED_IDLE_MS,
      sweepMs: DEFAULT_SESSION_SWEEP_MS,
    });
    expect(unwrap(parseLifecycleConfig({ SESSION_IDLE_MS: ' ', SESSION_SWEEP_MS: '' }))).toEqual(
      unwrap(parseLifecycleConfig({})),
    );
    const directory = dirname(fileURLToPath(import.meta.url));
    const sources = ['config.ts', 'session-server.ts', 'dev-sessions.ts', 'session-handle.ts'].map(
      (name) => readFileSync(joinPath(directory, name), 'utf-8'),
    );
    // The thirty minutes are written once, in the registry.
    for (const source of sources) expect(source).not.toMatch(/30 \* 60_000|1_?800_?000/);
  });

  it('can be set, and are refused when they make no sense', () => {
    expect(
      unwrap(
        parseLifecycleConfig({
          SESSION_IDLE_MS: '5000',
          SESSION_FINISHED_IDLE_MS: '250',
          SESSION_SWEEP_MS: '1000',
        }),
      ),
    ).toEqual({ idleMs: 5_000, finishedIdleMs: 250, sweepMs: 1_000 });
    for (const env of [
      { SESSION_IDLE_MS: '-1' },
      { SESSION_IDLE_MS: 'soon' },
      { SESSION_FINISHED_IDLE_MS: '1.5' },
      { SESSION_SWEEP_MS: '0' },
      { SESSION_SWEEP_MS: '99999999999' },
    ]) {
      const parsed = parseLifecycleConfig(env);
      expect(codeOf(parsed), JSON.stringify(env)).toBe('INVALID_CONFIGURATION');
      if (!parsed.ok) expect(parsed.error.issues.join(' ')).toMatch(/^SESSION_/);
    }
  });
});

describe('S, T and U. the development entry points', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const strip = (name: string): string =>
    readFileSync(joinPath(directory, name), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const dev = strip('dev-sessions.ts');

  it('start one listener over one store and one registry', () => {
    expect(dev.match(/createMongoSessionStore\(/g)).toHaveLength(1);
    expect(dev.match(/startSessionServer\(/g)).toHaveLength(1);
    expect(dev).toContain('createMongoSessionStore(config.value.mongo)');
    expect(dev).not.toMatch(/startPersistentServer|createSessionRegistry\(|createRealtimeServer/);
    expect(dev).toContain('idleMs: lifecycle.value.idleMs');
    expect(dev).toContain('finishedIdleMs: lifecycle.value.finishedIdleMs');
  });

  it('have one timer, which only asks the registry to look, and stop it first on the way out', () => {
    expect(dev.match(/setInterval\(/g)).toHaveLength(1);
    expect(dev).toMatch(
      /setInterval\(\(\) => \{\s*void registry\.evictIdle\(\);\s*\}, lifecycle\.value\.sweepMs\)/,
    );
    expect(dev).toMatch(
      /clearInterval\(sweep\);\s*try \{\s*const result = await server\.shutdown\(\)/,
    );
    expect(dev.match(/void shutdown\(\)/g)).toHaveLength(2);
    expect(dev).toMatch(/process\.once\('SIGINT', \(\) => \{\s*void shutdown\(\);/);
    expect(dev.match(/process\.exit\(0\)/g)).toHaveLength(1);
    expect(dev).toMatch(/if \(!result\.ok\) \{[\s\S]*?process\.exit\(1\);/);
  });

  it('print no player token, and the host token only where a session is made', () => {
    expect(dev.match(/hostToken/g)).toHaveLength(1);
    expect(dev).not.toMatch(/tokenKey|\.token\b|playerToken/);
    expect(dev).not.toMatch(/console\.\w+\([^)]*event\)\)/);
  });

  it('leave the single-game entry point and its command as they were', () => {
    const single = strip('dev.ts');
    expect(single).toContain('startPersistentServer({');
    expect(single).not.toMatch(/startSessionServer|evictIdle|setInterval/);
    const manifest = JSON.parse(
      readFileSync(joinPath(directory, '..', '..', '..', 'package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts['server:dev']).toBe('tsx packages/server/src/dev.ts');
    expect(manifest.scripts['sessions:dev']).toBe('tsx packages/server/src/dev-sessions.ts');
  });

  it('do what the entry point does: start, serve two sessions, sweep, and stop cleanly', async () => {
    const { server, registry, inner, clock, calls, create } = await startServer();
    await create('a');
    await create('b');
    const inA = await Client.open(server.port, 'a');
    const inB = await Client.open(server.port, 'b');
    expect((await inA.join('Ada')).sessionId).toBe('a');
    expect((await inB.join('Bo')).sessionId).toBe('b');
    await drop(inA, server);
    await until(() => registry.sessions().some((info) => info.state === 'idle'));

    // What the sweep timer does, once.
    clock.set(IDLE);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);

    expect(await server.shutdown()).toEqual({ ok: true, value: undefined });
    await inB.closed;
    expect(server.socketCount()).toBe(0);
    expect(registry.sessions()).toEqual([]);
    expect(calls.close).toBe(1);
    expect(await stored(inner, 'a')).toEqual(['Ada']);
    expect(await stored(inner, 'b')).toEqual(['Bo']);
  });
});

// ---- helpers that need the above -----------------------------------------------------

/** Lets everything that is ready to run, run. No clock is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A setup whose store also counts how many writes are at it at once. */
function setupCounting() {
  const backing = heldStore();
  const counts = { atOnce: 0, mostAtOnce: 0 };
  const save = backing.store.save.bind(backing.store);
  backing.store.save = async (snapshot) => {
    counts.atOnce += 1;
    counts.mostAtOnce = Math.max(counts.mostAtOnce, counts.atOnce);
    try {
      return await save(snapshot);
    } finally {
      counts.atOnce -= 1;
    }
  };
  return { ...setup(backing), counts };
}

/** A setup that also hands back the store's own record of what it did. */
function withStoreEvents() {
  const backing = heldStore();
  const made = setup(backing);
  return { ...made, events: backing.events };
}

export type { TestConnection };
