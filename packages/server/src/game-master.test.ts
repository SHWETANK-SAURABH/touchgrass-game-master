import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type Result, ok, parseServerEnv } from '@touchgrass/shared';
import { contextAt, submitGameEvent } from '@touchgrass/game-engine';
import { ModelProviderError, type ModelProvider, parseJsonOutput } from '@touchgrass/ai';
import {
  type GameMaster,
  type GameMasterContext,
  type GameMasterError,
  type GameMasterResult,
  createGameMaster,
  createGameMasterFromEnv,
} from '@touchgrass/ai/game-master';
import type { PolicyOptions } from '@touchgrass/safety';
import { parseGameMasterConfig } from './config';
import {
  DEFAULT_GAME_MASTER_TIMEOUT_MS,
  type GameMasterAudit,
  gameMasterTriggerFor,
} from './game-master-turns';
import type { SessionHandle } from './session-handle';
import { type SessionServer, startSessionServer } from './session-server';
import { Client, READY, heldStore, until } from './socket-test-support';
import {
  START,
  type TestConnection,
  at,
  connection,
  createCommand,
  join,
  send,
  start as startGame,
  testClock,
  unwrap,
} from './test-support';

/**
 * The Game Master pipeline, end to end, with a model that says what a test
 * tells it to. No test here needs a model runtime, except the last one, which
 * runs only when asked.
 */

const KEY = new Uint8Array(32).fill(7);
const RATIONALE = 'The round has gone quiet and needs one small change.';
const NOW = START + 5_000;

const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };
const otherZone = { ...zone, zone: 'the big oak' };
const carPark = { ...zone, zone: 'the car park' };
const objective = (description: string, durationSeconds = 60) => ({
  type: 'BONUS_OBJECTIVE',
  objectiveId: 'o1',
  description,
  points: 2,
  durationSeconds,
});

type Reply = Result<GameMasterResult, GameMasterError>;

/** A Game Master that answers as the test says, and records what it was shown. */
function fakeGameMaster() {
  const calls: { context: GameMasterContext; signal: AbortSignal | undefined }[] = [];
  let answer: (context: GameMasterContext, call: number) => Reply | Promise<Reply> = () =>
    proposing(null);
  const gameMaster: Pick<GameMaster, 'propose' | 'provider' | 'model'> = {
    provider: 'fake',
    model: 'fake-model',
    propose(context, options) {
      calls.push({ context, signal: options?.signal });
      return Promise.resolve(answer(context, calls.length));
    },
  };
  return {
    gameMaster,
    calls,
    answers: (next: typeof answer): void => {
      answer = next;
    },
  };
}

/** What a Game Master returns for a proposal. The value is not checked here. */
function proposing(event: unknown, more: Record<string, unknown> = {}): Reply {
  return ok({
    proposal: { rationale: RATIONALE, event, ...more } as never,
    attempts: 1,
    provider: 'fake',
    model: 'fake-model',
  });
}

/** A model runtime that replies with what it is given, and records every request. */
function scriptedProvider(replies: readonly (object | string | Error)[]) {
  const requests: unknown[] = [];
  let index = 0;
  const next = (): string => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  const provider: ModelProvider = {
    id: 'scripted',
    model: 'scripted-model',
    baseUrl: 'memory://scripted',
    health: () =>
      Promise.resolve({
        ok: true,
        provider: 'scripted',
        model: 'scripted-model',
        baseUrl: 'memory://scripted',
        reachable: true,
        modelAvailable: true,
        latencyMs: 0,
      }),
    generateText: (request) =>
      new Promise((resolve) => {
        requests.push(request);
        resolve({ text: next(), model: 'scripted-model', latencyMs: 1 });
      }),
    generateJson: (request) =>
      new Promise((resolve) => {
        requests.push(request);
        const raw = next();
        resolve({
          data: parseJsonOutput(raw, 'scripted'),
          raw,
          model: 'scripted-model',
          latencyMs: 1,
        });
      }),
  };
  return { provider, requests };
}

let running: SessionServer[] = [];

async function setup(
  options: {
    gameMaster?: Pick<GameMaster, 'propose' | 'provider' | 'model'> | null;
    timeoutMs?: number;
    safety?: PolicyOptions;
    backing?: ReturnType<typeof heldStore>;
  } = {},
) {
  const backing = options.backing ?? heldStore();
  const fake = fakeGameMaster();
  const clock = testClock();
  const audits: GameMasterAudit[] = [];
  const chosen = options.gameMaster === undefined ? fake.gameMaster : options.gameMaster;
  const server = unwrap(
    await startSessionServer({
      store: backing.store,
      port: 0,
      clock,
      tokenKey: KEY,
      ...(chosen
        ? {
            gameMaster: {
              gameMaster: chosen,
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
              ...(options.safety ? { safety: options.safety } : {}),
              onAudit: (audit) => audits.push(audit),
            },
          }
        : {}),
    }),
  );
  running.push(server);

  /** A game with three players and round 1 running, and no Game Master turn taken yet. */
  const running_ = async (sessionId: string): Promise<SessionHandle> => {
    const handle = unwrap(await server.registry.create(createCommand(sessionId), at(0)));
    // Started by trusted code directly, so no update is broadcast for it.
    startGame(handle.session);
    unwrap(await handle.save());
    clock.set(NOW);
    return handle;
  };
  /** Takes one turn and returns its record. */
  const turn = async (sessionId: string): Promise<GameMasterAudit> => {
    const taken = await server.runGameMaster(sessionId);
    if (!('invocationId' in taken)) throw new Error(`no turn: ${taken.code}`);
    return taken;
  };
  return {
    ...backing,
    ...fake,
    storeCalls: backing.calls,
    server,
    registry: server.registry,
    clock,
    audits,
    active: running_,
    turn,
  };
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.shutdown()));
  running = [];
});

/** Two connections that hear what the room says: the host, and one that only watches. */
function listeners(handle: SessionHandle): TestConnection[] {
  const host = connection();
  send(handle.room, host, { type: 'host_auth', token: handle.hostToken }, 5_000);
  host.take();
  return [host];
}

const modifiers = (handle: SessionHandle) => handle.session.getState().activeModifiers;
const lastEntry = (handle: SessionHandle) => handle.session.getState().history.at(-1);

describe('A, N, O and P. a proposal that is legal and safe', () => {
  it('is applied by the engine, told to the room, and saved', async () => {
    const { server, inner, answers, calls, active, turn } = await setup();
    const a = await active('a');
    const [host] = listeners(a);
    const before = a.session.getState();
    answers(() => proposing(zone));

    const audit = await turn('a');
    expect(audit).toEqual({
      invocationId: 'gm-1',
      sessionId: 'a',
      trigger: 'manual',
      at: before.createdAt + NOW,
      provider: 'fake',
      model: 'fake-model',
      attempts: 1,
      outcome: 'APPLIED',
      eventType: 'ZONE_CHANGE',
      saved: true,
      durationMs: 0,
    });
    expect(calls).toHaveLength(1);

    // The game changed, and only the way the engine changes it.
    const after = a.session.getState();
    expect(after).not.toBe(before);
    expect(modifiers(a)).toMatchObject([{ kind: 'SAFE_ZONE', zone: 'the bench' }]);
    expect(lastEntry(a)).toMatchObject({
      source: 'game-master',
      record: { kind: 'EVENT', event: zone },
    });
    const viaEngine = unwrap(
      submitGameEvent(
        before,
        zone,
        'game-master',
        contextAt({ now: () => before.createdAt + NOW }),
      ),
    );
    expect(after).toEqual(viaEngine);

    // The room told its connections what the engine recorded, once.
    const heard = host?.take() ?? [];
    expect(heard.map((message) => message.type)).toEqual(['update']);
    expect(JSON.stringify(heard)).toContain('the bench');

    // And it is stored.
    expect(a.hasUnsavedChanges()).toBe(false);
    const stored = unwrap(await inner.load('a'));
    expect(stored?.state.activeModifiers).toMatchObject([{ kind: 'SAFE_ZONE', zone: 'the bench' }]);
    expect(stored?.state.history.at(-1)?.source).toBe('game-master');
    expect(server.registry.get('a')).toBe(a);
  });

  it('is applied and reported unsaved when the store is away, and the game goes on', async () => {
    const { failing, answers, active, turn } = await setup();
    const a = await active('a');
    failing.save.add('a');
    answers(() => proposing(zone));

    const audit = await turn('a');
    expect(audit).toMatchObject({ outcome: 'APPLIED', saved: false, code: 'STORAGE_ERROR' });
    expect(modifiers(a)).toHaveLength(1);
    expect(a.hasUnsavedChanges()).toBe(true);
    failing.save.clear();
    unwrap(await a.save());
  });

  it('may also be a decision that nothing should happen', async () => {
    const { calls, active, turn } = await setup();
    const a = await active('a');
    const [host] = listeners(a);
    const before = a.session.getState();
    const saves = calls.length;

    expect(await turn('a')).toMatchObject({ outcome: 'NO_EVENT', attempts: 1 });
    expect(a.session.getState()).toBe(before);
    expect(host?.take()).toEqual([]);
    expect(a.hasUnsavedChanges()).toBe(false);
    expect(calls.length).toBe(saves + 1);
  });
});

describe('B and C. how much one turn may propose', () => {
  it('is one event: a second turn is how a second event happens', async () => {
    const { answers, active, turn } = await setup();
    const a = await active('a');
    answers((_context, call) => proposing(call === 1 ? zone : otherZone));
    expect((await turn('a')).outcome).toBe('APPLIED');
    expect((await turn('a')).outcome).toBe('APPLIED');
    expect(modifiers(a).map((modifier) => ('zone' in modifier ? modifier.zone : ''))).toEqual([
      'the bench',
      'the big oak',
    ]);
  });

  it.each([
    ['a list of events', proposing(null, { events: [zone, otherZone] })],
    ['several events in place of one', proposing([zone, otherZone])],
    ['an event and something more to do', proposing(zone, { then: 'ABORT_SESSION' })],
    ['an event carrying an extra instruction', proposing({ ...zone, command: 'rm -rf' })],
  ])('refuses %s whole, and applies none of it', async (_label, reply) => {
    const { answers, active, turn } = await setup();
    const a = await active('a');
    const before = a.session.getState();
    answers(() => reply);
    expect(await turn('a')).toMatchObject({ outcome: 'REJECTED', stage: 'SCHEMA' });
    expect(a.session.getState()).toBe(before);
  });
});

describe('D, E and F. a reply that is not a proposal', () => {
  it.each([
    ['prose', 'I think the players should all run to the far fence!'],
    ['broken JSON', '{"rationale": "The round is slow", "event": '],
    ['an unknown event type', { rationale: RATIONALE, event: { type: 'GAME_END', reason: 'x' } }],
    ['a lifecycle event', { rationale: RATIONALE, event: { type: 'ROUND_START', round: 9 } }],
    ['a bad payload', { rationale: RATIONALE, event: { ...zone, durationSeconds: -5 } }],
    ['a missing field', { rationale: RATIONALE, event: { type: 'ZONE_CHANGE', zone: 'x' } }],
    ['no rationale', { event: zone }],
  ])('from the model, as %s, fails the turn and changes nothing', async (_label, reply) => {
    const scripted = scriptedProvider([reply]);
    const { active, turn } = await setup({
      gameMaster: createGameMaster({ provider: scripted.provider, maxRepairAttempts: 1 }),
    });
    const a = await active('a');
    const [host] = listeners(a);
    const before = a.session.getState();

    const audit = await turn('a');
    expect(audit).toMatchObject({
      outcome: 'FAILED',
      stage: 'PROPOSAL',
      code: 'INVALID_PROPOSAL',
      attempts: 2,
    });
    expect(a.session.getState()).toBe(before);
    expect(host?.take()).toEqual([]);
    // The model was asked again once, with the same limits, and no more.
    expect(scripted.requests).toHaveLength(2);
  });

  it.each([
    ['an unknown event type', { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' }],
    [
      'an event kind this game does not allow',
      { type: 'ROLE_CHANGE', playerId: 'p0', roleId: 'x' },
    ],
    ['a bad payload', { ...zone, durationSeconds: 'soon' }],
    ['a missing field', { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE' }],
    ['not an event at all', 'pause the game'],
  ])('is refused by the schema even if a Game Master hands it over: %s', async (_label, event) => {
    const { answers, active, turn } = await setup();
    const a = await active('a');
    const before = a.session.getState();
    answers(() => proposing(event));
    const audit = await turn('a');
    expect(['SCHEMA', 'STATE']).toContain(audit.stage);
    expect(audit.outcome).toBe('REJECTED');
    expect(a.session.getState()).toBe(before);
  });
});

describe('G, H, I and J. the safety validator', () => {
  it.each([
    ['a zone that is not a safe place', carPark],
    ['a zone off the ground', { ...zone, zone: 'the roof of the shed' }],
    ['an objective that is a critical hazard', objective('Climb the abandoned building.')],
    ['an objective that cannot be read', objective('Залезь на крышу')],
    ['an objective that lasts too long', objective('Touch the big oak.', 150)],
  ])('refuses %s: nothing is applied, told or saved', async (_label, event) => {
    const { storeCalls, answers, active, turn } = await setup();
    const a = await active('a');
    const [host] = listeners(a);
    const before = a.session.getState();
    const saves = storeCalls.save;
    answers(() => proposing(event));

    const audit = await turn('a');
    expect(audit).toMatchObject({ outcome: 'REJECTED', stage: 'SAFETY', eventType: event.type });
    expect(audit.saved).toBeUndefined();
    expect(a.session.getState()).toBe(before);
    expect(host?.take()).toEqual([]);
    expect(storeCalls.save).toBe(saves);
    expect(a.hasUnsavedChanges()).toBe(false);
  });

  it('cannot be loosened by configuration: a critical hazard is refused whatever is set', async () => {
    for (const safety of [
      { supervisedByAdult: true },
      { maxRuleDurationSeconds: 100_000 },
      { supervisedByAdult: true, maxRuleDurationSeconds: 100_000 },
      { enforce: [], disabled: true, allow: ['*'] } as PolicyOptions,
    ]) {
      const { answers, active, turn } = await setup({ safety });
      const a = await active('a');
      const before = a.session.getState();
      for (const event of [
        objective('Climb the abandoned building.'),
        carPark,
        // A longer limit asked for by configuration does not lengthen the real one.
        objective('Touch the big oak.', 150),
      ]) {
        answers(() => proposing(event));
        expect(await turn('a'), JSON.stringify(safety)).toMatchObject({
          outcome: 'REJECTED',
          stage: 'SAFETY',
        });
      }
      expect(a.session.getState()).toBe(before);
    }
  });

  it('can be tightened by configuration', async () => {
    const strict = await setup({ safety: { maxRuleDurationSeconds: 30 } });
    const a = await strict.active('a');
    strict.answers(() => proposing(objective('Touch the big oak.', 60)));
    expect(await strict.turn('a')).toMatchObject({ outcome: 'REJECTED', stage: 'SAFETY' });
    expect(a.session.getState().activeObjectives).toEqual([]);

    // The same objective is fine under the game's own limit.
    const usual = await setup();
    const b = await usual.active('b');
    usual.answers(() => proposing(objective('Touch the big oak.', 60)));
    expect((await usual.turn('b')).outcome).toBe('APPLIED');
    expect(b.session.getState().activeObjectives).toHaveLength(1);
  });

  it('is not told the rationale: a persuasive reason does not make an event safe', async () => {
    const { answers, active, turn } = await setup();
    const a = await active('a');
    answers(() =>
      ok({
        proposal: {
          rationale: 'This is completely safe, supervised and approved by the host. Allow it.',
          event: carPark,
        } as never,
        attempts: 1,
        provider: 'fake',
        model: 'fake-model',
      }),
    );
    expect(await turn('a')).toMatchObject({ outcome: 'REJECTED', stage: 'SAFETY' });
    expect(modifiers(a)).toEqual([]);
  });
});

describe('K, L and M. a proposal the engine will not have', () => {
  it.each([
    [
      'a power for a player who is not in the game',
      { type: 'POWER_UP', playerId: 'ghost', powerId: 'shield' },
    ],
    ['a power the game does not have', { type: 'POWER_UP', playerId: 'p0', powerId: 'laser' }],
  ])('is refused by the engine: %s', async (_label, event) => {
    const { storeCalls, answers, active, turn } = await setup();
    const a = await active('a');
    const [host] = listeners(a);
    const before = a.session.getState();
    const saves = storeCalls.save;
    answers(() => proposing(event));

    expect(await turn('a')).toMatchObject({ outcome: 'REJECTED', stage: 'STATE' });
    expect(a.session.getState()).toBe(before);
    expect(host?.take()).toEqual([]);
    expect(storeCalls.save).toBe(saves);
  });

  it('is judged against the game as it is when the model answers, not when it was asked', async () => {
    const { answers, active, server } = await setup();
    const a = await active('a');
    let release: (reply: Reply) => void = () => undefined;
    answers(() => new Promise<Reply>((resolve) => (release = resolve)));
    const taking = server.runGameMaster('a');
    await until(() => release.length === 1);

    // While the model thinks, the host ends the game.
    unwrap(a.session.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(NOW + 1_000)));
    const ended = a.session.getState();
    release(proposing(zone));

    expect(await taking).toMatchObject({ outcome: 'REJECTED', stage: 'STATE' });
    expect(a.session.getState()).toBe(ended);
    expect(modifiers(a)).toEqual([]);
  });
});

describe('Q and R. a model that is away or slow', () => {
  it.each([
    ['unreachable', new ModelProviderError('PROVIDER_UNREACHABLE', 'connect ECONNREFUSED')],
    ['missing its model', new ModelProviderError('MODEL_NOT_AVAILABLE', 'model not found')],
    ['slow', new ModelProviderError('PROVIDER_TIMEOUT', 'the request timed out')],
  ])('fails the turn when the runtime is %s, and the game plays on', async (_label, failure) => {
    const scripted = scriptedProvider([failure]);
    const { active, turn } = await setup({
      gameMaster: createGameMaster({ provider: scripted.provider }),
    });
    const a = await active('a');
    const before = a.session.getState();

    const audit = await turn('a');
    expect(audit).toMatchObject({ outcome: 'FAILED', stage: 'PROPOSAL', code: failure.code });
    expect(a.session.getState()).toBe(before);
    expect(JSON.stringify(audit)).not.toContain('ECONNREFUSED');

    // Players and the host are unaffected.
    const tagger = before.players.find((player) => player.roleId === 'tagger');
    const runner = before.players.find((player) => player.roleId === 'runner');
    unwrap(
      a.session.submitAction(
        tagger?.id ?? '',
        { type: 'PLAYER_TAGGED', targetPlayerId: runner?.id ?? '' },
        at(NOW + 500),
      ),
    );
    expect(a.session.getState().status).toBe('active');
  });

  it('gives up on a model that never answers, after the time limit, and plays on meanwhile', async () => {
    const { answers, calls, active, server } = await setup({ timeoutMs: 40 });
    const a = await active('a');
    const [host] = listeners(a);
    answers(() => new Promise<Reply>(() => undefined));
    const taking = server.runGameMaster('a');
    await until(() => calls.length === 1);

    // The game is not waiting for the model.
    const state = a.session.getState();
    const tagger = state.players.find((player) => player.roleId === 'tagger');
    const runner = state.players.find((player) => player.roleId === 'runner');
    unwrap(
      a.session.submitAction(
        tagger?.id ?? '',
        { type: 'PLAYER_TAGGED', targetPlayerId: runner?.id ?? '' },
        at(NOW + 500),
      ),
    );
    const played = a.session.getState();

    expect(await taking).toMatchObject({ outcome: 'FAILED', stage: 'PROPOSAL', code: 'TIMED_OUT' });
    // The model was told to stop, and nothing of its turn reached the game.
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(a.session.getState()).toBe(played);
    expect(host?.take()).toEqual([]);
  });

  it('survives a Game Master that throws', async () => {
    const { answers, active, turn } = await setup();
    const a = await active('a');
    const before = a.session.getState();
    answers(() => {
      throw new Error('LEAK_MARKER something broke inside');
    });
    const audit = await turn('a');
    expect(audit).toMatchObject({ outcome: 'FAILED', code: 'UNEXPECTED' });
    expect(JSON.stringify(audit)).not.toContain('LEAK_MARKER');
    expect(a.session.getState()).toBe(before);
  });

  it('has a default time limit, kept in one place', () => {
    expect(DEFAULT_GAME_MASTER_TIMEOUT_MS).toBe(20_000);
    expect(unwrap(parseGameMasterConfig({}))).toEqual({
      enabled: false,
      timeoutMs: DEFAULT_GAME_MASTER_TIMEOUT_MS,
      tools: [],
    });
  });
});

describe('S. with no Game Master', () => {
  it('asks no model, takes no turn, and the game is played as before', async () => {
    const { server, registry, calls } = await setup({ gameMaster: null });
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const players = [connection(), connection(), connection()];
    for (const [index, who] of players.entries()) join(handle.room, who, `Player ${index}`);
    for (const who of players) send(handle.room, who, READY, START);
    expect(handle.session.getState().status).toBe('active');

    expect(await server.runGameMaster('a')).toEqual({
      outcome: 'SKIPPED',
      sessionId: 'a',
      code: 'GAME_MASTER_DISABLED',
    });
    expect(calls).toEqual([]);
    expect(handle.session.getState().history.some((entry) => entry.source === 'game-master')).toBe(
      false,
    );
  });

  it('is off unless it is switched on', () => {
    expect(unwrap(parseGameMasterConfig({})).enabled).toBe(false);
    expect(unwrap(parseGameMasterConfig({ GAME_MASTER_ENABLED: ' ' })).enabled).toBe(false);
    for (const on of ['true', 'TRUE', '1']) {
      expect(unwrap(parseGameMasterConfig({ GAME_MASTER_ENABLED: on })).enabled).toBe(true);
    }
    for (const off of ['false', '0']) {
      expect(unwrap(parseGameMasterConfig({ GAME_MASTER_ENABLED: off })).enabled).toBe(false);
    }
    expect(
      unwrap(
        parseGameMasterConfig({ GAME_MASTER_ENABLED: 'true', GAME_MASTER_TIMEOUT_MS: '5000' }),
      ),
    ).toEqual({ enabled: true, timeoutMs: 5_000, tools: [] });
    for (const env of [
      { GAME_MASTER_ENABLED: 'yes please' },
      { GAME_MASTER_TIMEOUT_MS: '0' },
      { GAME_MASTER_TIMEOUT_MS: 'forever' },
      { GAME_MASTER_TIMEOUT_MS: '99999999' },
    ]) {
      expect(parseGameMasterConfig(env).ok, JSON.stringify(env)).toBe(false);
    }
  });
});

describe('T, U and Y. what the model is given, and what it can reach', () => {
  it('is sent the game and nothing that opens anything', async () => {
    const scripted = scriptedProvider([{ rationale: RATIONALE, event: null }]);
    const { server, registry, clock, audits } = await setup({
      gameMaster: createGameMaster({ provider: scripted.provider }),
    });
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const players = [connection(), connection(), connection()];
    const joined = players.map((who, index) => join(handle.room, who, `Player ${index}`));
    clock.set(START);
    for (const who of players) send(handle.room, who, READY, START);
    await until(() => audits.length === 1);

    const sent = JSON.stringify(scripted.requests);
    expect(scripted.requests.length).toBeGreaterThan(0);
    // The game is there.
    expect(sent).toContain('Player 0');
    // No capability, no join code, no seed, no key, no address of anything.
    for (const hidden of [
      ...joined.map((player) => player.token),
      handle.hostToken,
      handle.session.getState().joinCode,
      Buffer.from(KEY).toString('base64url'),
      'mongodb',
      'localhost',
      String(server.port),
    ]) {
      expect(sent.includes(hidden), hidden).toBe(false);
    }
    expect(sent).not.toMatch(/"tools"|"tool_choice"|"functions"/);
    expect(sent).not.toMatch(/randomSeed|joinCode|hostToken|sessionId/);
  });

  it('gets a frozen copy to read and no object it could act through', async () => {
    const { answers, calls, active, turn } = await setup();
    const a = await active('a');
    const before = a.session.getState();
    answers((context) => {
      // Whatever a Game Master tries to do to what it was shown, it cannot.
      expect(() => {
        (context.state as { status: string }).status = 'completed';
      }).toThrow();
      expect(() => {
        (context.state.players as unknown[]).push({ id: 'intruder' });
      }).toThrow();
      return proposing(null);
    });

    expect((await turn('a')).outcome).toBe('NO_EVENT');
    expect(a.session.getState()).toBe(before);
    expect(Object.keys(calls[0]?.context ?? {}).sort()).toEqual(['definition', 'now', 'state']);
    expect(calls[0]?.context.state).toBe(before);
  });

  it('is wired with no tools, no files, no shell and no network of its own', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const read = (...parts: string[]): string =>
      readFileSync(joinPath(directory, ...parts), 'utf-8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      );
    const turns = read('game-master-turns.ts');
    expect(turns).not.toMatch(/node:fs|child_process|fetch\(|WebSocket|process\.env|\beval\(/);
    expect(turns).not.toMatch(/SessionStore|mongodb|createRoom|\.receive\(|\.send\(/);
    // It reaches a game in exactly two ways: reading it, and the room's trusted apply.
    expect(turns).not.toMatch(/applyCommand|submitAction|advanceTime|applyValidatedEvent/);
    expect(turns.match(/gameMaster\.\w+/g)?.filter((use) => use.endsWith('propose'))).toHaveLength(
      1,
    );
    expect(turns).toContain(
      '{ getState: handle.session.getState, applyEvent: handle.room.applyEvent }',
    );
    // The agent itself is built with no tools, in the AI package.
    const agent = read('..', '..', 'ai', 'src', 'game-master', 'game-master.ts');
    expect(agent).toContain('tools: {},');
    expect(agent).not.toMatch(/handoff|applyValidatedEvent|game-session|@touchgrass\/realtime/);
  });
});

describe('V, W and X. several turns at once', () => {
  it('keeps a turn inside its own session', async () => {
    const { answers, calls, active, turn } = await setup();
    const a = await active('a');
    const b = await active('b');
    const [hostB] = listeners(b);
    const untouched = b.session.getState();
    answers((context) => proposing(context.state.id === 'a' ? zone : null));

    expect(await turn('a')).toMatchObject({ sessionId: 'a', outcome: 'APPLIED' });
    expect(modifiers(a)).toHaveLength(1);
    expect(b.session.getState()).toBe(untouched);
    expect(hostB?.take()).toEqual([]);
    expect(b.hasUnsavedChanges()).toBe(false);
    // Each call was shown its own game only.
    expect(calls.map((call) => call.context.state.id)).toEqual(['a']);
  });

  it('takes the turns of one session one at a time, each against the game the last one left', async () => {
    const { answers, calls, active, server } = await setup();
    const a = await active('a');
    const releases: ((reply: Reply) => void)[] = [];
    answers(() => new Promise<Reply>((resolve) => releases.push(resolve)));

    const first = server.runGameMaster('a');
    const second = server.runGameMaster('a');
    const third = server.runGameMaster('a');
    await until(() => releases.length === 1);
    for (let turnOfLoop = 0; turnOfLoop < 20; turnOfLoop += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Only the first has reached the model.
    expect(calls).toHaveLength(1);

    releases[0]?.(proposing(zone));
    expect(await first).toMatchObject({ invocationId: 'gm-1', outcome: 'APPLIED' });
    await until(() => releases.length === 2);
    // The second was shown the game with the first one's event in it.
    expect(calls[1]?.context.state.activeModifiers).toHaveLength(1);
    releases[1]?.(proposing(otherZone));
    expect(await second).toMatchObject({ invocationId: 'gm-2', outcome: 'APPLIED' });
    await until(() => releases.length === 3);
    releases[2]?.(proposing(null));
    expect(await third).toMatchObject({ invocationId: 'gm-3', outcome: 'NO_EVENT' });
    expect(modifiers(a)).toHaveLength(2);
  });

  it('does not make one session wait for another session’s model', async () => {
    const { answers, active, server, turn } = await setup();
    const a = await active('a');
    const b = await active('b');
    let releaseA: (reply: Reply) => void = () => undefined;
    answers((context) =>
      context.state.id === 'a'
        ? new Promise<Reply>((resolve) => (releaseA = resolve))
        : proposing(otherZone),
    );
    const slow = server.runGameMaster('a');
    await until(() => releaseA.length === 1);

    expect(await turn('b')).toMatchObject({ sessionId: 'b', outcome: 'APPLIED' });
    expect(modifiers(b)).toHaveLength(1);
    expect(modifiers(a)).toEqual([]);
    releaseA(proposing(zone));
    expect(await slow).toMatchObject({ sessionId: 'a', outcome: 'APPLIED' });
  });
});

describe('when the Game Master is asked', () => {
  it('is when a round begins, as the engine recorded it, and at no other time', async () => {
    const { registry, clock, calls, audits } = await setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const players = [connection(), connection(), connection()];
    for (const [index, who] of players.entries()) join(handle.room, who, `Player ${index}`);
    expect(calls).toEqual([]);

    clock.set(START);
    for (const who of players.slice(0, 2)) send(handle.room, who, READY, START);
    expect(handle.session.getState().status).not.toBe('active');
    await until(() => true);
    expect(calls).toEqual([]);

    // The last player is ready: round 1 begins, and one turn is taken.
    send(handle.room, players[2] as TestConnection, READY, START);
    await until(() => audits.length === 1);
    expect(audits[0]).toMatchObject({ trigger: 'round_start', outcome: 'NO_EVENT' });
    expect(calls).toHaveLength(1);

    // Play inside the round asks nobody.
    const state = handle.session.getState();
    const tagger = state.players.find((player) => player.roleId === 'tagger');
    const runner = state.players.find((player) => player.roleId === 'runner');
    const taggerConnection = players.find((who) => handle.room.playerIdOf(who) === tagger?.id);
    send(
      handle.room,
      taggerConnection as TestConnection,
      { type: 'action', intent: { type: 'PLAYER_TAGGED', targetPlayerId: runner?.id } },
      START + 5_000,
    );
    for (let turnOfLoop = 0; turnOfLoop < 20; turnOfLoop += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(calls).toHaveLength(1);

    // The next round begins when time is advanced past the end of this one.
    clock.set(START + 200_000);
    handle.room.tick(at(START + 200_000));
    await until(() => audits.length === 2);
    expect(audits[1]).toMatchObject({ trigger: 'round_start' });
    expect(handle.session.getState().currentRound).toBe(2);
  });

  it('is not when the Game Master’s own event is applied: it cannot ask itself', async () => {
    const { answers, calls, audits, active, turn } = await setup();
    await active('a');
    answers(() => proposing(zone));
    await turn('a');
    for (let turnOfLoop = 0; turnOfLoop < 20; turnOfLoop += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(calls).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('follows from the entries alone', async () => {
    const { active } = await setup();
    const a = await active('a');
    const state = a.session.getState();
    const roundStart = state.history.filter(
      (entry) => entry.record.kind === 'EVENT' && entry.record.event.type === 'ROUND_START',
    );
    expect(roundStart).toHaveLength(1);
    expect(gameMasterTriggerFor({ state, entries: roundStart })).toBe('round_start');
    expect(gameMasterTriggerFor({ state, entries: [] })).toBeNull();
    expect(
      gameMasterTriggerFor({
        state,
        entries: state.history.filter((entry) => !roundStart.includes(entry)),
      }),
    ).toBeNull();
    // A round that began in a game that has since ended asks nobody.
    expect(
      gameMasterTriggerFor({ state: { ...state, status: 'aborted' }, entries: roundStart }),
    ).toBeNull();
  });
});

describe('the session lifecycle and the Game Master', () => {
  it('asks no model for a game that is not being played', async () => {
    const { server, registry, calls } = await setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    expect(await server.runGameMaster('a')).toMatchObject({
      outcome: 'SKIPPED',
      code: 'GAME_NOT_ACTIVE',
    });
    unwrap(handle.session.applyCommand({ type: 'ABORT_SESSION', reason: 'rain' }, at(10)));
    expect(await server.runGameMaster('a')).toMatchObject({ code: 'GAME_NOT_ACTIVE' });
    expect(calls).toEqual([]);
  });

  it('takes no turn for a session that is not in memory, and does not load it', async () => {
    const { server, registry, calls, storeCalls, active } = await setup();
    await active('a');
    unwrap(await registry.evict('a'));
    const loads = storeCalls.load;

    expect(await server.runGameMaster('a')).toEqual({
      outcome: 'SKIPPED',
      sessionId: 'a',
      code: 'SESSION_NOT_LOADED',
    });
    expect(await server.runGameMaster('never-existed')).toMatchObject({
      code: 'SESSION_NOT_LOADED',
    });
    expect(calls).toEqual([]);
    expect(registry.get('a')).toBeUndefined();
    expect(storeCalls.load).toBe(loads);
  });

  it('drops an answer that arrives after its session was evicted, and brings nothing back', async () => {
    const { server, registry, inner, clock, storeCalls, answers, active } = await setup();
    const a = await active('a');
    let release: (reply: Reply) => void = () => undefined;
    answers(() => new Promise<Reply>((resolve) => (release = resolve)));
    const taking = server.runGameMaster('a');
    await until(() => release.length === 1);

    // A waiting model does not keep a session in memory.
    expect(registry.sessions()[0]?.state).toBe('idle');
    clock.set(NOW + 31 * 60_000);
    expect((await registry.evictIdle()).evicted).toEqual(['a']);
    const frozen = a.session.getState();
    const loads = storeCalls.load;
    const saves = storeCalls.save;

    release(proposing(zone));
    expect(await taking).toMatchObject({ outcome: 'SKIPPED', code: 'SESSION_CLOSED' });
    expect(a.session.getState()).toBe(frozen);
    expect(registry.get('a')).toBeUndefined();
    expect(storeCalls.load).toBe(loads);
    expect(storeCalls.save).toBe(saves);
    const stored = unwrap(await inner.load('a'));
    expect(stored?.state.activeModifiers).toEqual([]);
  });

  it('starts no turn once the session is closing, or the server is stopping', async () => {
    const { server, calls, active } = await setup();
    const a = await active('a');
    await a.close();
    expect(await server.runGameMaster('a')).toMatchObject({ code: 'SESSION_NOT_LOADED' });

    const b = await active('b');
    const stopping = server.shutdown();
    expect(await server.runGameMaster('b')).toMatchObject({ code: 'SERVER_STOPPING' });
    unwrap(await stopping);
    expect(b.room.isClosed()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('settles with an eviction either way round, and never half-applies', async () => {
    const { server, registry, inner, answers, active } = await setup();
    const a = await active('a');
    answers(() => proposing(zone));
    const [taken, evicted] = await Promise.all([server.runGameMaster('a'), registry.evict('a')]);
    const stored = unwrap(await inner.load('a'));

    if ('invocationId' in taken && taken.outcome === 'APPLIED') {
      // The turn came first: its event is in the game and in the store.
      if (!evicted.ok) unwrap(await registry.evict('a'));
      expect(unwrap(await inner.load('a'))?.state.activeModifiers).toHaveLength(1);
    } else {
      // The eviction came first: the turn found the session closed and did nothing.
      expect(evicted.ok).toBe(true);
      expect(taken).toMatchObject({ outcome: 'SKIPPED' });
      expect(stored?.state.activeModifiers).toEqual([]);
      expect(modifiers(a)).toEqual([]);
    }
    expect(registry.get('a')).toBeUndefined();
  });

  it('keeps an applied event when the session is evicted straight afterwards', async () => {
    const { registry, inner, answers, active, turn } = await setup();
    await active('a');
    answers(() => proposing(zone));
    expect((await turn('a')).outcome).toBe('APPLIED');
    unwrap(await registry.evict('a'));
    const stored = unwrap(await inner.load('a'));
    expect(stored?.state.activeModifiers).toMatchObject([{ zone: 'the bench' }]);
    // Loaded again, the event is still in force and still the Game Master's.
    const again = unwrap(await registry.load('a'));
    expect(again.session.getState().history.at(-1)?.source).toBe('game-master');
  });
});

describe('the record of a turn', () => {
  it('says what happened without a prompt, a reply, a reason or a player in it', async () => {
    const { registry, clock, answers, audits } = await setup();
    const handle = unwrap(await registry.create(createCommand('a'), at(0)));
    const players = [connection(), connection(), connection()];
    const joined = players.map((who, index) => join(handle.room, who, `Player Secretname${index}`));
    answers(() => proposing(carPark));
    clock.set(START);
    for (const who of players) send(handle.room, who, READY, START);
    await until(() => audits.length === 1);

    expect(Object.keys(audits[0] ?? {}).sort()).toEqual([
      'at',
      'attempts',
      'code',
      'durationMs',
      'eventType',
      'invocationId',
      'model',
      'outcome',
      'provider',
      'sessionId',
      'stage',
      'trigger',
    ]);
    const told = JSON.stringify(audits);
    for (const hidden of [
      RATIONALE,
      'car park',
      'Secretname',
      handle.hostToken,
      ...joined.flatMap((player) => [player.token, player.playerId]),
    ]) {
      expect(told.includes(hidden), hidden).toBe(false);
    }
  });

  it('is unaffected by a listener that throws', async () => {
    const fake = fakeGameMaster();
    const backing = heldStore();
    const server = unwrap(
      await startSessionServer({
        store: backing.store,
        port: 0,
        clock: testClock(),
        gameMaster: {
          gameMaster: fake.gameMaster,
          onAudit: () => {
            throw new Error('the listener broke');
          },
        },
      }),
    );
    running.push(server);
    const handle = unwrap(await server.registry.create(createCommand('a'), at(0)));
    startGame(handle.session);
    fake.answers(() => proposing(null));
    expect(await server.runGameMaster('a')).toMatchObject({ outcome: 'NO_EVENT' });
  });
});

describe('Z. the whole way, over real sockets, with the real agent', () => {
  it('state → model → schema → safety → engine → store → every client', async () => {
    const scripted = scriptedProvider([
      { rationale: RATIONALE, event: zone },
      { rationale: RATIONALE, event: carPark },
    ]);
    const { server, registry, inner, clock, audits } = await setup({
      gameMaster: createGameMaster({ provider: scripted.provider }),
    });
    unwrap(await registry.create(createCommand('a'), at(0)));
    unwrap(await registry.create(createCommand('b'), at(0)));
    const clients = await Promise.all([1, 2, 3].map(() => Client.open(server.port, 'a')));
    const bystander = await Client.open(server.port, 'b');
    await bystander.join('Bo');
    for (const [index, client] of clients.entries()) {
      await client.join(`Player ${index}`);
      for (const earlier of clients.slice(0, index)) await earlier.next();
    }

    // Everyone is ready: round 1 begins, and the application asks the Game Master.
    clock.set(START);
    for (const client of clients) client.send(READY);
    await until(() => audits.length === 1);
    expect(audits[0]).toMatchObject({
      sessionId: 'a',
      trigger: 'round_start',
      provider: 'scripted',
      model: 'scripted-model',
      outcome: 'APPLIED',
      eventType: 'ZONE_CHANGE',
      saved: true,
    });

    // Every client of that session is sent the same authoritative update.
    for (const client of clients) {
      let update = await client.next();
      while (!JSON.stringify(update).includes('the bench')) update = await client.next();
      expect(update.type).toBe('update');
    }
    const handle = registry.get('a');
    expect(handle?.session.getState().activeModifiers).toMatchObject([{ zone: 'the bench' }]);
    expect(unwrap(await inner.load('a'))?.state.activeModifiers).toMatchObject([
      { zone: 'the bench' },
    ]);

    // The next proposal is unsafe: it stops at the safety validator.
    const before = handle?.session.getState();
    const second = await server.runGameMaster('a');
    expect(second).toMatchObject({ outcome: 'REJECTED', stage: 'SAFETY' });
    expect(handle?.session.getState()).toBe(before);

    // The other session saw none of it.
    bystander.send('?');
    expect(await bystander.next()).toEqual({ type: 'error', code: 'BAD_MESSAGE' });
    expect(bystander.raw.join('')).not.toContain('the bench');
  });
});

// Runs only when asked, against the real model runtime: GAME_MASTER_LIVE_TEST=1,
// with the usual MODEL_* settings. Nothing else in the project needs a model.
describe.skipIf(!process.env.GAME_MASTER_LIVE_TEST)('with the real model', () => {
  it('takes a turn that ends in one of the known ways, and changes the game only if applied', async () => {
    const env = parseServerEnv(process.env);
    const { active, turn } = await setup({
      gameMaster: createGameMasterFromEnv(env),
      timeoutMs: 120_000,
    });
    const a = await active('a');
    const before = a.session.getState();

    const audit = await turn('a');
    expect(audit.model).toBe(env.MODEL_NAME);
    expect(['APPLIED', 'NO_EVENT', 'REJECTED', 'FAILED']).toContain(audit.outcome);
    if (audit.outcome === 'APPLIED') {
      expect(a.session.getState().history.at(-1)?.source).toBe('game-master');
      expect(audit.saved).toBe(true);
    } else {
      expect(a.session.getState()).toBe(before);
    }
  }, 180_000);
});

export type { TestConnection };
