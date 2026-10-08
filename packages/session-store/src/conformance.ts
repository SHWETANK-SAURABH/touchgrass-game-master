import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGameSession, restoreGameSession } from '@touchgrass/game-session';
import type { SessionStore } from './store';
import {
  AWKWARD_PLAYER_IDS,
  at,
  awkwardSnapshot,
  session,
  snapshotOf,
  unwrap,
  writable,
} from './test-support';

/**
 * What every SessionStore must do, whatever it keeps snapshots in.
 *
 * Each implementation runs this same suite. It is the contract in executable
 * form: an adapter that passes it behaves, to a caller, like the in-memory
 * reference. Tests about how a particular store works inside belong in that
 * store's own test file.
 *
 * `open` returns a new, empty store. `close`, if given, is called after each
 * test with that store.
 */
export function describeSessionStore(
  name: string,
  open: () => SessionStore | Promise<SessionStore>,
  close?: (store: SessionStore) => void | Promise<void>,
): void {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await open();
    });
    afterEach(async () => {
      await close?.(store);
    });

    it('returns what was saved', async () => {
      const snapshot = snapshotOf('g1', { ready: true });
      expect(await store.save(snapshot)).toEqual({ ok: true, value: undefined });

      const loaded = unwrap(await store.load('g1'));
      expect(loaded).toEqual(snapshot);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(snapshot));
      expect(Object.keys(loaded ?? {}).sort()).toEqual(['sessionId', 'state', 'version']);
    });

    it('preserves the state and its history exactly', async () => {
      const game = session('g1', { ready: true });
      unwrap(game.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(5_000)));
      unwrap(game.applyCommand({ type: 'RESUME_SESSION' }, at(9_000)));
      const snapshot = game.snapshot();
      await store.save(snapshot);

      const loaded = unwrap(await store.load('g1'));
      expect(loaded?.version).toBe(snapshot.version);
      expect(loaded?.sessionId).toBe('g1');
      expect(loaded?.state).toEqual(snapshot.state);
      expect(loaded?.state.history).toEqual(snapshot.state.history);
      // Large whole numbers, nulls, empty arrays and key order all come back as they went in.
      expect(loaded?.state.createdAt).toBe(snapshot.state.createdAt);
      expect(loaded?.state.endedAt).toBeNull();
      expect(loaded?.state.winnerIds).toEqual([]);
      expect(Object.keys(loaded?.state ?? {})).toEqual(Object.keys(snapshot.state));
    });

    it('gives back a snapshot a session can be restored from', async () => {
      const original = session('g1', { ready: true });
      await store.save(original.snapshot());
      const restored = unwrap(restoreGameSession(unwrap(await store.load('g1'))));
      expect(restored.getState()).toEqual(original.getState());
      unwrap(restored.applyCommand({ type: 'PAUSE_SESSION', reason: 'water' }, at(5_000)));
      // Playing the restored session does not save it.
      expect(unwrap(await store.load('g1'))?.state.status).toBe('active');
    });

    it('returns null for a session that was never saved', async () => {
      expect(await store.load('g1')).toEqual({ ok: true, value: null });
      await store.save(snapshotOf('g1'));
      expect(await store.load('g2')).toEqual({ ok: true, value: null });
    });

    it('replaces the snapshot stored for the same session id', async () => {
      const game = session('g1');
      const before = game.snapshot();
      await store.save(before);
      unwrap(game.submitAction('p0', { type: 'PLAYER_READY' }, at(1_000)));
      unwrap(game.submitAction('p1', { type: 'PLAYER_READY' }, at(1_000)));
      const after = game.snapshot();
      await store.save(after);

      const loaded = unwrap(await store.load('g1'));
      expect(loaded).toEqual(after);
      expect(loaded).not.toEqual(before);

      // One snapshot per session: a single delete removes it.
      await store.delete('g1');
      expect(await store.load('g1')).toEqual({ ok: true, value: null });
    });

    it('deletes a stored snapshot, and can save the same id again', async () => {
      const snapshot = snapshotOf('g1');
      await store.save(snapshot);
      expect(await store.delete('g1')).toEqual({ ok: true, value: undefined });
      expect(await store.load('g1')).toEqual({ ok: true, value: null });
      await store.save(snapshot);
      expect(unwrap(await store.load('g1'))).toEqual(snapshot);
    });

    it('succeeds when deleting a session that is not there, and touches nothing else', async () => {
      const kept = snapshotOf('kept');
      await store.save(kept);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await store.delete('missing')).toEqual({ ok: true, value: undefined });
      }
      expect(unwrap(await store.load('kept'))).toEqual(kept);
    });

    it('keeps each session under its own id', async () => {
      const a = snapshotOf('a');
      const b = snapshotOf('b', { ready: true, gameId: 'hide-and-seek' });
      await store.save(a);
      await store.save(b);
      expect(unwrap(await store.load('a'))).toEqual(a);
      expect(unwrap(await store.load('b'))).toEqual(b);

      await store.delete('a');
      expect(await store.load('a')).toEqual({ ok: true, value: null });
      expect(unwrap(await store.load('b'))).toEqual(b);
    });

    it('treats ids as exact text', async () => {
      await store.save(snapshotOf('Game'));
      for (const other of ['game', 'Game ', ' Game', 'Gam', 'Game2']) {
        expect(await store.load(other)).toEqual({ ok: true, value: null });
      }
      await store.delete('game');
      expect(unwrap(await store.load('Game'))?.sessionId).toBe('Game');
    });

    it('keeps its own copy: changing the saved object afterwards changes nothing stored', async () => {
      const original = snapshotOf('g1', { ready: true });
      const mine = writable(original);
      await store.save(mine as never);

      mine.version = 99;
      mine.state.status = 'aborted';
      (mine.state.players[0] as { score: number }).score = 999;
      mine.state.players.length = 0;
      mine.state.history.length = 0;

      expect(unwrap(await store.load('g1'))).toEqual(original);
    });

    it('returns a separate, frozen copy on every load', async () => {
      const original = snapshotOf('g1', { ready: true });
      await store.save(original);

      const first = unwrap(await store.load('g1'));
      const second = unwrap(await store.load('g1'));
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first?.state).not.toBe(second?.state);
      expect(first?.state.players).not.toBe(second?.state.players);
      expect(first).not.toBe(original);

      const loaded = first as unknown as ReturnType<typeof writable>;
      const writes: (() => void)[] = [
        () => {
          loaded.sessionId = 'other';
        },
        () => {
          loaded.state.status = 'completed';
        },
        () => {
          (loaded.state.players[0] as { score: number }).score = 999;
        },
        () => {
          loaded.state.history.length = 0;
        },
      ];
      for (const write of writes) expect(write).toThrow(TypeError);
      expect(unwrap(await store.load('g1'))).toEqual(original);
    });

    it('accepts any non-empty string as a session id, as a session does', async () => {
      for (const id of ['g1', 'ses_0b0e7c1e-7d0f-4c59-8f1e-2f1d3a4b5c6d', ' ', 'game one', '0']) {
        const created = createGameSession(
          {
            type: 'CREATE_SESSION',
            sessionId: id,
            gameId: 'tag',
            joinCode: 'GRASS7',
            randomSeed: 7,
          },
          at(0),
        );
        await store.save(unwrap(created).snapshot());
        expect(unwrap(await store.load(id))?.sessionId).toBe(id);
        expect((await store.delete(id)).ok).toBe(true);
      }
    });

    it('refuses an invalid session id, and reads or writes nothing', async () => {
      const kept = snapshotOf('kept');
      await store.save(kept);
      const expected = {
        ok: false,
        error: { code: 'INVALID_SESSION_ID', message: 'A session id is a non-empty string.' },
      };
      for (const id of ['', undefined, null, 7, {}, ['g1']]) {
        expect(await store.load(id as never)).toEqual(expected);
        expect(await store.delete(id as never)).toEqual(expected);
        expect(await store.save({ ...writable(kept), sessionId: id } as never)).toEqual(expected);
      }
      for (const value of [null, undefined, 'g1', 7, {}]) {
        expect(await store.save(value as never)).toEqual(expected);
      }
      expect(unwrap(await store.load('kept'))).toEqual(kept);
    });

    it('reports a snapshot that cannot be serialised as STORAGE_ERROR, keeping what was there', async () => {
      const previous = snapshotOf('g1');
      await store.save(previous);
      const circular: Record<string, unknown> = { ...writable(previous) };
      circular.self = circular;

      expect(await store.save(circular as never)).toEqual({
        ok: false,
        error: { code: 'STORAGE_ERROR', message: 'The snapshot could not be serialised.' },
      });
      expect(unwrap(await store.load('g1'))).toEqual(previous);
    });

    it('does not judge the game: a malformed snapshot is kept, and refused on restore', async () => {
      const edited = writable(snapshotOf('g1'));
      edited.state.status = 'not-a-status';
      expect((await store.save(edited as never)).ok).toBe(true);

      const loaded = unwrap(await store.load('g1'));
      expect(loaded?.state.status).toBe('not-a-status');
      expect(restoreGameSession(loaded).ok).toBe(false);
    });

    it('preserves object keys that contain a dot or start with a dollar sign', async () => {
      // Ids are arbitrary strings, and player ids become keys in the history.
      const snapshot = awkwardSnapshot();
      const roles = snapshot.state.history.find((entry) => entry.record.kind === 'ROLES_ASSIGNED');
      if (roles?.record.kind !== 'ROLES_ASSIGNED') throw new Error('fixture failed');
      expect(Object.keys(roles.record.roles).sort()).toEqual([...AWKWARD_PLAYER_IDS].sort());

      expect(await store.save(snapshot)).toEqual({ ok: true, value: undefined });
      const loaded = unwrap(await store.load(snapshot.sessionId));

      // Exactly as saved: not escaped, renamed, nested or dropped.
      expect(loaded).toEqual(snapshot);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(snapshot));
      const loadedRoles = loaded?.state.history.find(
        (entry) => entry.record.kind === 'ROLES_ASSIGNED',
      );
      expect(loadedRoles?.record).toEqual(roles.record);
      expect(loaded?.state.players.map((player) => player.id)).toEqual([...AWKWARD_PLAYER_IDS]);

      // The session id has them too, and is still the exact key.
      expect(loaded?.sessionId).toBe('game.one$');
      expect(await store.load('game')).toEqual({ ok: true, value: null });
      expect(await store.load('game.one')).toEqual({ ok: true, value: null });

      // And the game it describes is still restorable and deletable.
      expect(restoreGameSession(loaded).ok).toBe(true);
      expect((await store.delete(snapshot.sessionId)).ok).toBe(true);
      expect(await store.load(snapshot.sessionId)).toEqual({ ok: true, value: null });
    });

    it('preserves such keys anywhere in the state, not only where a game puts them', async () => {
      const edited = writable(snapshotOf('g1')) as unknown as { state: Record<string, unknown> };
      edited.state['$top'] = { 'in.ner': [{ '$deep.er': 1 }], '': 'empty key', $: 2, '.': 3 };
      edited.state['a.b'] = null;
      expect((await store.save(edited as never)).ok).toBe(true);

      const loaded = unwrap(await store.load('g1'));
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(edited));
    });

    it('holds nothing of the transport', async () => {
      await store.save(snapshotOf('g1', { ready: true }));
      const text = JSON.stringify(unwrap(await store.load('g1')));
      expect(text).not.toMatch(/token|hostToken|host_auth|socket|connection|room|_id/i);
    });

    it('never rejects: a failure is a value', async () => {
      await expect(store.load('')).resolves.toMatchObject({ ok: false });
      await expect(store.delete(7 as never)).resolves.toMatchObject({ ok: false });
      await expect(store.save(null as never)).resolves.toMatchObject({ ok: false });
    });
  });
}
