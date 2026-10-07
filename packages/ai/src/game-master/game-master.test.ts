import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServerEnv } from '@touchgrass/shared';
import { getGameDefinition } from '@touchgrass/game-definitions';
import { ModelProviderError } from '../provider/errors';
import { buildGameMasterView } from './context';
import { createGameMaster, createGameMasterFromEnv } from './game-master';
import { GAME_MASTER_SYSTEM_PROMPT } from './prompt';
import { gameMasterProposalSchema } from './proposal';
import {
  T0,
  contextFor,
  deepFreeze,
  lobbyState,
  runningState,
  scriptedProvider,
} from './test-support';

const ZONE = {
  rationale: 'The chase has gone quiet, so a short safe spot adds a decision.',
  event: {
    type: 'ZONE_CHANGE',
    modifier: 'SAFE_ZONE',
    zone: 'the bench by the gate',
    durationSeconds: 45,
  },
};
const NOTHING = {
  rationale: 'Two tags in the last minute; the round needs nothing added.',
  event: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Game Master: proposing', () => {
  it('takes typed game context and returns a proposed event with its rationale', async () => {
    const result = await createGameMaster({ provider: scriptedProvider([ZONE]) }).propose(
      contextFor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposal).toEqual(ZONE);
    expect(result.value.attempts).toBe(1);
    expect(result.value.provider).toBe('scripted');
    expect(result.value.model).toBe('scripted-model');
  });

  it('can decide that no event is appropriate', async () => {
    const result = await createGameMaster({ provider: scriptedProvider([NOTHING]) }).propose(
      contextFor(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposal.event).toBeNull();
    expect(result.value.proposal.rationale).toBe(NOTHING.rationale);
  });

  it('returns output that conforms to the proposal schema', async () => {
    for (const reply of [ZONE, NOTHING]) {
      const result = await createGameMaster({ provider: scriptedProvider([reply]) }).propose(
        contextFor(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(gameMasterProposalSchema.safeParse(result.value.proposal).success).toBe(true);
    }
  });

  it('returns a proposal and nothing else: the game it was shown is unchanged', async () => {
    const context = deepFreeze(contextFor());
    const snapshot = structuredClone(context);

    const result = await createGameMaster({ provider: scriptedProvider([ZONE]) }).propose(context);

    // A frozen context would have thrown on any write; and it still equals its copy.
    expect(result.ok).toBe(true);
    expect(context).toEqual(snapshot);
    expect(context.state.activeModifiers).toEqual([]);
    expect(context.state.history).toHaveLength(snapshot.state.history.length);
  });

  it('does not mutate the game when the model fails or replies badly either', async () => {
    const context = deepFreeze(contextFor());
    const snapshot = structuredClone(context);
    await createGameMaster({
      provider: scriptedProvider([new ModelProviderError('PROVIDER_UNREACHABLE', 'down')]),
    }).propose(context);
    await createGameMaster({ provider: scriptedProvider(['not json at all']) }).propose(context);
    expect(context).toEqual(snapshot);
  });
});

describe('Game Master: what it may not propose', () => {
  const propose = async (event: unknown) =>
    createGameMaster({
      provider: scriptedProvider([{ rationale: ZONE.rationale, event }]),
      maxRepairAttempts: 0,
    }).propose(contextFor());

  it.each([
    { type: 'ROUND_START', round: 2, durationSeconds: 180 },
    { type: 'ROUND_END', round: 1 },
    { type: 'GAME_END', reason: 'ROUNDS_COMPLETE' },
    { type: 'PLAYER_OUT', playerId: 'p1', byPlayerId: 'p0', reason: 'FOUND' },
    { type: 'POWER_ACTIVATED', playerId: 'p1', powerId: 'shield', durationSeconds: 20 },
    { type: 'OBJECTIVE_COMPLETED', playerId: 'p1', objectiveId: 'o1', points: 5 },
  ])('rejects the engine-only event $type', async (event) => {
    const result = await propose(event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PROPOSAL');
    expect(result.error.issues?.join(' ')).toMatch(/event\.type/);
  });

  it('rejects a ROLE_CHANGE that claims to be a player tag', async () => {
    const result = await propose({
      type: 'ROLE_CHANGE',
      assignments: [
        { playerId: 'p1', roleId: 'tagger' },
        { playerId: 'p0', roleId: 'runner' },
      ],
      cause: { reason: 'TAGGED', byPlayerId: 'p0', targetPlayerId: 'p1' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PROPOSAL');
    expect(result.error.issues?.join(' ')).toMatch(/cause/);
  });

  it('accepts a plain ROLE_CHANGE, which carries no cause', async () => {
    const result = await propose({
      type: 'ROLE_CHANGE',
      assignments: [
        { playerId: 'p1', roleId: 'tagger' },
        { playerId: 'p0', roleId: 'runner' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an event kind the game being played does not support', async () => {
    // CHALLENGE is a legitimate external event, but Tag does not allow it.
    const result = await propose({
      type: 'CHALLENGE',
      challengeId: 'c1',
      description: 'Touch three trees.',
      playerIds: ['p1'],
      points: 2,
      durationSeconds: 60,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues?.join(' ')).toMatch(/ZONE_CHANGE/);
  });

  it.each([
    ['a score', { ...ZONE, score: 100 }],
    ['a state patch', { ...ZONE, state: { players: [] } }],
    ['a score inside the event', { ...ZONE, event: { ...ZONE.event, points: 50 } }],
    ['an out-of-range duration', { ...ZONE, event: { ...ZONE.event, durationSeconds: 99_999 } }],
    ['no rationale', { event: ZONE.event }],
    ['several events', { rationale: ZONE.rationale, event: [ZONE.event, ZONE.event] }],
  ])('rejects a reply carrying %s', async (_label, reply) => {
    const result = await createGameMaster({
      provider: scriptedProvider([reply]),
      maxRepairAttempts: 0,
    }).propose(contextFor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PROPOSAL');
  });
});

describe('Game Master: what the model is given', () => {
  it('sends the system prompt and a read-only description of the game', async () => {
    const provider = scriptedProvider([NOTHING]);
    const context = contextFor();
    await createGameMaster({ provider }).propose(context);

    const [system, user] = provider.requests[0]?.messages ?? [];
    expect(system).toEqual({ role: 'system', content: GAME_MASTER_SYSTEM_PROMPT });
    expect(user?.role).toBe('user');
    expect(user?.content).toContain(JSON.stringify(buildGameMasterView(context), null, 2));
  });

  it('constrains decoding to the event kinds this game allows, and to no engine-only kind', async () => {
    const provider = scriptedProvider([NOTHING]);
    await createGameMaster({ provider }).propose(contextFor('tag'));

    const request = provider.requests[0];
    const schema = JSON.stringify(request && 'jsonSchema' in request ? request.jsonSchema : null);
    for (const kind of getGameDefinition('tag').allowedEventKinds) expect(schema).toContain(kind);
    for (const forbidden of [
      'CHALLENGE',
      'RULE_MODIFIER',
      'ROUND_START',
      'ROUND_END',
      'GAME_END',
      'PLAYER_OUT',
      'POWER_ACTIVATED',
      'OBJECTIVE_COMPLETED',
      'cause',
    ]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it('passes no tools to the model', async () => {
    const provider = scriptedProvider([NOTHING]);
    await createGameMaster({ provider }).propose(contextFor());
    expect(JSON.stringify(provider.requests[0])).not.toMatch(/"tools"/);
  });

  it('describes players, roles, time left and what is allowed, and omits players who left', () => {
    const state = runningState();
    const view = buildGameMasterView({
      state: {
        ...state,
        players: state.players.map((player) =>
          player.id === 'p2' ? { ...player, status: 'left' as const } : player,
        ),
      },
      definition: getGameDefinition('tag'),
      now: T0 + 61_000,
    });

    expect(view.players.map((player) => player.id)).toEqual(['p0', 'p1']);
    expect(view.round).toEqual({ current: 1, total: 3, secondsRemaining: 120 });
    expect(view.allowed.eventKinds).toEqual(getGameDefinition('tag').allowedEventKinds);
    expect(view.allowed.powers.map((power) => power.id)).toEqual(['shield']);
    expect(view.recentHistory.at(-1)?.summary).toMatch(/Round 1 started/);
  });
});

describe('Game Master: repair and failure', () => {
  const badDuration = { ...ZONE, event: { ...ZONE.event, durationSeconds: 99_999 } };

  it('asks once more when a reply is invalid, naming the field', async () => {
    const provider = scriptedProvider([badDuration, ZONE]);
    const result = await createGameMaster({ provider }).propose(contextFor());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    const repair = provider.requests[1]?.messages.at(-1);
    expect(repair?.role).toBe('user');
    expect(repair?.content).toMatch(/event\.durationSeconds/);
  });

  it('treats a reply that is not JSON as an invalid attempt, not a dead model', async () => {
    const provider = scriptedProvider(['Sure! Here is a twist for you.', ZONE]);
    const result = await createGameMaster({ provider }).propose(contextFor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
  });

  it('gives up after the repair budget and reports what was wrong', async () => {
    const provider = scriptedProvider([badDuration]);
    const result = await createGameMaster({ provider, maxRepairAttempts: 2 }).propose(contextFor());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PROPOSAL');
    expect(result.error.attempts).toBe(3);
    expect(result.error.issues?.join(' ')).toMatch(/durationSeconds/);
    expect(result.error.raw).toContain('99999');
    expect(provider.requests).toHaveLength(3);
  });

  it('does not call the model when the game is not in a running round', async () => {
    const provider = scriptedProvider([ZONE]);
    const result = await createGameMaster({ provider }).propose({
      state: lobbyState(),
      definition: getGameDefinition('tag'),
      now: T0 + 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('GAME_NOT_ACTIVE');
    expect(provider.requests).toHaveLength(0);
  });

  it('refuses a definition that is not the game being played', async () => {
    const provider = scriptedProvider([ZONE]);
    const result = await createGameMaster({ provider }).propose({
      ...contextFor('tag'),
      definition: getGameDefinition('hide-and-seek'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONTEXT');
    expect(provider.requests).toHaveLength(0);
  });
});

describe('Game Master: model configuration and Ollama', () => {
  const env = (overrides: Record<string, string> = {}) =>
    parseServerEnv({ MODEL_MAX_RETRIES: '0', ...overrides });

  /** Replaces fetch, records every call, and answers with `respond`. */
  function stubFetch(respond: () => Response | Error) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
            string,
            unknown
          >,
        });
        const result = respond();
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }),
    );
    return calls;
  }

  const ollamaReply = (content: string) =>
    new Response(JSON.stringify({ model: 'gemma3:4b', message: { content } }), { status: 200 });

  it('defaults to Gemma on a local Ollama', () => {
    const gameMaster = createGameMasterFromEnv(env());
    expect(gameMaster.provider).toBe('ollama');
    expect(gameMaster.model).toBe('gemma3:4b');
  });

  it('takes the provider and model from the environment', () => {
    const gameMaster = createGameMasterFromEnv(
      env({
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_NAME: 'google/gemma-3-12b-it',
        MODEL_BASE_URL: 'http://gpu-host:8000/v1',
      }),
    );
    expect(gameMaster.provider).toBe('openai-compatible');
    expect(gameMaster.model).toBe('google/gemma-3-12b-it');
  });

  it('calls the configured Ollama with the configured model and a schema-constrained format', async () => {
    const calls = stubFetch(() => ollamaReply(JSON.stringify(ZONE)));
    const gameMaster = createGameMasterFromEnv(
      env({ MODEL_NAME: 'gemma3:12b', MODEL_BASE_URL: 'http://ollama.internal:11434' }),
    );

    const result = await gameMaster.propose(contextFor());

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://ollama.internal:11434/api/chat');
    expect(calls[0]?.body.model).toBe('gemma3:12b');
    expect(calls[0]?.body.stream).toBe(false);
    expect(JSON.stringify(calls[0]?.body.format)).toContain('ZONE_CHANGE');
    expect(calls[0]?.body.tools).toBeUndefined();
  });

  it('reports an unreachable Ollama as a typed error, and calls no other model', async () => {
    const calls = stubFetch(() => new TypeError('fetch failed'));
    const result = await createGameMasterFromEnv(env()).propose(contextFor());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MODEL_UNAVAILABLE');
    expect(result.error.modelErrorCode).toBe('PROVIDER_UNREACHABLE');
    expect(result.error.message).toMatch(/ollama is unreachable at http:\/\/localhost:11434/);
    expect(calls.map((call) => call.url)).toEqual(['http://localhost:11434/api/chat']);
  });

  it('reports a model that has not been pulled as MODEL_NOT_AVAILABLE', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'model "gemma3:4b" not found, try pulling it first' }),
          {
            status: 404,
            statusText: 'Not Found',
          },
        ),
    );
    const result = await createGameMasterFromEnv(env()).propose(contextFor());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MODEL_UNAVAILABLE');
    expect(result.error.modelErrorCode).toBe('MODEL_NOT_AVAILABLE');
    expect(result.error.message).toMatch(/not found/);
  });

  it('reports a timeout as PROVIDER_TIMEOUT', async () => {
    stubFetch(() => Object.assign(new Error('timed out'), { name: 'AbortError' }));
    const result = await createGameMasterFromEnv(env()).propose(contextFor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.modelErrorCode).toBe('PROVIDER_TIMEOUT');
  });

  it('does not retry a model failure as if it were a bad reply', async () => {
    const provider = scriptedProvider([
      new ModelProviderError('PROVIDER_UNREACHABLE', 'down'),
      ZONE,
    ]);
    const result = await createGameMaster({ provider, maxRepairAttempts: 3 }).propose(contextFor());
    expect(result.ok).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });
});

describe('Game Master: no way to change the game', () => {
  it('has no tools', async () => {
    const gameMaster = createGameMaster({ provider: scriptedProvider([NOTHING]) });
    expect(Object.keys(await gameMaster.agent.listTools())).toEqual([]);
  });

  it('exposes only propose: no method that applies anything', () => {
    const gameMaster = createGameMaster({ provider: scriptedProvider([NOTHING]) });
    expect(Object.keys(gameMaster).sort()).toEqual(['agent', 'model', 'propose', 'provider']);
  });

  it('imports no engine entry point that can change a game', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(directory)
      // Test files build a running game through the engine; the module must not.
      .filter((file) => file.endsWith('.ts') && !/(\.test|\.live|test-support)\.ts$/.test(file))
      .map((file) => ({ file, text: readFileSync(join(directory, file), 'utf-8') }));

    expect(sources.map((source) => source.file).sort()).toEqual([
      'context.ts',
      'game-master.ts',
      'index.ts',
      'model-adapter.ts',
      'prompt.ts',
      'proposal.ts',
    ]);

    const forbidden =
      /\b(submitGameEvent|processPlayerAction|advanceTime|createSession|reduce|step|replay|applyEvent|applyAwards|awardsForEvent)\b/;
    for (const { file, text } of sources) {
      const engineImports = [
        ...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@touchgrass\/game-engine'/g),
      ]
        .map((match) => match[1] ?? '')
        .join(',');
      expect(forbidden.test(engineImports), `${file} imports an engine entry point`).toBe(false);
    }
  });
});
