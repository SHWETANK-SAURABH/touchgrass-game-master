import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type Result, err } from '@touchgrass/shared';
import type { GameSessionSnapshot } from '@touchgrass/game-session';
import { InMemorySessionStore, type SessionStoreError } from '@touchgrass/session-store';
import type { ClosableSessionStore } from './persistent-server';
import { createPersistentSessions } from './persistent-sessions';
import type { SessionHandle } from './session-handle';
import { createSessionRegistry } from './session-registry';
import { at, codeOf, connection, createCommand, join, send, unwrap } from './test-support';

const STORAGE_ERROR: SessionStoreError = {
  code: 'STORAGE_ERROR',
  message: 'The database is away.',
};

type Operation = 'save' | 'load' | 'delete';

/** One store call that has arrived and has not been allowed to finish. */
interface Held {
  readonly operation: Operation;
  readonly sessionId: string;
  /** Lets the call finish: carried out for real, or failed. */
  finish(outcome?: 'ok' | 'fail'): void;
}

/**
 * A real in-memory store that records every call, and whose calls can be held
 * until the test lets them finish.
 *
 * Nothing here waits on a clock. A test starts operations, looks at which calls
 * have reached the store, and finishes them one by one, so what it proves does
 * not depend on timing.
 */
function gatedStore(inner = new InMemorySessionStore()) {
  const events: string[] = [];
  const calls = { save: 0, load: 0, delete: 0, close: 0 };
  const saved: GameSessionSnapshot[] = [];
  const held: Held[] = [];
  const holding = new Set<Operation>();
  /** Session ids whose calls of each kind fail. */
  const failing = { save: new Set<string>(), load: new Set<string>(), delete: new Set<string>() };
  const control = { failClose: false };
  let closed = false;

  const gate = <T>(
    operation: Operation,
    sessionId: string,
    run: () => Promise<Result<T, SessionStoreError>>,
  ): Promise<Result<T, SessionStoreError>> => {
    calls[operation] += 1;
    events.push(`${operation}:${sessionId}:start`);
    const perform = async (outcome: 'ok' | 'fail'): Promise<Result<T, SessionStoreError>> => {
      const result =
        closed || outcome === 'fail' || failing[operation].has(sessionId)
          ? err(STORAGE_ERROR)
          : await run();
      events.push(`${operation}:${sessionId}:${result.ok ? 'end' : 'failed'}`);
      return result;
    };
    if (!holding.has(operation)) return perform('ok');
    return new Promise((resolve) => {
      const call: Held = {
        operation,
        sessionId,
        finish(outcome = 'ok') {
          held.splice(held.indexOf(call), 1);
          void perform(outcome).then(resolve);
        },
      };
      held.push(call);
    });
  };

  const store: ClosableSessionStore = {
    save: (snapshot) =>
      gate('save', snapshot.sessionId, () => {
        saved.push(snapshot);
        return inner.save(snapshot);
      }),
    load: (sessionId) => gate('load', sessionId, () => inner.load(sessionId)),
    delete: (sessionId) => gate('delete', sessionId, () => inner.delete(sessionId)),
    close() {
      calls.close += 1;
      events.push('store.close');
      if (control.failClose) return Promise.reject(new Error('the store would not close'));
      closed = true;
      return Promise.resolve();
    },
  };

  return {
    store,
    inner,
    events,
    calls,
    /** Every snapshot really written, in order. */
    saved,
    /** Calls that have reached the store and not finished. */
    held,
    failing,
    control,
    /** From now on, calls of these kinds wait to be finished by the test. */
    hold: (...operations: Operation[]): void => {
      for (const operation of operations) holding.add(operation);
    },
    /** Finishes the held call for this session. */
    finish: (sessionId: string, outcome: 'ok' | 'fail' = 'ok'): void => {
      const call = held.find((candidate) => candidate.sessionId === sessionId);
      if (!call) throw new Error(`no held call for ${sessionId}`);
      call.finish(outcome);
    },
  };
}

/** Lets everything that is ready to run, run. No clock is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Whether a promise has settled yet, without waiting for it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const first = await Promise.race([promise.then(() => undefined), Promise.resolve(pending)]);
  return first !== pending;
}

/** A registry over a gated store, with host tokens that say which they are. */
function setup(backing = gatedStore()) {
  let minted = 0;
  const registry = createSessionRegistry({
    store: backing.store,
    createToken: () => {
      minted += 1;
      return `token-${minted}`;
    },
  });
  return { ...backing, registry, tokensMinted: () => minted };
}

/** Stores a game directly, without any registry knowing. */
async function seed(inner: InMemorySessionStore, sessionId: string): Promise<void> {
  unwrap(await createPersistentSessions(inner).create(createCommand(sessionId), at(0)));
}

/** Changes a game: one player joins through its room. */
function change(handle: SessionHandle, name = 'Ada') {
  const who = connection();
  return { who, ...join(handle.room, who, name) };
}

const names = (handle: SessionHandle): string[] =>
  handle.session.getState().players.map((player) => player.displayName);

const storedNames = async (inner: InMemorySessionStore, sessionId: string): Promise<string[]> =>
  (unwrap(await inner.load(sessionId))?.state.players ?? []).map((player) => player.displayName);

describe('a session registry', () => {
  it('creates a session, saves it once, and holds its handle', async () => {
    const { registry, calls, saved } = setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));

    expect(handle.session.id).toBe('a');
    expect(handle.hostToken).toBe('token-1');
    expect(handle.room.connectionCount()).toBe(0);
    expect(handle.hasUnsavedChanges()).toBe(false);
    expect(calls.save).toBe(1);
    expect(saved.map((snapshot) => snapshot.sessionId)).toEqual(['a']);
    expect(registry.get('a')).toBe(handle);
  });

  it('gives the loaded handle again, without asking the store', async () => {
    const { registry, calls } = setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const loads = calls.load;

    expect(unwrap(await registry.load('a'))).toBe(handle);
    expect(unwrap(await registry.load('a'))).toBe(handle);
    expect(registry.get('a')).toBe(handle);
    expect(calls.load).toBe(loads);
  });

  it('answers get from memory only', async () => {
    const { registry, inner, calls } = setup();
    await seed(inner, 'stored');
    expect(registry.get('stored')).toBeUndefined();
    expect(registry.get('nothing')).toBeUndefined();
    expect(calls).toEqual({ save: 0, load: 0, delete: 0, close: 0 });
  });

  it('keeps nothing outside itself: two registries are independent', async () => {
    const one = setup();
    const two = setup();
    const first = unwrap(await one.registry.create(createCommand('a'), at(0)));
    expect(two.registry.get('a')).toBeUndefined();
    expect(codeOf(await two.registry.load('a'))).toBe('SESSION_NOT_FOUND');

    // The same id in another registry is another game entirely.
    const second = unwrap(await two.registry.create(createCommand('a'), at(0)));
    expect(second).not.toBe(first);
    change(first);
    expect(names(second)).toEqual([]);

    unwrap(await one.registry.shutdown());
    expect(two.registry.get('a')).toBe(second);
    expect(two.calls.close).toBe(0);
  });

  it('holds its sessions per instance even over one store', async () => {
    const backing = gatedStore();
    const one = setup(backing);
    const two = createSessionRegistry({ store: backing.store });
    const handle = unwrap(await one.registry.create(createCommand('a'), at(0)));
    expect(two.get('a')).toBeUndefined();
    // The rule is per registry: nothing stops another one loading the same id.
    expect(unwrap(await two.load('a'))).not.toBe(handle);
  });
});

describe('creating through a registry', () => {
  it('refuses an id that is stored but not loaded', async () => {
    const { registry, inner, calls, tokensMinted } = setup();
    await seed(inner, 'a');
    expect(codeOf(await registry.create(createCommand('a'), at(0)))).toBe('SESSION_ALREADY_EXISTS');
    expect(registry.get('a')).toBeUndefined();
    expect(calls.save).toBe(0);
    expect(tokensMinted()).toBe(0);
    // It can still be loaded: the refusal left no reservation behind.
    expect(unwrap(await registry.load('a')).session.id).toBe('a');
  });

  it('refuses an id that is loaded, without asking the store', async () => {
    const { registry, calls } = setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const before = { ...calls };
    expect(codeOf(await registry.create(createCommand('a'), at(0)))).toBe('SESSION_ALREADY_EXISTS');
    expect(calls).toEqual(before);
    expect(registry.get('a')).toBe(handle);
  });

  it('lets exactly one of two creations of the same id through', async () => {
    const { registry, calls, held, hold, finish, tokensMinted } = setup();
    hold('save');
    const first = registry.create(createCommand('a'), at(0));
    const second = registry.create(createCommand('a'), at(0));

    // The second is refused at once, while the first is still being saved.
    expect(codeOf(await second)).toBe('SESSION_ALREADY_EXISTS');
    await settle();
    expect(held.map((call) => call.operation)).toEqual(['save']);
    expect(registry.get('a')).toBeUndefined();
    expect(tokensMinted()).toBe(0);

    finish('a');
    const handle = unwrap(await first);
    expect(registry.get('a')).toBe(handle);
    expect(calls.save).toBe(1);
    expect(calls.load).toBe(1);
    expect(tokensMinted()).toBe(1);
  });

  it('creates different ids at the same time', async () => {
    const { registry, held, hold, finish } = setup();
    hold('save');
    const first = registry.create(createCommand('a'), at(0));
    const second = registry.create(createCommand('b'), at(0));
    await settle();
    expect(held.map((call) => call.sessionId).sort()).toEqual(['a', 'b']);

    // Neither waits for the other.
    finish('b');
    expect(unwrap(await second).session.id).toBe('b');
    expect(await isSettled(first)).toBe(false);
    finish('a');
    expect(unwrap(await first).session.id).toBe('a');
  });

  it('leaves nothing behind when the first save fails, and can be tried again', async () => {
    const { registry, inner, failing, tokensMinted } = setup();
    failing.save.add('a');
    const failed = await registry.create(createCommand('a'), at(0));
    expect(codeOf(failed)).toBe('STORAGE_ERROR');
    expect(registry.get('a')).toBeUndefined();
    // No room and no host token were made for it.
    expect(tokensMinted()).toBe(0);
    expect(unwrap(await inner.load('a'))).toBeNull();
    expect(codeOf(await registry.load('a'))).toBe('SESSION_NOT_FOUND');

    failing.save.clear();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    expect(registry.get('a')).toBe(handle);
    expect(tokensMinted()).toBe(1);
  });

  it('leaves nothing behind when the store cannot be read', async () => {
    const { registry, failing, calls } = setup();
    failing.load.add('a');
    expect(codeOf(await registry.create(createCommand('a'), at(0)))).toBe('STORAGE_ERROR');
    expect(calls.save).toBe(0);
    expect(registry.get('a')).toBeUndefined();
    failing.load.clear();
    expect((await registry.create(createCommand('a'), at(0))).ok).toBe(true);
  });

  it('reports a game that cannot be made, and reserves nothing', async () => {
    const { registry, calls } = setup();
    const failed = await registry.create(createCommand('a', 'no-such-game'), at(0));
    expect(codeOf(failed)).toBe('SESSION_NOT_CREATED');
    expect(codeOf(await registry.create({ type: 'nonsense' }, at(0)))).toBe('SESSION_NOT_CREATED');
    expect(calls).toEqual({ save: 0, load: 0, delete: 0, close: 0 });
    expect((await registry.create(createCommand('a'), at(0))).ok).toBe(true);
  });
});

describe('loading through a registry', () => {
  it('loads a stored session with a new room and host token', async () => {
    const { registry, inner, calls } = setup();
    await seed(inner, 'a');
    const handle = unwrap(await registry.load('a'));
    expect(handle.session.id).toBe('a');
    expect(handle.hostToken).toBe('token-1');
    expect(handle.hasUnsavedChanges()).toBe(false);
    expect(registry.get('a')).toBe(handle);
    expect(calls).toEqual({ save: 0, load: 1, delete: 0, close: 0 });
  });

  it('registers nothing for a session that is not stored', async () => {
    const { registry, tokensMinted } = setup();
    expect(codeOf(await registry.load('nothing'))).toBe('SESSION_NOT_FOUND');
    expect(registry.get('nothing')).toBeUndefined();
    expect(tokensMinted()).toBe(0);
  });

  it('refuses an id that cannot be one, and holds nothing for it', async () => {
    const { registry } = setup();
    expect(codeOf(await registry.load(''))).toBe('INVALID_SESSION_ID');
    expect(codeOf(await registry.load(''))).toBe('INVALID_SESSION_ID');
    expect(registry.get('')).toBeUndefined();
  });

  it('restores once for loads that overlap, and gives them one handle', async () => {
    const { registry, inner, calls, held, hold, finish, tokensMinted } = setup();
    await seed(inner, 'a');
    hold('load');
    const first = registry.load('a');
    const second = registry.load('a');
    await settle();
    const third = registry.load('a');
    await settle();
    expect(held).toHaveLength(1);
    expect(registry.get('a')).toBeUndefined();

    finish('a');
    const handle = unwrap(await first);
    expect(unwrap(await second)).toBe(handle);
    expect(unwrap(await third)).toBe(handle);
    expect(calls.load).toBe(1);
    expect(tokensMinted()).toBe(1);
  });

  it('gives overlapping loads the same failure, keeps nothing, and can be tried again', async () => {
    const { registry, inner, calls, hold, finish, tokensMinted } = setup();
    await seed(inner, 'a');
    hold('load');
    const first = registry.load('a');
    const second = registry.load('a');
    await settle();
    finish('a', 'fail');
    expect(codeOf(await first)).toBe('STORAGE_ERROR');
    expect(codeOf(await second)).toBe('STORAGE_ERROR');
    expect(calls.load).toBe(1);
    expect(registry.get('a')).toBeUndefined();
    expect(tokensMinted()).toBe(0);

    // The failure was not kept: the next load reads the store again.
    const again = registry.load('a');
    await settle();
    finish('a');
    expect(unwrap(await again).session.id).toBe('a');
    expect(calls.load).toBe(2);
  });

  it('does not keep a snapshot that cannot be restored', async () => {
    const backing = gatedStore();
    const broken = { version: 1, sessionId: 'a', state: { nonsense: true } };
    const { registry } = setup({
      ...backing,
      store: {
        ...backing.store,
        load: () => Promise.resolve({ ok: true, value: broken as never }),
      },
    });
    expect(codeOf(await registry.load('a'))).toBe('INVALID_SNAPSHOT');
    expect(registry.get('a')).toBeUndefined();
  });

  it('gives a session that is loaded again nothing of its old room', async () => {
    const { registry } = setup();
    const before = unwrap(await registry.create(createCommand('a'), at(0)));
    const player = change(before);
    unwrap(await before.shutdown());
    expect(registry.get('a')).toBeUndefined();

    const after = unwrap(await registry.load('a'));
    expect(after).not.toBe(before);
    expect(after.session).not.toBe(before.session);
    expect(after.room).not.toBe(before.room);
    expect(after.hostToken).not.toBe(before.hostToken);
    // The player is still in the game, and no old capability works.
    expect(names(after)).toEqual(['Ada']);
    expect(after.room.connectionCount()).toBe(0);
    const returning = connection();
    send(after.room, returning, { type: 'resume', token: player.token });
    send(after.room, returning, { type: 'host_auth', token: before.hostToken });
    expect(returning.take()).toEqual([
      { type: 'error', code: 'INVALID_TOKEN' },
      { type: 'error', code: 'INVALID_TOKEN' },
    ]);
    send(after.room, returning, { type: 'host_auth', token: after.hostToken });
    expect(after.room.isHost(returning)).toBe(true);
  });
});

describe('sessions in one registry are isolated', () => {
  async function two() {
    const backing = setup();
    const a = unwrap(await backing.registry.create(createCommand('a'), at(0)));
    const b = unwrap(await backing.registry.create(createCommand('b'), at(0)));
    return { ...backing, a, b };
  }

  it('gives each its own session, room and host token', async () => {
    const { a, b } = await two();
    expect(a.session).not.toBe(b.session);
    expect(a.room).not.toBe(b.room);
    expect(a.hostToken).not.toBe(b.hostToken);
  });

  it('changes one game without touching the other', async () => {
    const { a, b } = await two();
    const untouched = b.session.getState();
    change(a);
    expect(names(a)).toEqual(['Ada']);
    expect(b.session.getState()).toBe(untouched);
    expect(a.hasUnsavedChanges()).toBe(true);
    expect(b.hasUnsavedChanges()).toBe(false);
  });

  it('saves one game without marking the other', async () => {
    const { a, b, saved, inner } = await two();
    change(a, 'Ada');
    change(b, 'Bo');
    saved.length = 0;

    unwrap(await a.save());
    expect(a.hasUnsavedChanges()).toBe(false);
    expect(b.hasUnsavedChanges()).toBe(true);
    expect(saved.map((snapshot) => snapshot.sessionId)).toEqual(['a']);
    expect(await storedNames(inner, 'a')).toEqual(['Ada']);
    expect(await storedNames(inner, 'b')).toEqual([]);
  });

  it('does not make one game wait for another game to be saved', async () => {
    const { a, b, held, hold, finish } = await two();
    change(a);
    change(b);
    hold('save');
    const savingB = b.save();
    const savingA = a.save();
    const savingBAgain = b.save();
    await settle();
    // Both are at the store together. The second save of B waits for the first.
    expect(held.map((call) => call.sessionId)).toEqual(['b', 'a']);

    finish('a');
    unwrap(await savingA);
    expect(a.hasUnsavedChanges()).toBe(false);
    expect(await isSettled(savingB)).toBe(false);
    expect(b.hasUnsavedChanges()).toBe(true);

    finish('b');
    unwrap(await savingB);
    await settle();
    finish('b');
    unwrap(await savingBAgain);
  });

  it('refuses a player token and a host token from the other session', async () => {
    const { a, b } = await two();
    const inA = change(a, 'Ada');
    const inB = change(b, 'Bo');

    for (const [room, foreign, foreignHost] of [
      [b.room, inA.token, a.hostToken],
      [a.room, inB.token, b.hostToken],
    ] as const) {
      const stranger = connection();
      send(room, stranger, { type: 'resume', token: foreign });
      send(room, stranger, { type: 'host_auth', token: foreignHost });
      expect(stranger.take()).toEqual([
        { type: 'error', code: 'INVALID_TOKEN' },
        { type: 'error', code: 'INVALID_TOKEN' },
      ]);
      expect(room.isHost(stranger)).toBe(false);
      expect(room.playerIdOf(stranger)).toBeUndefined();
    }

    // Each works where it was issued.
    const back = connection();
    send(a.room, back, { type: 'resume', token: inA.token });
    expect(a.room.playerIdOf(back)).toBe(inA.playerId);
    const host = connection();
    send(b.room, host, { type: 'host_auth', token: b.hostToken });
    expect(b.room.isHost(host)).toBe(true);
    expect(a.room.isHost(host)).toBe(false);
  });

  it('keeps a host command and its broadcast inside one session', async () => {
    const { a, b } = await two();
    change(a, 'Ada');
    const inB = change(b, 'Bo');
    const untouched = b.session.getState();
    inB.who.take();

    const host = connection();
    send(a.room, host, { type: 'host_auth', token: a.hostToken });
    send(
      a.room,
      host,
      { type: 'host_command', command: { type: 'ABORT_SESSION', reason: 'rain' } },
      1_000,
    );
    expect(a.session.getState().status).toBe('aborted');
    expect(b.session.getState()).toBe(untouched);
    expect(inB.who.take()).toEqual([]);
    expect(b.hasUnsavedChanges()).toBe(true);

    // And the host of A is nobody in B.
    send(
      b.room,
      host,
      { type: 'host_command', command: { type: 'ABORT_SESSION', reason: 'rain' } },
      1_000,
    );
    expect(b.session.getState()).toBe(untouched);
  });

  it('keeps a player action and its broadcast inside one session', async () => {
    const { a, b } = await two();
    const inA = change(a, 'Ada');
    const inB = change(b, 'Bo');
    const untouched = b.session.getState();
    inA.who.take();
    inB.who.take();

    send(a.room, inA.who, { type: 'action', intent: { type: 'PLAYER_READY' } }, 500);
    expect(inA.who.take().length).toBeGreaterThan(0);
    expect(inB.who.take()).toEqual([]);
    expect(b.session.getState()).toBe(untouched);
  });
});

describe('deleting through a registry', () => {
  it('deletes a stored session that is not loaded, without loading it', async () => {
    const { registry, inner, calls, tokensMinted } = setup();
    await seed(inner, 'a');
    unwrap(await registry.delete('a'));
    expect(unwrap(await inner.load('a'))).toBeNull();
    expect(calls).toEqual({ save: 0, load: 0, delete: 1, close: 0 });
    expect(tokensMinted()).toBe(0);
    expect(registry.get('a')).toBeUndefined();
  });

  it('treats a session that is not stored as the lifecycle does', async () => {
    const { registry } = setup();
    const expected = await createPersistentSessions(new InMemorySessionStore()).delete('nothing');
    expect(await registry.delete('nothing')).toEqual(expected);
    expect(codeOf(await registry.delete(''))).toBe('INVALID_SESSION_ID');
  });

  it('refuses a loaded session and deletes nothing', async () => {
    const { registry, inner, calls } = setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const refused = await registry.delete('a');
    expect(codeOf(refused)).toBe('SESSION_LOADED');
    expect(calls.delete).toBe(0);
    expect(unwrap(await inner.load('a'))).not.toBeNull();
    expect(registry.get('a')).toBe(handle);
    // The live session is untouched and still saves.
    change(handle);
    unwrap(await handle.save());
    expect(await storedNames(inner, 'a')).toEqual(['Ada']);
  });

  it('changes nothing when the store cannot delete', async () => {
    const { registry, inner, failing } = setup();
    await seed(inner, 'a');
    const other = unwrap(await registry.create(createCommand('b'), at(0)));
    failing.delete.add('a');
    expect(codeOf(await registry.delete('a'))).toBe('STORAGE_ERROR');
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBe(other);
    // The id was not left reserved: it can be loaded, or deleted again.
    failing.delete.clear();
    expect(unwrap(await registry.load('a')).session.id).toBe('a');
  });

  it('deletes after the session is unloaded, and the id can be created again', async () => {
    const { registry, inner } = setup();
    const first = unwrap(await registry.create(createCommand('a'), at(0)));
    change(first);
    await first.close();
    expect(registry.get('a')).toBeUndefined();

    unwrap(await registry.delete('a'));
    expect(unwrap(await inner.load('a'))).toBeNull();
    expect(codeOf(await registry.load('a'))).toBe('SESSION_NOT_FOUND');

    const second = unwrap(await registry.create(createCommand('a'), at(0)));
    expect(second).not.toBe(first);
    expect(names(second)).toEqual([]);
  });

  it('does not let an unloaded handle write the snapshot back', async () => {
    const { registry, inner, calls } = setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    change(handle);
    await handle.close();
    unwrap(await registry.delete('a'));
    const saves = calls.save;

    expect(codeOf(await handle.save())).toBe('STORAGE_ERROR');
    expect(calls.save).toBe(saves);
    expect(unwrap(await inner.load('a'))).toBeNull();
    expect(handle.hasUnsavedChanges()).toBe(true);
  });

  it('refuses the delete when a load of the same id came first', async () => {
    const { registry, inner, calls, hold, finish } = setup();
    await seed(inner, 'a');
    hold('load');
    const loading = registry.load('a');
    const deleting = registry.delete('a');
    await settle();
    expect(calls.delete).toBe(0);

    finish('a');
    const handle = unwrap(await loading);
    expect(codeOf(await deleting)).toBe('SESSION_LOADED');
    expect(calls.delete).toBe(0);
    expect(registry.get('a')).toBe(handle);
    expect(unwrap(await inner.load('a'))).not.toBeNull();
  });

  it('finds nothing to load when a delete of the same id came first', async () => {
    const { registry, inner, calls, hold, finish } = setup();
    await seed(inner, 'a');
    hold('delete');
    const deleting = registry.delete('a');
    const loading = registry.load('a');
    await settle();
    // The load has not reached the store: it waits for the delete.
    expect(calls.load).toBe(0);

    finish('a');
    unwrap(await deleting);
    expect(codeOf(await loading)).toBe('SESSION_NOT_FOUND');
    expect(registry.get('a')).toBeUndefined();
  });

  it('waits for a session that is being unloaded, then deletes what it saved', async () => {
    const { registry, inner, calls, hold, finish } = setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    change(handle);
    hold('save');
    const stopping = handle.shutdown();
    const deleting = registry.delete('a');
    await settle();
    // Neither loaded nor free: the final save is still at the store.
    expect(registry.get('a')).toBeUndefined();
    expect(calls.delete).toBe(0);

    finish('a');
    unwrap(await stopping);
    unwrap(await deleting);
    expect(unwrap(await inner.load('a'))).toBeNull();
  });
});

describe('unloading one session', () => {
  async function three() {
    const backing = setup();
    const a = unwrap(await backing.registry.create(createCommand('a'), at(0)));
    const b = unwrap(await backing.registry.create(createCommand('b'), at(0)));
    backing.saved.length = 0;
    return { ...backing, a, b };
  }

  it('shutdown saves that session only and leaves the others and the store alone', async () => {
    const { registry, inner, calls, saved, a, b } = await three();
    change(a, 'Ada');
    change(b, 'Bo');

    unwrap(await a.shutdown());
    expect(saved.map((snapshot) => snapshot.sessionId)).toEqual(['a']);
    expect(calls.close).toBe(0);
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBe(b);

    // B is still loaded, still dirty, and still saves to the open store.
    expect(b.hasUnsavedChanges()).toBe(true);
    unwrap(await b.save());
    expect(await storedNames(inner, 'b')).toEqual(['Bo']);
    expect(unwrap(await registry.create(createCommand('c'), at(0))).session.id).toBe('c');
  });

  it('shutdown of a session with nothing unsaved saves nothing', async () => {
    const { registry, calls, saved, a } = await three();
    unwrap(await a.shutdown());
    expect(saved).toEqual([]);
    expect(calls.close).toBe(0);
    expect(registry.get('a')).toBeUndefined();
  });

  it('close discards unsaved changes and does not close the store', async () => {
    const { registry, calls, saved, a, b } = await three();
    change(a);
    await a.close();
    expect(saved).toEqual([]);
    expect(calls.close).toBe(0);
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBe(b);
    expect(names(unwrap(await registry.load('a')))).toEqual([]);
  });

  it('is done once: again, or the other way, does nothing more', async () => {
    const { registry, saved, a } = await three();
    change(a);
    const first = a.shutdown();
    expect(a.shutdown()).toBe(first);
    unwrap(await first);
    await a.close();
    unwrap(await a.shutdown());
    expect(saved).toHaveLength(1);

    // A handle that has stopped cannot unload the session loaded after it.
    const again = unwrap(await registry.load('a'));
    await a.close();
    unwrap(await a.shutdown());
    expect(registry.get('a')).toBe(again);
  });

  it('holds the id until the final save is stored, so a load sees it', async () => {
    const { registry, calls, hold, finish, a } = await three();
    change(a);
    hold('save');
    const loads = calls.load;
    const stopping = a.shutdown();
    const loading = registry.load('a');
    await settle();
    expect(calls.load).toBe(loads);

    finish('a');
    unwrap(await stopping);
    const reloaded = unwrap(await loading);
    expect(reloaded).not.toBe(a);
    expect(names(reloaded)).toEqual(['Ada']);
  });

  it('returns a failed final save and still unloads', async () => {
    const { registry, failing, calls, a } = await three();
    change(a);
    failing.save.add('a');
    expect(codeOf(await a.shutdown())).toBe('STORAGE_ERROR');
    expect(a.hasUnsavedChanges()).toBe(true);
    expect(registry.get('a')).toBeUndefined();
    expect(calls.close).toBe(0);
  });
});

describe('shutting a registry down', () => {
  async function loaded(ids: string[]) {
    const backing = setup();
    const handles: SessionHandle[] = [];
    for (const id of ids) {
      handles.push(unwrap(await backing.registry.create(createCommand(id), at(0))));
    }
    backing.saved.length = 0;
    backing.events.length = 0;
    return { ...backing, handles };
  }

  it('saves every session with unsaved changes, and no other, then closes the store', async () => {
    const { registry, inner, saved, events, calls, handles } = await loaded(['a', 'b', 'c']);
    change(handles[0] as SessionHandle, 'Ada');
    change(handles[2] as SessionHandle, 'Cy');

    expect(await registry.shutdown()).toEqual({ ok: true, value: undefined });
    expect(saved.map((snapshot) => snapshot.sessionId).sort()).toEqual(['a', 'c']);
    expect(await storedNames(inner, 'a')).toEqual(['Ada']);
    expect(await storedNames(inner, 'c')).toEqual(['Cy']);
    // The store is closed once, after every save has finished.
    expect(calls.close).toBe(1);
    expect(events.at(-1)).toBe('store.close');
    expect(events.filter((event) => event.endsWith(':end'))).toHaveLength(2);
    for (const id of ['a', 'b', 'c']) expect(registry.get(id)).toBeUndefined();
    for (const handle of handles) expect(handle.hasUnsavedChanges()).toBe(false);
  });

  it('saves the sessions together, each through its own saves', async () => {
    const { registry, held, hold, events, handles } = await loaded(['a', 'b', 'c']);
    for (const handle of handles) change(handle);
    hold('save');
    const stopping = registry.shutdown();
    await settle();
    expect(held.map((call) => call.sessionId).sort()).toEqual(['a', 'b', 'c']);
    expect(events).not.toContain('store.close');

    // The store stays open until the last of them has finished.
    held[0]?.finish();
    held[0]?.finish();
    await settle();
    expect(events).not.toContain('store.close');
    held[0]?.finish();
    unwrap(await stopping);
    expect(events.at(-1)).toBe('store.close');
  });

  it('attempts every session when one cannot be saved, and still closes the store', async () => {
    const { registry, inner, failing, calls, handles } = await loaded(['a', 'b', 'c']);
    for (const handle of handles) change(handle);
    failing.save.add('a');

    const result = await registry.shutdown();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SHUTDOWN_INCOMPLETE');
    expect(result.error.storeClosed).toBe(true);
    expect(result.error.failures.map((failure) => [failure.sessionId, failure.error.code])).toEqual(
      [['a', 'STORAGE_ERROR']],
    );
    expect(await storedNames(inner, 'b')).toEqual(['Ada']);
    expect(await storedNames(inner, 'c')).toEqual(['Ada']);
    expect(await storedNames(inner, 'a')).toEqual([]);
    expect(calls.close).toBe(1);
    expect((handles[0] as SessionHandle).hasUnsavedChanges()).toBe(true);
  });

  it('reports a store that will not close, along with any session that was not saved', async () => {
    const { registry, failing, control, calls, handles } = await loaded(['a', 'b']);
    for (const handle of handles) change(handle);
    failing.save.add('b');
    control.failClose = true;

    const result = await registry.shutdown();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.storeClosed).toBe(false);
    expect(result.error.failures.map((failure) => failure.sessionId)).toEqual(['b']);
    expect(JSON.stringify(result.error)).not.toContain('would not close');
    expect(calls.close).toBe(1);
  });

  it('runs once however often it is called', async () => {
    const { registry, calls, saved, handles } = await loaded(['a']);
    change(handles[0] as SessionHandle);
    const first = registry.shutdown();
    const second = registry.shutdown();
    expect(second).toBe(first);
    unwrap(await first);
    expect(registry.shutdown()).toBe(first);
    unwrap(await registry.shutdown());
    expect(calls.close).toBe(1);
    expect(saved).toHaveLength(1);
  });

  it('refuses create, load and delete from the moment it begins', async () => {
    const { registry, inner, calls, hold, finish, handles } = await loaded(['a']);
    await seed(inner, 'stored');
    change(handles[0] as SessionHandle);
    hold('save');
    const stopping = registry.shutdown();
    await settle();
    const before = { ...calls };

    expect(codeOf(await registry.create(createCommand('new'), at(0)))).toBe('REGISTRY_CLOSED');
    expect(codeOf(await registry.load('stored'))).toBe('REGISTRY_CLOSED');
    expect(codeOf(await registry.load('a'))).toBe('REGISTRY_CLOSED');
    expect(codeOf(await registry.delete('stored'))).toBe('REGISTRY_CLOSED');
    expect(calls).toEqual(before);

    finish('a');
    unwrap(await stopping);
    // It does not reopen.
    expect(codeOf(await registry.create(createCommand('new'), at(0)))).toBe('REGISTRY_CLOSED');
    expect(codeOf(await registry.load('stored'))).toBe('REGISTRY_CLOSED');
    expect(unwrap(await inner.load('stored'))).not.toBeNull();
    expect(unwrap(await inner.load('new'))).toBeNull();
  });

  it('waits for a save that is already under way, and saves nothing twice', async () => {
    const { registry, held, hold, finish, events, saved, handles } = await loaded(['a']);
    const handle = handles[0] as SessionHandle;
    change(handle);
    hold('save');
    const saving = handle.save();
    const stopping = registry.shutdown();
    await settle();
    expect(held).toHaveLength(1);
    expect(events).not.toContain('store.close');

    finish('a');
    unwrap(await saving);
    unwrap(await stopping);
    expect(saved).toHaveLength(1);
    expect(events.at(-1)).toBe('store.close');
  });

  it('waits for a creation that is already under way, and shuts that session down too', async () => {
    const { registry, hold, finish, events, calls } = await loaded(['a']);
    hold('save');
    const creating = registry.create(createCommand('late'), at(0));
    await settle();
    const stopping = registry.shutdown();
    await settle();
    expect(events).not.toContain('store.close');
    expect(await isSettled(stopping)).toBe(false);

    finish('late');
    const handle = unwrap(await creating);
    unwrap(await stopping);
    expect(events.at(-1)).toBe('store.close');
    expect(events.indexOf('save:late:end')).toBeLessThan(events.indexOf('store.close'));
    expect(calls.close).toBe(1);
    // It was unloaded with the rest: stopping it again does nothing.
    expect(registry.get('late')).toBeUndefined();
    unwrap(await handle.shutdown());
    expect(codeOf(await handle.save())).toBe('STORAGE_ERROR');
  });

  it('leaves nothing behind when a creation under way fails', async () => {
    const { registry, hold, finish, calls, tokensMinted } = await loaded([]);
    hold('save');
    const creating = registry.create(createCommand('late'), at(0));
    await settle();
    const stopping = registry.shutdown();
    await settle();
    finish('late', 'fail');
    expect(codeOf(await creating)).toBe('STORAGE_ERROR');
    unwrap(await stopping);
    expect(registry.get('late')).toBeUndefined();
    expect(tokensMinted()).toBe(0);
    expect(calls.close).toBe(1);
  });

  it('waits for a load that is already under way, and shuts that session down too', async () => {
    const { registry, inner, hold, finish, events } = await loaded([]);
    await seed(inner, 'a');
    hold('load');
    const loading = registry.load('a');
    await settle();
    const stopping = registry.shutdown();
    const joining = registry.load('a');
    await settle();
    expect(events).not.toContain('store.close');
    expect(codeOf(await joining)).toBe('REGISTRY_CLOSED');

    finish('a');
    const handle = unwrap(await loading);
    unwrap(await stopping);
    expect(events.at(-1)).toBe('store.close');
    expect(registry.get('a')).toBeUndefined();
    expect(handle.shutdown()).toBe(handle.shutdown());
    unwrap(await handle.shutdown());
  });

  it('waits for a session its own caller is already shutting down', async () => {
    const { registry, hold, finish, events, saved, handles } = await loaded(['a']);
    const handle = handles[0] as SessionHandle;
    change(handle);
    hold('save');
    const own = handle.shutdown();
    const stopping = registry.shutdown();
    await settle();
    expect(events).not.toContain('store.close');

    finish('a');
    unwrap(await own);
    unwrap(await stopping);
    expect(saved).toHaveLength(1);
    expect(events.at(-1)).toBe('store.close');
  });

  it('works with a store that has nothing to close', async () => {
    const inner = new InMemorySessionStore();
    const registry = createSessionRegistry({ store: inner });
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    change(handle);
    unwrap(await registry.shutdown());
    expect(await storedNames(inner, 'a')).toEqual(['Ada']);
  });

  it('starts no timer and saves nothing until it is asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { registry, saved, handles } = await loaded(['a', 'b']);
      for (const handle of handles) change(handle);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(saved).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      unwrap(await registry.shutdown());
      expect(vi.getTimerCount()).toBe(0);
      expect(saved).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the registry stays inside its boundary', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const read = (name: string): string =>
    readFileSync(joinPath(directory, name), 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const registry = read('session-registry.ts');
  const handle = read('session-handle.ts');

  it('never reads or changes a game', () => {
    expect(registry).not.toMatch(/getState|applyCommand|submitAction|advanceTime|\.snapshot\(/);
    expect(registry).not.toMatch(/GameState/);
  });

  it('uses the store only through the lifecycle, and closes it in one place', () => {
    expect(registry.match(/store\./g)).toEqual(['store.']);
    expect(registry).toContain('await store.close?.();');
    expect(registry).not.toMatch(/mongodb|MongoClient|createMongoSessionStore/i);
    // A handle has no store at all, so it has none to close.
    expect(handle).not.toMatch(/\bstore\b|SessionStore/);
  });

  it('keeps one table per registry and no state at module level', () => {
    expect(registry.match(/new Map/g)).toHaveLength(1);
    for (const code of [registry, handle]) {
      const topLevel = code
        .split('\n')
        .filter((line) => /^(export )?(let|var|const)\s/.test(line) && !/=>|= async/.test(line));
      expect(topLevel).toEqual([]);
      expect(code).not.toMatch(/setTimeout|setInterval|setImmediate|retry|autosave|redis/i);
    }
  });

  it('adds no listener and no protocol of its own', () => {
    expect(registry).not.toMatch(/createRealtimeServer|WebSocket|joinCode|createRoom/);
    expect(handle).not.toMatch(/createRealtimeServer|WebSocket|joinCode/);
  });
});
