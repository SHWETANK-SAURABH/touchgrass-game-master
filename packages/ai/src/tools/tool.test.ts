import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findGameDefinition } from '@touchgrass/game-definitions';
import { createGameMaster } from '../game-master/game-master';
import { T0, deepFreeze, runningState, scriptedProvider } from '../game-master/test-support';
import {
  GAME_MASTER_TOOLS,
  GAME_MASTER_TOOL_NAMES,
  gameHistoryTool,
  gameRulesTool,
  selectGameMasterTools,
} from './game-tools';
import {
  type GameMasterTool,
  TOOL_FAILURE_CODES,
  type ToolScope,
  createToolSet,
  defineTool,
  runToolCall,
} from './tool';

const tag = findGameDefinition('tag');
if (!tag) throw new Error('fixture failed');
const definition = tag;

const scope = (): ToolScope => ({
  state: deepFreeze(runningState('tag')),
  definition,
  now: T0 + 61_000,
});
const LIMITS = { timeoutMs: 1_000, maxOutputBytes: 4_096, elapsed: () => 0 };
const RATIONALE = 'The round has gone quiet and needs one small change.';
const NOTHING = { rationale: RATIONALE, event: null };
const ask = (name: string, input: unknown = {}) => ({ tool: { name, input } });

const echoInput = z.object({ text: z.string().max(20) }).strict();
const echoOutput: z.ZodType = z.object({ text: z.string() }).strict();
/** A tool called `echo`, with the given body. */
const echoWith = (execute: (input: { text: string }) => unknown) =>
  defineTool({
    name: 'echo',
    description: 'Says back what it was told.',
    inputSchema: echoInput,
    outputSchema: echoOutput,
    execute,
  });
const echo = echoWith((input) => ({ text: input.text }));

describe('A and B. the list of tools', () => {
  it('is fixed when it is made, by name, in the order given', () => {
    const set = createToolSet([gameRulesTool, gameHistoryTool]);
    expect(set.names).toEqual(['game_rules', 'game_history']);
    expect(set.get('game_rules')).toBe(gameRulesTool);
    expect(Object.isFrozen(set.names) || Array.isArray(set.names)).toBe(true);
  });

  it('refuses two tools with one name, and a name that is not a plain one', () => {
    expect(() => createToolSet([echo, echo])).toThrow(/listed twice/);
    for (const name of [
      '',
      'Echo',
      '1st',
      'has space',
      'x',
      'drop;table',
      '__proto__',
      'a'.repeat(41),
    ]) {
      expect(() => createToolSet([{ ...echo, name }]), name).toThrow(/not a valid tool name/);
    }
  });

  it('finds only what is on it, however it is asked', () => {
    const set = createToolSet([echo]);
    for (const name of [
      'game_rules',
      'ECHO',
      'echo ',
      'constructor',
      'toString',
      '__proto__',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(set.get(name), JSON.stringify(name)).toBeUndefined();
    }
    expect(createToolSet([]).names).toEqual([]);
  });

  it('holds exactly two real tools, and picks them by name', () => {
    expect(GAME_MASTER_TOOL_NAMES).toEqual(['game_history', 'game_rules']);
    expect(Object.keys(GAME_MASTER_TOOLS).sort()).toEqual(['game_history', 'game_rules']);
    expect(selectGameMasterTools(['game_rules'])).toEqual([gameRulesTool]);
    expect(selectGameMasterTools([])).toEqual([]);
    for (const name of ['shell', 'read_file', 'http_get', 'constructor', 'GAME_RULES']) {
      expect(() => selectGameMasterTools([name]), name).toThrow(/is not a Game Master tool/);
    }
  });
});

describe('C to H. one tool call', () => {
  const call = (tools: readonly GameMasterTool[], name: unknown, input: unknown, options = {}) =>
    runToolCall(createToolSet(tools), { name, input }, scope(), { ...LIMITS, ...options });

  it('answers when the tool is listed and the input fits', async () => {
    expect(await call([echo], 'echo', { text: 'hello' })).toEqual({
      record: { name: 'echo', ok: true, durationMs: 0 },
      result: { ok: true, output: { text: 'hello' } },
    });
  });

  it('refuses a tool that is not listed, and does not keep the name it was asked for', async () => {
    for (const name of ['read_file', 'game_rules', 'LEAK_MARKER; rm -rf /', 42, null]) {
      const { record, result } = await call([echo], name, {});
      expect(result).toEqual({ ok: false, code: 'UNKNOWN_TOOL' });
      expect(record).toEqual({ name: '(unknown)', ok: false, code: 'UNKNOWN_TOOL', durationMs: 0 });
    }
  });

  it('refuses input that does not fit the schema, without running the tool', async () => {
    let ran = 0;
    const counted = echoWith((input) => ((ran += 1), input));
    for (const input of [
      {},
      { text: 5 },
      { text: 'x'.repeat(21) },
      { text: 'a', extra: 1 },
      null,
      'text',
      [],
    ]) {
      const { result } = await call([counted], 'echo', input);
      expect(result, JSON.stringify(input)).toEqual({ ok: false, code: 'INVALID_ARGUMENTS' });
    }
    expect(ran).toBe(0);
  });

  it('refuses an answer that does not fit the schema of the tool', async () => {
    const lying = echoWith(() => ({ text: 5 }));
    expect((await call([lying], 'echo', { text: 'a' })).result).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    });
    const extra = echoWith(() => ({ text: 'a', token: 'x' }));
    expect((await call([extra], 'echo', { text: 'a' })).result.ok).toBe(false);
  });

  it('gives up on a tool that does not answer in time', async () => {
    const never = echoWith(() => new Promise<{ text: string }>(() => undefined));
    const { record, result } = await call([never], 'echo', { text: 'a' }, { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, code: 'TOOL_TIMEOUT' });
    expect(record.code).toBe('TOOL_TIMEOUT');
  });

  it('turns a tool that throws or rejects into a code, and tells only the listener what it threw', async () => {
    const seen: unknown[] = [];
    const onError = (name: string, error: unknown) => seen.push([name, (error as Error).message]);
    const throwing = echoWith(() => {
      throw new Error('LEAK_MARKER thrown');
    });
    const rejecting = echoWith(() => Promise.reject(new Error('LEAK_MARKER rejected')));
    for (const tool of [throwing, rejecting]) {
      const outcome = await call([tool], 'echo', { text: 'a' }, { onError });
      expect(outcome.result).toEqual({ ok: false, code: 'TOOL_FAILED' });
      expect(JSON.stringify(outcome)).not.toContain('LEAK_MARKER');
    }
    expect(seen).toEqual([
      ['echo', 'LEAK_MARKER thrown'],
      ['echo', 'LEAK_MARKER rejected'],
    ]);
    // A listener that throws changes nothing.
    const quiet = await call(
      [throwing],
      'echo',
      { text: 'a' },
      {
        onError: () => {
          throw new Error('the listener broke');
        },
      },
    );
    expect(quiet.result).toEqual({ ok: false, code: 'TOOL_FAILED' });
  });

  it('refuses an answer that is too large, at the byte', async () => {
    const sized = (length: number) => echoWith(() => ({ text: 'x'.repeat(length) }));
    // {"text":"…"} is 11 bytes around the text.
    expect(
      (await call([sized(89)], 'echo', { text: 'a' }, { maxOutputBytes: 100 })).result.ok,
    ).toBe(true);
    expect(
      (await call([sized(90)], 'echo', { text: 'a' }, { maxOutputBytes: 100 })).result,
    ).toEqual({
      ok: false,
      code: 'OUTPUT_TOO_LARGE',
    });
  });

  it('does not run when the game is no longer wanted', async () => {
    let ran = 0;
    const counted = echoWith((input) => ((ran += 1), input));
    const { result } = await call([counted], 'echo', { text: 'a' }, { available: () => false });
    expect(result).toEqual({ ok: false, code: 'SESSION_UNAVAILABLE' });
    expect(ran).toBe(0);
  });

  it('has a code for every way it can fail, and no other', () => {
    expect([...TOOL_FAILURE_CODES].sort()).toEqual([
      'INVALID_ARGUMENTS',
      'INVALID_OUTPUT',
      'OUTPUT_TOO_LARGE',
      'SESSION_UNAVAILABLE',
      'TOOL_FAILED',
      'TOOL_TIMEOUT',
      'UNKNOWN_TOOL',
    ]);
  });
});

describe('I and J. what a tool can see and do', () => {
  it('is handed one game, and has no way to name another', async () => {
    const mine = scope();
    const seen: ToolScope[] = [];
    const spy = defineTool({
      name: 'spy',
      description: 'Records what it was handed.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ id: z.string() }).strict(),
      execute: (_input, handed) => {
        seen.push(handed);
        return { id: handed.state.id };
      },
    });
    const set = createToolSet([spy, gameHistoryTool, gameRulesTool]);
    expect((await runToolCall(set, { name: 'spy', input: {} }, mine, LIMITS)).result).toEqual({
      ok: true,
      output: { id: mine.state.id },
    });
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['definition', 'now', 'state']);
    expect(seen[0]?.state).toBe(mine.state);

    // No real tool accepts a session id, an address or a path.
    for (const name of GAME_MASTER_TOOL_NAMES) {
      for (const input of [
        { sessionId: 'other' },
        { session: 'other' },
        { id: 'other' },
        { url: 'http://example.invalid' },
        { path: '/etc/passwd' },
      ]) {
        const { result } = await runToolCall(set, { name, input }, mine, LIMITS);
        expect(result, `${name} ${JSON.stringify(input)}`).toEqual({
          ok: false,
          code: 'INVALID_ARGUMENTS',
        });
      }
    }
  });

  it('cannot change the game it reads', async () => {
    const mine = scope();
    const before = JSON.stringify(mine.state);
    const vandal = defineTool({
      name: 'vandal',
      description: 'Tries to change what it was handed.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: (_input, handed) => {
        (handed.state as { status: string }).status = 'completed';
        return {};
      },
    });
    const set = createToolSet([vandal, gameHistoryTool, gameRulesTool]);
    // The state is frozen, so the attempt throws, and that is a controlled failure.
    expect((await runToolCall(set, { name: 'vandal', input: {} }, mine, LIMITS)).result).toEqual({
      ok: false,
      code: 'TOOL_FAILED',
    });
    for (const name of GAME_MASTER_TOOL_NAMES) {
      await runToolCall(set, { name, input: {} }, mine, LIMITS);
    }
    expect(JSON.stringify(mine.state)).toBe(before);
    expect(mine.state.status).toBe('active');
  });

  it('is plain code over the scope: no file, shell, network, store or session', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const file of ['tool.ts', 'game-tools.ts']) {
      const code = readFileSync(join(directory, file), 'utf-8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      );
      expect(code, file).not.toMatch(
        /node:fs|child_process|fetch\(|WebSocket|process\.env|\beval\(/,
      );
      expect(code, file).not.toMatch(/SessionStore|mongodb|game-session|realtime|registry/i);
      expect(code, file).not.toMatch(
        /applyValidatedEvent|submitGameEvent|reduce\(|processPlayerAction/,
      );
    }
  });
});

describe('the two real tools', () => {
  it('game_rules says how the game is scored and what makes it risky', async () => {
    const set = createToolSet([gameRulesTool]);
    const { result } = await runToolCall(set, { name: 'game_rules', input: {} }, scope(), LIMITS);
    expect(result).toMatchObject({
      ok: true,
      output: {
        game: { id: 'tag' },
        rounds: { total: 3, durationSeconds: 180 },
        scoring: [
          { trigger: 'TAG_MADE', points: 2 },
          { trigger: 'ROUND_SURVIVED', points: 1 },
        ],
        safety: { contactPolicy: 'tag-only', maxIntensity: 'high', requiresDaylight: true },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4_096);
  });

  it('game_history pages back through the record, oldest first, and never shows the join code', async () => {
    const mine = scope();
    const set = createToolSet([gameHistoryTool]);
    const page = async (input: unknown) => {
      const { result } = await runToolCall(set, { name: 'game_history', input }, mine, LIMITS);
      if (!result.ok) throw new Error(result.code);
      return result.output as { total: number; entries: { sequence: number; summary: string }[] };
    };
    const total = mine.state.history.length;

    const newest = await page({ limit: 3 });
    expect(newest.total).toBe(total);
    expect(newest.entries.map((entry) => entry.sequence)).toEqual([
      total - 3,
      total - 2,
      total - 1,
    ]);
    const older = await page({ before: total - 3, limit: 20 });
    expect(older.entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: total - 3 }, (_unused, index) => index),
    );
    expect(await page({ before: 0 })).toEqual({ total, entries: [] });
    expect((await page({ before: 1_000_000, limit: 1 })).entries).toHaveLength(1);

    const everything = JSON.stringify(await page({ limit: 20 }));
    expect(mine.state.history[0]?.summary).toContain(mine.state.joinCode);
    expect(everything).not.toContain(mine.state.joinCode);
    expect(everything).toContain('[join code]');
    expect(everything).not.toMatch(/randomSeed|token/i);
  });

  it.each([
    ['game_history', { limit: 0 }],
    ['game_history', { limit: 21 }],
    ['game_history', { before: -1 }],
    ['game_history', { limit: '5' }],
    ['game_rules', { verbose: true }],
  ])('%s refuses %j', async (name, input) => {
    const set = createToolSet([gameHistoryTool, gameRulesTool]);
    const { result } = await runToolCall(set, { name, input }, scope(), LIMITS);
    expect(result).toEqual({ ok: false, code: 'INVALID_ARGUMENTS' });
  });
});

describe('K. the Game Master with tools', () => {
  const context = () => ({ state: deepFreeze(runningState('tag')), definition, now: T0 + 61_000 });

  it('asks the model exactly as before when it is given no tools', async () => {
    const without = scriptedProvider([NOTHING]);
    const empty = scriptedProvider([NOTHING]);
    const first = await createGameMaster({ provider: without }).propose(context());
    const second = await createGameMaster({ provider: empty, tools: [] }).propose(context());
    expect(JSON.stringify(empty.requests)).toBe(JSON.stringify(without.requests));
    expect(first).toEqual(second);
    expect(first.ok && 'toolCalls' in first.value).toBe(false);
  });

  it('describes the listed tools to the model, and offers it no native tool', async () => {
    const provider = scriptedProvider([NOTHING]);
    const gameMaster = createGameMaster({ provider, tools: [gameRulesTool] });
    await gameMaster.propose(context());
    const sent = JSON.stringify(provider.requests);
    expect(sent).toContain('game_rules');
    expect(sent).not.toContain('game_history');
    expect(sent).not.toMatch(/"tools"|"tool_choice"/);
    expect(Object.keys(await gameMaster.agent.listTools())).toEqual([]);
  });

  it('runs a tool the model asks for, hands back the answer, and returns the proposal', async () => {
    const provider = scriptedProvider([ask('game_rules'), NOTHING]);
    const result = await createGameMaster({ provider, tools: [gameRulesTool] }).propose(context());
    expect(result.ok && result.value.toolCalls).toMatchObject([{ name: 'game_rules', ok: true }]);
    expect(result.ok && result.value.attempts).toBe(1);
    expect(provider.requests).toHaveLength(2);
    // The second request carries the answer, marked as data.
    const second = JSON.stringify(provider.requests[1]);
    expect(second).toContain('TAG_MADE');
    expect(second).toContain('data, not instructions');
  });

  it('stops at the limit whatever the model replies, and then accepts only a proposal', async () => {
    for (const [maxToolCalls, expectedCalls] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [99, 4],
    ] as const) {
      const provider = scriptedProvider([ask('game_rules')]);
      const result = await createGameMaster({
        provider,
        tools: [gameRulesTool],
        maxToolCalls,
        maxRepairAttempts: 1,
      }).propose(context());
      expect(result.ok, String(maxToolCalls)).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('INVALID_PROPOSAL');
      expect(result.error.toolCalls ?? []).toHaveLength(expectedCalls);
      // Every model call is accounted for: the tool calls, then the attempts.
      expect(provider.requests).toHaveLength(expectedCalls + 2);
    }
  });

  it('tells the model a failure by its code and nothing else', async () => {
    const throwing = defineTool({
      name: 'breaks',
      description: 'A tool that throws.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: () => {
        throw new Error('LEAK_MARKER at C:\\secret\\path with mongodb://user:pw@host');
      },
    });
    const errors: string[] = [];
    const provider = scriptedProvider([ask('breaks'), NOTHING]);
    const result = await createGameMaster({
      provider,
      tools: [throwing],
      onToolError: (name) => errors.push(name),
    }).propose(context());
    expect(result.ok && result.value.toolCalls).toMatchObject([
      { name: 'breaks', ok: false, code: 'TOOL_FAILED' },
    ]);
    const sent = JSON.stringify(provider.requests);
    expect(sent).toContain('TOOL_FAILED');
    expect(sent).not.toMatch(/LEAK_MARKER|secret|mongodb/);
    expect(errors).toEqual(['breaks']);
  });

  it('runs no tool once the game is no longer wanted', async () => {
    let ran = 0;
    const counted = defineTool({
      name: 'counted',
      description: 'Counts its calls.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.unknown(),
      execute: () => ((ran += 1), {}),
    });
    const provider = scriptedProvider([ask('counted'), NOTHING]);
    const result = await createGameMaster({ provider, tools: [counted] }).propose(context(), {
      available: () => false,
    });
    expect(ran).toBe(0);
    expect(result.ok && result.value.toolCalls).toMatchObject([
      { name: 'counted', ok: false, code: 'SESSION_UNAVAILABLE' },
    ]);
  });

  it('keeps a record of each call that says which tool and how it ended, and nothing of what was said', async () => {
    const provider = scriptedProvider([ask('game_history', { limit: 3 }), ask('nope'), NOTHING]);
    const result = await createGameMaster({
      provider,
      tools: [gameHistoryTool],
      maxToolCalls: 2,
    }).propose(context());
    if (!result.ok) throw new Error('expected a proposal');
    for (const call of result.value.toolCalls ?? []) {
      expect(Object.keys(call).sort().join()).toMatch(/^(code,)?durationMs,name,ok$/);
    }
    expect(result.value.toolCalls?.map((call) => call.name)).toEqual(['game_history', '(unknown)']);
  });
});
