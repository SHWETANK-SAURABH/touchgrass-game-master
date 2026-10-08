import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLogger } from '@touchgrass/shared';
import {
  type GameMasterTool,
  type ToolScope,
  createGameMaster,
  defineTool,
  gameHistoryTool,
  gameRulesTool,
} from '@touchgrass/ai/game-master';
import { scriptedModelProvider } from '@touchgrass/ai/eval';
import type { GameMasterAudit } from './game-master-turns';
import { createMetrics } from './metrics';
import type { ErrorReporter, ReportTags } from './reporting';
import type { SessionHandle } from './session-handle';
import { type SessionServer, startSessionServer } from './session-server';
import { Client, READY, heldStore, until } from './socket-test-support';
import {
  START,
  at,
  connection,
  createCommand,
  send,
  start as startGame,
  testClock,
  unwrap,
} from './test-support';

/**
 * Tools, the audit record, metrics, logs and error reports, in live sessions.
 *
 * The agent, the pipeline, the registry and the rooms are the real ones. The
 * model is a script, and the error reporter keeps what it is given.
 */

const KEY = new Uint8Array(32).fill(7);
const RATIONALE = 'The round has gone quiet and needs one small change.';
const NOW = START + 5_000;
const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };
const proposal = (event: unknown) => ({ rationale: RATIONALE, event });
const ask = (name: string, input: unknown = {}) => ({ tool: { name, input } });

let running: SessionServer[] = [];

async function setup(options: {
  replies: readonly (object | string | Error)[];
  tools?: readonly GameMasterTool[];
  maxToolCalls?: number;
  toolTimeoutMs?: number;
  backing?: ReturnType<typeof heldStore>;
}) {
  const backing = options.backing ?? heldStore();
  const provider = scriptedModelProvider(options.replies);
  const clock = testClock();
  const audits: GameMasterAudit[] = [];
  const metrics = createMetrics();
  const lines: Record<string, unknown>[] = [];
  const errors: { message: string; tags: ReportTags | undefined }[] = [];
  const failures: { name: string; tags: ReportTags | undefined }[] = [];
  const reporter: ErrorReporter = {
    captureError: (error, tags) =>
      errors.push({ message: error instanceof Error ? error.message : String(error), tags }),
    captureFailure: (name, tags) => failures.push({ name, tags }),
    flush: () => Promise.resolve(),
  };
  const server = unwrap(
    await startSessionServer({
      store: backing.store,
      port: 0,
      clock,
      tokenKey: KEY,
      gameMaster: {
        gameMaster: createGameMaster({
          provider,
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
          ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
          onToolError: (tool, error) => {
            reporter.captureError(error, { area: 'tool', tool });
          },
        }),
        onAudit: (audit) => audits.push(audit),
      },
      observability: {
        metrics,
        reporter,
        logger: createLogger({
          level: 'debug',
          sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
        }),
      },
    }),
  );
  running.push(server);

  const active = async (sessionId: string): Promise<SessionHandle> => {
    const handle = unwrap(await server.registry.create(createCommand(sessionId), at(0)));
    startGame(handle.session);
    unwrap(await handle.save());
    clock.set(NOW);
    return handle;
  };
  const turn = async (sessionId: string): Promise<GameMasterAudit> => {
    const taken = await server.runGameMaster(sessionId);
    if (!('invocationId' in taken)) throw new Error(`no turn: ${taken.code}`);
    return taken;
  };
  return {
    ...backing,
    server,
    provider,
    clock,
    audits,
    metrics,
    lines,
    errors,
    failures,
    active,
    turn,
  };
}

afterEach(async () => {
  await Promise.all(running.map((server) => server.shutdown()));
  running = [];
});

describe('a Game Master with tools, in a live session', () => {
  it('looks something up, proposes, and the record says which tool it used', async () => {
    const { provider, active, turn, metrics, inner } = await setup({
      replies: [ask('game_rules'), proposal(zone)],
      tools: [gameHistoryTool, gameRulesTool],
    });
    const a = await active('a');

    const audit = await turn('a');
    expect(audit).toMatchObject({
      outcome: 'APPLIED',
      eventType: 'ZONE_CHANGE',
      saved: true,
      attempts: 1,
      durationMs: 0,
    });
    expect(audit.toolCalls).toHaveLength(1);
    expect(audit.toolCalls?.[0]).toMatchObject({ name: 'game_rules', ok: true });
    expect(provider.requests).toHaveLength(2);
    expect(a.session.getState().activeModifiers).toHaveLength(1);
    expect(unwrap(await inner.load('a'))?.state.activeModifiers).toHaveLength(1);
    expect(metrics.read().counters).toMatchObject({
      game_master_invocations: 1,
      game_master_successes: 1,
      tool_invocations: 1,
      tool_failures: 0,
    });
  });

  it('leaves the record without a tool list when no tool was used', async () => {
    const { active, turn } = await setup({
      replies: [proposal(null)],
      tools: [gameRulesTool],
    });
    await active('a');
    const audit = await turn('a');
    expect(audit.outcome).toBe('NO_EVENT');
    expect('toolCalls' in audit).toBe(false);
  });

  it('gives a tool the game of its own session, and nothing of another', async () => {
    const seen: ToolScope[] = [];
    const spy = defineTool({
      name: 'who_is_playing',
      description: 'The names of the players.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ names: z.array(z.string()) }).strict(),
      execute: (_input, scope) => {
        seen.push(scope);
        return { names: scope.state.players.map((player) => player.displayName) };
      },
    });
    const { server, provider, active, turn } = await setup({
      replies: [ask('who_is_playing'), proposal(null), ask('who_is_playing'), proposal(null)],
      tools: [spy],
    });
    const a = await active('a');
    const b = unwrap(await server.registry.create(createCommand('b'), at(0)));
    for (const name of ['Bea', 'Ben', 'Bo']) {
      unwrap(
        b.session.applyCommand({ type: 'ADD_PLAYER', playerId: name, displayName: name }, at(0)),
      );
    }
    for (const name of ['Bea', 'Ben', 'Bo']) {
      unwrap(b.session.submitAction(name, { type: 'PLAYER_READY' }, at(START)));
    }

    await turn('a');
    await turn('b');
    expect(seen.map((scope) => scope.state.id)).toEqual(['a', 'b']);
    expect(seen[0]?.state).toBe(a.session.getState());
    // What the model was told after each call names that session's players only.
    const afterA = JSON.stringify(provider.requests[1]);
    const afterB = JSON.stringify(provider.requests[3]);
    expect(afterA).toContain('Player 0');
    expect(afterA).not.toMatch(/Bea|Ben/);
    expect(afterB).toContain('Bea');
    expect(afterB).not.toContain('Player 0');
  });

  it('cannot be made to change the game by a tool', async () => {
    const vandal = defineTool({
      name: 'vandal',
      description: 'Tries to change the game it was shown.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: (_input, scope) => {
        (scope.state as { status: string }).status = 'completed';
        return {};
      },
    });
    const { active, turn, errors, storeCalls } = await withStoreCalls({
      replies: [ask('vandal'), proposal(null)],
      tools: [vandal],
    });
    const a = await active('a');
    const before = a.session.getState();
    const saves = storeCalls.save;

    const audit = await turn('a');
    expect(audit.outcome).toBe('NO_EVENT');
    expect(audit.toolCalls?.[0]).toMatchObject({ name: 'vandal', ok: false, code: 'TOOL_FAILED' });
    expect(a.session.getState()).toBe(before);
    expect(a.hasUnsavedChanges()).toBe(false);
    expect(storeCalls.save).toBe(saves);
    // What it threw went to the error reporter, tagged with the tool, not to the model.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.tags).toEqual({ area: 'tool', tool: 'vandal' });
  });

  it('stops a model that only asks for tools, and the game is untouched', async () => {
    const { provider, active, turn, metrics } = await setup({
      replies: [ask('game_rules')],
      tools: [gameRulesTool],
      maxToolCalls: 2,
    });
    const a = await active('a');
    const before = a.session.getState();

    const audit = await turn('a');
    expect(audit).toMatchObject({ outcome: 'FAILED', stage: 'PROPOSAL', code: 'INVALID_PROPOSAL' });
    expect(audit.toolCalls).toHaveLength(2);
    // Two tool calls, then two attempts at a proposal: four model calls, and no more.
    expect(provider.requests).toHaveLength(4);
    expect(a.session.getState()).toBe(before);
    expect(metrics.read().counters).toMatchObject({ tool_invocations: 2, game_master_failures: 1 });
  });

  it('does not let a slow tool in one session hold up another session', async () => {
    let release: () => void = () => undefined;
    let started = false;
    const slow = defineTool({
      name: 'slow',
      description: 'Answers only when let go.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: (_input, scope) =>
        scope.state.id === 'a'
          ? new Promise<unknown>((resolve) => {
              started = true;
              release = () => {
                resolve({});
              };
            })
          : {},
    });
    const { server, active, turn } = await setup({
      // In the order the model is asked: A asks for the tool, B proposes, then A decides.
      replies: [ask('slow'), proposal(zone), proposal(null)],
      tools: [slow],
      toolTimeoutMs: 5_000,
    });
    await active('a');
    const b = await active('b');
    const waiting = server.runGameMaster('a');
    await until(() => started);

    // B takes a whole turn while A's tool has still not answered.
    expect((await turn('b')).outcome).toBe('APPLIED');
    expect(b.session.getState().activeModifiers).toHaveLength(1);
    release();
    expect(await waiting).toMatchObject({ sessionId: 'a', outcome: 'NO_EVENT' });
  });

  it('gives up on a tool that does not answer, and does not keep the session in memory for it', async () => {
    let started = false;
    const never = defineTool({
      name: 'never',
      description: 'Never answers.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: () => {
        started = true;
        return new Promise<unknown>(() => undefined);
      },
    });
    const { server, active, clock } = await setup({
      replies: [ask('never'), proposal(zone)],
      tools: [never],
      toolTimeoutMs: 30,
    });
    const a = await active('a');
    const waiting = server.runGameMaster('a');
    await until(() => started);
    // The session is evicted while the tool is still out.
    clock.set(NOW + 31 * 60_000);
    expect((await server.registry.evictIdle()).evicted).toEqual(['a']);
    const frozen = a.session.getState();

    const audit = await waiting;
    expect(audit).toMatchObject({ outcome: 'SKIPPED', code: 'SESSION_CLOSED' });
    expect('toolCalls' in audit && audit.toolCalls?.[0]).toMatchObject({ code: 'TOOL_TIMEOUT' });
    expect(a.session.getState()).toBe(frozen);
    expect(server.registry.get('a')).toBeUndefined();
  });

  it('runs no tool for a session that was closed before the tool was asked for', async () => {
    let ran = 0;
    const counted = defineTool({
      name: 'counted',
      description: 'Counts its calls.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: () => ((ran += 1), {}),
    });
    const backing = heldStore();
    const { server, active } = await setup({
      replies: [ask('counted'), proposal(zone)],
      tools: [counted],
      backing,
    });
    const a = await active('a');
    // Closed in the same turn the Game Master turn was asked for: the model is
    // never reached, and neither is the tool.
    const waiting = server.runGameMaster('a');
    await a.close();
    expect(await waiting).toMatchObject({ outcome: 'SKIPPED', code: 'SESSION_CLOSED' });
    expect(ran).toBe(0);
  });
});

describe('the record, the counters and the lines of a turn', () => {
  it('say the same thing, and none of them contains a prompt, a reply, a player or a token', async () => {
    const { server, provider, clock, audits, metrics, lines } = await setup({
      replies: [ask('game_history', { limit: 5 }), proposal({ ...zone, zone: 'the car park' })],
      tools: [gameHistoryTool],
    });
    const handle = unwrap(await server.registry.create(createCommand('a'), at(0)));
    const players = [connection(), connection(), connection()];
    const joined = players.map((who, index) => {
      send(handle.room, who, {
        type: 'join',
        joinCode: 'GRASS7',
        displayName: `Ada Secretname${String(index)}`,
      });
      const reply = who.inbox.at(-1);
      return { playerId: reply?.playerId ?? '', token: reply?.token ?? '' };
    });
    clock.set(START);
    for (const who of players) send(handle.room, who, READY, START);
    await until(() => audits.length === 1);

    expect(audits[0]).toMatchObject({
      sessionId: 'a',
      trigger: 'round_start',
      outcome: 'REJECTED',
      stage: 'SAFETY',
      code: 'UNSAFE',
      eventType: 'ZONE_CHANGE',
    });
    expect(server.recentGameMasterAudits()).toEqual(audits);
    expect(metrics.read().counters).toMatchObject({
      game_master_invocations: 1,
      game_master_safety_rejections: 1,
      game_master_successes: 0,
      tool_invocations: 1,
      session_creates: 1,
    });
    const line = lines.find((entry) => entry.msg === 'game_master_turn');
    expect(line).toMatchObject({ sessionId: 'a', outcome: 'REJECTED', stage: 'SAFETY' });
    expect(provider.requests).toHaveLength(2);

    const kept = JSON.stringify([audits, lines, metrics.read(), server.recentGameMasterAudits()]);
    for (const hidden of [
      RATIONALE,
      'car park',
      'Secretname',
      handle.hostToken,
      'GRASS7',
      ...joined.flatMap((player) => [player.token, player.playerId]),
    ]) {
      expect(kept.includes(hidden), hidden).toBe(false);
    }
    // The metrics name no session at all.
    expect(JSON.stringify(metrics.read())).not.toMatch(/"a"|sessionId/);
  });

  it('report an event that was applied but could not be saved, and leave it applied', async () => {
    const { active, turn, failing, failures, metrics } = await setup({ replies: [proposal(zone)] });
    const a = await active('a');
    failing.save.add('a');

    const audit = await turn('a');
    expect(audit).toMatchObject({ outcome: 'APPLIED', saved: false, code: 'STORAGE_ERROR' });
    // Reporting the failure undid nothing: the engine's result stands.
    expect(a.session.getState().activeModifiers).toHaveLength(1);
    expect(a.hasUnsavedChanges()).toBe(true);
    expect(failures).toEqual([
      {
        name: 'game master event applied but not saved',
        tags: { area: 'persistence', stage: 'game_master_save', code: 'STORAGE_ERROR' },
      },
    ]);
    expect(metrics.read().counters.persistence_failures).toBe(1);
    failing.save.clear();
  });

  it('report an unexpected error with the model and no session, and the game goes on', async () => {
    const backing = heldStore();
    const errors: { message: string; tags: ReportTags | undefined }[] = [];
    const metrics = createMetrics();
    const server = unwrap(
      await startSessionServer({
        store: backing.store,
        port: 0,
        clock: testClock(),
        gameMaster: {
          gameMaster: {
            provider: 'fake',
            model: 'fake-model',
            propose: () => {
              throw new Error('LEAK_MARKER something broke inside for session a');
            },
          },
        },
        observability: {
          metrics,
          reporter: {
            captureError: (error, tags) => errors.push({ message: (error as Error).message, tags }),
            captureFailure: () => undefined,
            flush: () => Promise.resolve(),
          },
        },
      }),
    );
    running.push(server);
    const handle = unwrap(await server.registry.create(createCommand('a'), at(0)));
    startGame(handle.session);
    const before = handle.session.getState();

    const audit = await server.runGameMaster('a');
    expect(audit).toMatchObject({ outcome: 'FAILED', code: 'UNEXPECTED' });
    expect(JSON.stringify(audit)).not.toContain('LEAK_MARKER');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.tags).toEqual({
      area: 'game_master',
      stage: 'turn',
      provider: 'fake',
      model: 'fake-model',
    });
    expect(metrics.read().counters).toMatchObject({
      unexpected_errors: 1,
      game_master_failures: 1,
    });
    expect(handle.session.getState()).toBe(before);
  });

  it('are not needed: with no observability and a listener that throws, a turn is the same', async () => {
    const backing = heldStore();
    const provider = scriptedModelProvider([proposal(zone)]);
    const clock = testClock();
    clock.set(NOW);
    const server = unwrap(
      await startSessionServer({
        store: backing.store,
        port: 0,
        clock,
        gameMaster: {
          gameMaster: createGameMaster({ provider }),
          onAudit: () => {
            throw new Error('the audit listener broke');
          },
        },
      }),
    );
    running.push(server);
    const handle = unwrap(await server.registry.create(createCommand('a'), at(0)));
    startGame(handle.session);
    const audit = await server.runGameMaster('a');
    expect(audit).toMatchObject({ outcome: 'APPLIED', saved: true });
    expect(handle.session.getState().activeModifiers).toHaveLength(1);
    expect(unwrap(await backing.inner.load('a'))?.state.activeModifiers).toHaveLength(1);
    expect(server.recentGameMasterAudits()).toHaveLength(1);
  });
});

describe('Z. the whole way, with a tool, over real sockets', () => {
  it('model → tool → proposal → schema → safety → engine → store → clients → record, counters and lines', async () => {
    const { server, inner, clock, audits, metrics, lines, failures, errors } = await setup({
      replies: [ask('game_rules'), proposal(zone)],
      tools: [gameRulesTool],
    });
    unwrap(await server.registry.create(createCommand('a'), at(0)));
    unwrap(await server.registry.create(createCommand('b'), at(0)));
    const clients = await Promise.all([1, 2, 3].map(() => Client.open(server.port, 'a')));
    const bystander = await Client.open(server.port, 'b');
    await bystander.join('Bo');
    for (const [index, client] of clients.entries()) {
      await client.join(`Player ${String(index)}`);
      for (const earlier of clients.slice(0, index)) await earlier.next();
    }
    clock.set(START);
    for (const client of clients) client.send(READY);
    await until(() => audits.length === 1);

    expect(audits[0]).toMatchObject({
      sessionId: 'a',
      trigger: 'round_start',
      outcome: 'APPLIED',
      eventType: 'ZONE_CHANGE',
      saved: true,
    });
    expect(audits[0]?.toolCalls).toMatchObject([{ name: 'game_rules', ok: true }]);

    for (const client of clients) {
      let update = await client.next();
      while (!JSON.stringify(update).includes('the bench')) update = await client.next();
      expect(update.type).toBe('update');
    }
    expect(unwrap(await inner.load('a'))?.state.activeModifiers).toMatchObject([
      { zone: 'the bench' },
    ]);
    expect(bystander.raw.join('')).not.toContain('the bench');

    expect(metrics.read().counters).toMatchObject({
      session_creates: 2,
      websocket_connections_opened: 4,
      websocket_connections_refused: 0,
      game_master_invocations: 1,
      game_master_successes: 1,
      tool_invocations: 1,
      tool_failures: 0,
      persistence_failures: 0,
      unexpected_errors: 0,
    });
    expect(
      lines.some((line) => line.msg === 'game_master_turn' && line.outcome === 'APPLIED'),
    ).toBe(true);
    expect(lines.filter((line) => line.msg === 'session' && line.type === 'created')).toHaveLength(
      2,
    );
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);

    // A socket that is refused, and sockets that close, are counted too.
    const lost = await Client.open(server.port, 'nothing-here');
    await lost.closed;
    await until(() => metrics.read().counters.websocket_connections_refused === 1);
    clients[0]?.socket.close();
    await until(() => metrics.read().counters.websocket_connections_closed >= 2);
  });
});

/** The same setup, with the store's call counts named apart from everything else. */
async function withStoreCalls(options: Parameters<typeof setup>[0]) {
  const backing = heldStore();
  const made = await setup({ ...options, backing });
  return { ...made, storeCalls: backing.calls };
}
