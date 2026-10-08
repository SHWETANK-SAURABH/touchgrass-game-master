import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Result, err } from '@touchgrass/shared';
import type { GameSessionSnapshot } from '@touchgrass/game-session';
import { InMemorySessionStore, type SessionStoreError } from '@touchgrass/session-store';
import {
  type ClosableSessionStore,
  type PersistentServer,
  startPersistentServer,
} from './persistent-server';
import { codeOf, connection, createCommand, join, testClock, unwrap } from './test-support';

const STORAGE_ERROR: SessionStoreError = {
  code: 'STORAGE_ERROR',
  message: 'The database is away.',
};

/** One write the store has been asked for and has not finished. */
interface Write {
  readonly snapshot: GameSessionSnapshot;
  /** Lets the write finish: stored for real, or failed. */
  finish(outcome?: 'ok' | 'fail'): void;
}

/**
 * A store whose writes finish only when the test says so.
 *
 * Nothing here waits on a clock. A test starts saves, looks at which writes
 * have reached the store, and finishes them one by one, so what it proves does
 * not depend on timing.
 */
function manualStore() {
  const inner = new InMemorySessionStore();
  const events: string[] = [];
  const writes: Write[] = [];
  const pending: Write[] = [];
  const counts = { inFlight: 0, mostInFlight: 0 };
  let manual = false;
  let closed = false;

  const store: ClosableSessionStore = {
    save(snapshot): Promise<Result<void, SessionStoreError>> {
      counts.inFlight += 1;
      counts.mostInFlight = Math.max(counts.mostInFlight, counts.inFlight);
      events.push('save:start');
      const done = (result: Result<void, SessionStoreError>) => {
        counts.inFlight -= 1;
        events.push(result.ok ? 'save:end' : 'save:failed');
        return result;
      };
      if (closed) return Promise.resolve(done(err(STORAGE_ERROR)));
      if (!manual) return inner.save(snapshot).then(done);

      return new Promise((resolve) => {
        const write: Write = {
          snapshot,
          finish(outcome = 'ok') {
            pending.splice(pending.indexOf(write), 1);
            if (outcome === 'fail') resolve(done(err(STORAGE_ERROR)));
            else void inner.save(snapshot).then((result) => resolve(done(result)));
          },
        };
        writes.push(write);
        pending.push(write);
      });
    },
    load: (sessionId) => inner.load(sessionId),
    delete: (sessionId) => inner.delete(sessionId),
    close() {
      events.push('store.close');
      closed = true;
      return Promise.resolve();
    },
  };

  return {
    store,
    inner,
    events,
    /** Every write requested since `hold()`, finished or not. */
    writes,
    /** Writes that have reached the store and not finished. */
    pending,
    counts,
    /** From now on, writes wait to be finished by the test. */
    hold(): void {
      manual = true;
    },
  };
}

/** Lets everything that is ready to run, run. No clock is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const names = (snapshot: GameSessionSnapshot | undefined): string[] =>
  (snapshot?.state.players ?? []).map((player) => player.displayName);

let open: PersistentServer[] = [];
let stores: ReturnType<typeof manualStore>[] = [];

/** A new game on a manual store, already holding writes. */
async function started() {
  const backing = manualStore();
  const server = unwrap(
    await startPersistentServer({
      store: backing.store,
      port: 0,
      clock: testClock(),
      game: { create: createCommand() },
    }),
  );
  open.push(server);
  stores.push(backing);
  backing.events.length = 0;
  backing.counts.mostInFlight = 0;
  backing.hold();
  return { server, ...backing };
}

const add = (server: PersistentServer, name: string): void => {
  join(server.room, connection(), name);
};

afterEach(async () => {
  // Finish anything a test left unfinished, so nothing is left waiting.
  for (const backing of stores) for (const write of [...backing.pending]) write.finish();
  await settle();
  await Promise.all(open.map((server) => server.close().catch(() => undefined)));
  for (const backing of stores) for (const write of [...backing.pending]) write.finish();
  open = [];
  stores = [];
});

describe('overlapping saves', () => {
  it('never has two writes at the store at once', async () => {
    const { server, writes, pending, counts } = await started();
    add(server, 'Ada');

    const first = server.save();
    const second = server.save();
    const third = server.save();
    await settle();

    // Three saves were asked for. One write has reached the store.
    expect(writes).toHaveLength(1);
    expect(pending).toHaveLength(1);

    writes[0]?.finish();
    await settle();
    expect(writes).toHaveLength(2);
    expect(pending).toHaveLength(1);

    writes[1]?.finish();
    await settle();
    expect(writes).toHaveLength(3);
    writes[2]?.finish();

    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    expect(counts.mostInFlight).toBe(1);
  });

  it('runs them in the order they were asked for', async () => {
    const { server, writes, events } = await started();
    add(server, 'Ada');
    const order: string[] = [];

    const first = server.save().then(() => order.push('first'));
    const second = server.save().then(() => order.push('second'));
    const third = server.save().then(() => order.push('third'));

    for (let index = 0; index < 3; index += 1) {
      await settle();
      writes[index]?.finish();
    }
    await Promise.all([first, second, third]);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(events).toEqual([
      'save:start',
      'save:end',
      'save:start',
      'save:end',
      'save:start',
      'save:end',
    ]);
  });

  it('saves the game as it is when a waiting save starts, not as it was when asked', async () => {
    const { server, writes, inner } = await started();
    add(server, 'Ada'); // state B

    const first = server.save(); // starts at once, with B
    const second = server.save(); // asked for while the game is still B
    expect(names(writes[0]?.snapshot)).toEqual(['Ada']);

    // The game moves on to C while the first save is at the store.
    add(server, 'Grace');
    await settle();
    expect(writes).toHaveLength(1);

    writes[0]?.finish();
    await settle();

    // The second save starts now, and takes the game as it is now: C.
    expect(writes).toHaveLength(2);
    expect(names(writes[1]?.snapshot)).toEqual(['Ada', 'Grace']);
    expect(writes[1]?.snapshot.state).toBe(server.session.getState());

    writes[1]?.finish();
    unwrap(await first);
    unwrap(await second);
    expect(names(unwrap(await inner.load('g1')) ?? undefined)).toEqual(['Ada', 'Grace']);
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('leaves the latest state stored and nothing unsaved after two successful saves', async () => {
    const { server, writes, inner } = await started();
    add(server, 'Ada');
    const first = server.save();
    add(server, 'Grace');
    const second = server.save();

    await settle();
    writes[0]?.finish();
    await settle();
    writes[1]?.finish();
    unwrap(await first);
    unwrap(await second);

    expect(unwrap(await inner.load('g1'))).toEqual(server.session.snapshot());
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('gives each caller its own result, and a failed save does not hold up the next', async () => {
    const { server, writes, inner, events } = await started();
    add(server, 'Ada');
    const first = server.save();
    add(server, 'Grace');
    const second = server.save();
    const third = server.save();

    await settle();
    writes[0]?.finish('fail');
    await settle();
    // The failure did not stop the next save from starting.
    expect(writes).toHaveLength(2);
    expect(codeOf(await first)).toBe('STORAGE_ERROR');
    // Nothing was marked as saved by the failure.
    expect(server.hasUnsavedChanges()).toBe(true);

    writes[1]?.finish();
    await settle();
    writes[2]?.finish('fail');

    expect(await second).toEqual({ ok: true, value: undefined });
    expect(codeOf(await third)).toBe('STORAGE_ERROR');
    expect(events).toEqual([
      'save:start',
      'save:failed',
      'save:start',
      'save:end',
      'save:start',
      'save:failed',
    ]);
    // The one that succeeded stored the latest state, and that is what counts.
    expect(names(unwrap(await inner.load('g1')) ?? undefined)).toEqual(['Ada', 'Grace']);
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('keeps working after every save in a row has failed', async () => {
    const { server, writes } = await started();
    add(server, 'Ada');
    const failures = [server.save(), server.save(), server.save()];
    for (let index = 0; index < 3; index += 1) {
      await settle();
      writes[index]?.finish('fail');
    }
    for (const failed of failures) expect(codeOf(await failed)).toBe('STORAGE_ERROR');
    expect(server.hasUnsavedChanges()).toBe(true);

    const later = server.save();
    await settle();
    expect(writes).toHaveLength(4);
    writes[3]?.finish();
    expect(await later).toEqual({ ok: true, value: undefined });
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('still reports unsaved changes when the game moves on during the only save in flight', async () => {
    // The Phase 5J case, unchanged: one save, one change while it is at the store.
    const { server, writes, inner } = await started();
    add(server, 'Ada'); // B
    const stateB = server.session.getState();

    const saving = server.save();
    expect(writes[0]?.snapshot.state).toBe(stateB);
    add(server, 'Grace'); // C
    writes[0]?.finish();
    unwrap(await saving);

    expect(names(unwrap(await inner.load('g1')) ?? undefined)).toEqual(['Ada']);
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('starts a save at once when none is pending, exactly as before', async () => {
    const { server, writes } = await started();
    add(server, 'Ada');

    const first = server.save();
    // No waiting: the write reached the store before save() returned.
    expect(writes).toHaveLength(1);
    writes[0]?.finish();
    unwrap(await first);
    await settle();

    // And again once that one is done.
    const second = server.save();
    expect(writes).toHaveLength(2);
    writes[1]?.finish();
    unwrap(await second);
  });

  it('orders the saves of one server only: two servers do not wait for each other', async () => {
    const one = await started();
    const backing = manualStore();
    const two = unwrap(
      await startPersistentServer({
        store: backing.store,
        port: 0,
        clock: testClock(),
        game: { create: createCommand('other') },
      }),
    );
    open.push(two);
    stores.push(backing);
    backing.hold();

    add(one.server, 'Ada');
    void one.server.save();
    void two.save();
    await settle();

    expect(one.writes).toHaveLength(1);
    expect(backing.writes).toHaveLength(1);
  });
});

describe('shutdown and saves that are already under way', () => {
  it('waits for a save in flight, then saves again because the game changed since', async () => {
    const { server, writes, events, inner } = await started();
    add(server, 'Ada'); // B
    const explicit = server.save(); // B is at the store
    add(server, 'Grace'); // C

    const stopping = server.shutdown();
    await settle();

    // Shutdown is waiting. No second write, and the store is still open.
    expect(writes).toHaveLength(1);
    expect(events).toEqual(['save:start']);

    writes[0]?.finish();
    await settle();

    // Now it has decided: C is unsaved, so one more save, of C.
    expect(writes).toHaveLength(2);
    expect(names(writes[1]?.snapshot)).toEqual(['Ada', 'Grace']);
    expect(events).not.toContain('store.close');

    writes[1]?.finish();
    expect(await stopping).toEqual({ ok: true, value: undefined });
    unwrap(await explicit);

    expect(events).toEqual(['save:start', 'save:end', 'save:start', 'save:end', 'store.close']);
    expect(names(unwrap(await inner.load('g1')) ?? undefined)).toEqual(['Ada', 'Grace']);
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('does not save again when the save in flight already stored the current state', async () => {
    const { server, writes, events } = await started();
    add(server, 'Ada');
    const explicit = server.save();

    const stopping = server.shutdown();
    await settle();
    expect(events).toEqual(['save:start']);

    writes[0]?.finish();
    expect(await stopping).toEqual({ ok: true, value: undefined });
    unwrap(await explicit);

    // One write in total. The store closed after it, not during it.
    expect(writes).toHaveLength(1);
    expect(events).toEqual(['save:start', 'save:end', 'store.close']);
    expect(server.hasUnsavedChanges()).toBe(false);
  });

  it('saves on the way out when the save in flight fails', async () => {
    const { server, writes, events, inner } = await started();
    add(server, 'Ada');
    const explicit = server.save();
    const stopping = server.shutdown();

    await settle();
    writes[0]?.finish('fail');
    await settle();

    // The explicit save failed, so the game is still unsaved: shutdown saves it.
    expect(codeOf(await explicit)).toBe('STORAGE_ERROR');
    expect(writes).toHaveLength(2);
    writes[1]?.finish();

    expect(await stopping).toEqual({ ok: true, value: undefined });
    expect(events).toEqual(['save:start', 'save:failed', 'save:start', 'save:end', 'store.close']);
    expect(names(unwrap(await inner.load('g1')) ?? undefined)).toEqual(['Ada']);
  });

  it('waits for every save that was queued, not only the one at the store', async () => {
    const { server, writes, events } = await started();
    add(server, 'Ada');
    const saves = [server.save(), server.save(), server.save()];
    const stopping = server.shutdown();

    for (let index = 0; index < 3; index += 1) {
      await settle();
      expect(events).not.toContain('store.close');
      writes[index]?.finish();
    }
    expect(await stopping).toEqual({ ok: true, value: undefined });
    await Promise.all(saves);

    // Three explicit saves, no fourth: the last of them stored the current state.
    expect(writes).toHaveLength(3);
    expect(events.at(-1)).toBe('store.close');
    expect(events.filter((event) => event === 'store.close')).toHaveLength(1);
  });

  it('returns the failure of its own final save, and still closes the store after it', async () => {
    const { server, writes, events } = await started();
    add(server, 'Ada');
    const explicit = server.save();
    add(server, 'Grace');
    const stopping = server.shutdown();

    await settle();
    writes[0]?.finish();
    await settle();
    writes[1]?.finish('fail');

    expect(codeOf(await stopping)).toBe('STORAGE_ERROR');
    unwrap(await explicit);
    expect(events).toEqual(['save:start', 'save:end', 'save:start', 'save:failed', 'store.close']);
    expect(server.hasUnsavedChanges()).toBe(true);
  });

  it('runs one shutdown for two overlapping calls, even with a save in flight', async () => {
    const { server, writes, events } = await started();
    add(server, 'Ada');
    void server.save();
    add(server, 'Grace');

    const first = server.shutdown();
    const second = server.shutdown();
    await settle();
    writes[0]?.finish();
    await settle();
    writes[1]?.finish();

    expect(await first).toEqual(await second);
    expect(writes).toHaveLength(2);
    expect(events.filter((event) => event === 'store.close')).toHaveLength(1);
  });

  it('does not close the store under a save that was asked for during the final save', async () => {
    const { server, writes, events } = await started();
    add(server, 'Ada');
    const stopping = server.shutdown();
    await settle();
    // The final save is at the store. Something asks for one more.
    expect(writes).toHaveLength(1);
    const late = server.save();

    writes[0]?.finish();
    await settle();
    expect(writes).toHaveLength(2);
    expect(events).not.toContain('store.close');

    writes[1]?.finish();
    expect(await stopping).toEqual({ ok: true, value: undefined });
    unwrap(await late);
    expect(events).toEqual(['save:start', 'save:end', 'save:start', 'save:end', 'store.close']);
  });
});

describe('close and saves that are already under way', () => {
  it('waits for a save in flight before closing the store, and still does not save', async () => {
    const { server, writes, events, inner } = await started();
    add(server, 'Ada');
    const explicit = server.save();
    add(server, 'Grace'); // never saved

    const closing = server.close();
    await settle();
    expect(events).toEqual(['save:start']);

    writes[0]?.finish();
    await closing;
    unwrap(await explicit);

    // The save that was asked for finished. close() added none of its own.
    expect(writes).toHaveLength(1);
    expect(events).toEqual(['save:start', 'save:end', 'store.close']);
    expect(names(unwrap(await inner.load('g1')) ?? undefined)).toEqual(['Ada']);
    expect(server.hasUnsavedChanges()).toBe(true);
  });
});

describe('serialising saves adds nothing else', () => {
  it('starts no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const { server, writes } = await started();
      add(server, 'Ada');
      const saves = [server.save(), server.save()];
      expect(vi.getTimerCount()).toBe(0);
      await settle();
      writes[0]?.finish();
      await settle();
      writes[1]?.finish();
      await Promise.all(saves);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores what it always stored: a snapshot, written whole, once per save', async () => {
    const { server, writes } = await started();
    add(server, 'Ada');
    const first = server.save();
    const second = server.save();
    await settle();
    writes[0]?.finish();
    await settle();
    writes[1]?.finish();
    await Promise.all([first, second]);

    for (const write of writes) {
      expect(Object.keys(write.snapshot).sort()).toEqual(['sessionId', 'state', 'version']);
      expect(JSON.stringify(write.snapshot)).not.toMatch(/revision|pending|queue|lastSaved/i);
    }
  });

  it('lives in the server handle: no lower layer orders saves, and nothing is retried or timed', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const read = (path: string): string =>
      readFileSync(path, 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const server = read(joinPath(directory, 'session-handle.ts'));

    // The state is captured inside the one function that performs a save, after
    // any waiting, and the marker is set from that captured state only.
    expect(server.match(/const stateBeingSaved = hosted\.session\.getState\(\);/g)).toHaveLength(1);
    expect(server).toContain('if (saved.ok) lastSavedState = stateBeingSaved;');
    expect(server.match(/lastSavedState = /g)).toHaveLength(1);
    expect(server).toContain('pendingSaves ? pendingSaves.then(saveNow) : saveNow()');
    expect(server).not.toMatch(
      /setTimeout|setInterval|retry|revision|compareAndSet|findOneAndUpdate/i,
    );

    const root = joinPath(directory, '..', '..');
    for (const [folder, file] of [
      ['session-persistence', 'lifecycle.ts'],
      ['session-store', 'store.ts'],
      ['session-store', 'in-memory.ts'],
      ['session-store', 'mongodb.ts'],
      ['game-session', 'session.ts'],
    ] as const) {
      expect(read(joinPath(root, folder, 'src', file)), `${folder}/${file}`).not.toMatch(
        /pendingSaves|savesSettled|saveNow|revision/,
      );
    }
  });
});
