import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { gameEventSchema } from '@touchgrass/game-engine';
import { describeIssues, generateStructured, toJsonSchema } from './structured';
import { ModelProviderError } from './provider/errors';
import type {
  GenerateJsonRequest,
  GenerateJsonResult,
  GenerateTextResult,
  ModelProvider,
} from './provider/types';

/**
 * A scripted provider. Returns queued completions in order, so a test can
 * describe a model that is wrong first and right second — which is the behaviour
 * the repair loop exists for. This is a test double, not a shipped adapter: the
 * repo contains no fake model.
 */
function scriptedProvider(completions: unknown[]): ModelProvider & {
  calls: GenerateJsonRequest[];
} {
  const calls: GenerateJsonRequest[] = [];
  let index = 0;

  return {
    id: 'scripted',
    model: 'scripted-model',
    baseUrl: 'memory://scripted',
    calls,
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
    generateText: (): Promise<GenerateTextResult> =>
      Promise.resolve({ text: '', model: 'scripted-model', latencyMs: 1 }),
    generateJson: (request: GenerateJsonRequest): Promise<GenerateJsonResult> => {
      calls.push(request);
      const completion = completions[Math.min(index, completions.length - 1)];
      index += 1;
      if (completion instanceof Error) return Promise.reject(completion);
      return Promise.resolve({
        data: completion,
        raw: JSON.stringify(completion),
        model: 'scripted-model',
        latencyMs: 5,
      });
    },
  };
}

const MESSAGES = [
  { role: 'system' as const, content: 'You are a Game Master.' },
  { role: 'user' as const, content: 'The chase has gone static.' },
];

const VALID_EVENT = {
  type: 'RULE_MODIFIER',
  modifier: 'FREEZE_PERIOD',
  roleIds: ['tagger'],
  durationSeconds: 60,
};

/**
 * Several events generated in one call. Local to this test: how the Game Master
 * batches its output is a Phase 3 decision, and the engine exports only the
 * single-event schema.
 */
const eventBatchSchema = z.object({ events: z.array(gameEventSchema).min(1).max(3) }).strict();

describe('toJsonSchema', () => {
  it('produces a JSON Schema object for the game event union', () => {
    const schema = toJsonSchema(gameEventSchema, 'game_event');
    expect(schema).toBeTypeOf('object');
    expect(JSON.stringify(schema)).toContain('RULE_MODIFIER');
    expect(JSON.stringify(schema)).toContain('ZONE_CHANGE');
  });

  it('describes the input shape, so fields with defaults are not demanded of the model', () => {
    const schema = toJsonSchema(
      z.object({ required: z.string(), optional: z.string().default('x') }),
    );
    expect(schema.required).toEqual(['required']);
  });

  it('survives schemas carrying refinements that no grammar can express', () => {
    // The batch nests the event union, whose ROLE_CHANGE branch has a `.refine`.
    // Conversion must degrade gracefully rather than throw.
    expect(() => toJsonSchema(eventBatchSchema, 'game_event_batch')).not.toThrow();
  });

  it('titles the root so the OpenAI-compatible adapter has a stable schema name', () => {
    const schema = toJsonSchema(z.object({ a: z.string() }), 'my_schema');
    expect(schema.title).toBe('my_schema');
  });
});

describe('describeIssues', () => {
  it('names the field and the constraint, which is what a small model can act on', () => {
    const result = gameEventSchema.safeParse({ ...VALID_EVENT, durationSeconds: 9_999 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const lines = describeIssues(result.error);
    expect(lines.join('\n')).toMatch(/durationSeconds/);
    expect(lines.every((line) => line.includes(':'))).toBe(true);
  });
});

describe('generateStructured', () => {
  it('returns validated data on a first-attempt success', async () => {
    const provider = scriptedProvider([VALID_EVENT]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      schemaName: 'game_event',
      messages: MESSAGES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.type).toBe('RULE_MODIFIER');
    expect(result.value.attempts).toBe(1);
    expect(result.value.model).toBe('scripted-model');
    expect(provider.calls).toHaveLength(1);
  });

  it('passes the JSON schema to the provider so decoding is constrained', async () => {
    const provider = scriptedProvider([VALID_EVENT]);
    await generateStructured({
      provider,
      schema: gameEventSchema,
      schemaName: 'game_event',
      messages: MESSAGES,
    });
    expect(provider.calls[0]?.jsonSchema).toBeTypeOf('object');
    expect(provider.calls[0]?.schemaName).toBe('game_event');
  });

  it('repairs a validation failure and succeeds on the retry', async () => {
    const provider = scriptedProvider([{ ...VALID_EVENT, durationSeconds: 9_999 }, VALID_EVENT]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    expect(result.value.latencyMs).toBe(10);
  });

  it('tells the model which field was wrong when it asks for a repair', async () => {
    const provider = scriptedProvider([{ ...VALID_EVENT, durationSeconds: 9_999 }, VALID_EVENT]);
    await generateStructured({ provider, schema: gameEventSchema, messages: MESSAGES });

    const repairTurn = provider.calls[1]?.messages.at(-1);
    expect(repairTurn?.role).toBe('user');
    expect(repairTurn?.content).toMatch(/durationSeconds/);
    expect(repairTurn?.content).toMatch(/JSON only/);
  });

  it('includes the rejected completion in the repair prompt', async () => {
    const provider = scriptedProvider([{ type: 'NONSENSE' }, VALID_EVENT]);
    await generateStructured({ provider, schema: gameEventSchema, messages: MESSAGES });

    const history = provider.calls[1]?.messages ?? [];
    expect(history.some((m) => m.role === 'assistant' && m.content.includes('NONSENSE'))).toBe(
      true,
    );
  });

  it('gives up after the repair budget and reports why', async () => {
    const provider = scriptedProvider([{ type: 'RULE_MODIFIER' }]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
      maxRepairAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OUTPUT_SCHEMA_INVALID');
    expect(result.error.attempts).toBe(3);
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.raw).toContain('RULE_MODIFIER');
    expect(provider.calls).toHaveLength(3);
  });

  it('treats a non-JSON completion as a failed attempt and repairs it', async () => {
    const notJson = new ModelProviderError('OUTPUT_NOT_JSON', 'not json', {
      raw: 'Sure! Here is your twist:',
    });
    const provider = scriptedProvider([notJson, VALID_EVENT]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    const repairTurn = provider.calls[1]?.messages.at(-1);
    expect(repairTurn?.content).toMatch(/not valid JSON/);
    expect(repairTurn?.content).toContain('Sure! Here is your twist:');
  });

  it('reports OUTPUT_NOT_JSON when every attempt is non-JSON', async () => {
    const notJson = new ModelProviderError('OUTPUT_NOT_JSON', 'not json', { raw: 'nope' });
    const provider = scriptedProvider([notJson]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OUTPUT_NOT_JSON');
    expect(result.error.attempts).toBe(2);
    expect(result.error.raw).toBe('nope');
    expect(provider.calls).toHaveLength(2);
  });

  it('rethrows transport faults instead of spending repair attempts on them', async () => {
    const down = new ModelProviderError('PROVIDER_UNREACHABLE', 'runtime is down');
    const provider = scriptedProvider([down]);
    await expect(
      generateStructured({ provider, schema: gameEventSchema, messages: MESSAGES }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect(provider.calls).toHaveLength(1);
  });

  it('makes exactly one attempt when repair is disabled', async () => {
    const provider = scriptedProvider([{ type: 'RULE_MODIFIER' }]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
      maxRepairAttempts: 0,
    });

    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it('rejects a completion that smuggles an extra field past the grammar', async () => {
    // Structured decoding constrains shape but a runtime may still emit extras;
    // the Zod pass is what actually closes the hole.
    const provider = scriptedProvider([
      { ...VALID_EVENT, executeShellCommand: 'rm -rf /' },
      { ...VALID_EVENT, executeShellCommand: 'rm -rf /' },
    ]);
    const result = await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OUTPUT_SCHEMA_INVALID');
  });

  it('never mutates the caller message array', async () => {
    const provider = scriptedProvider([{ type: 'RULE_MODIFIER' }, VALID_EVENT]);
    const messages = [...MESSAGES];
    await generateStructured({ provider, schema: gameEventSchema, messages });
    expect(messages).toEqual(MESSAGES);
  });

  it('logs a validation failure through the supplied logger', async () => {
    const warn = vi.fn();
    const provider = scriptedProvider([{ type: 'RULE_MODIFIER' }, VALID_EVENT]);
    await generateStructured({
      provider,
      schema: gameEventSchema,
      messages: MESSAGES,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() },
    });
    expect(warn).toHaveBeenCalledWith(
      'structured generation failed validation',
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it('validates several events generated in one call', async () => {
    const batch = {
      events: [VALID_EVENT, { type: 'TIME_EXTENSION', seconds: 60 }],
    };
    const result = await generateStructured({
      provider: scriptedProvider([batch]),
      schema: eventBatchSchema,
      messages: MESSAGES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.events).toHaveLength(2);
  });

  it('rejects a batch larger than its schema allows', async () => {
    const tooMany = {
      events: Array.from({ length: 4 }, () => VALID_EVENT),
    };
    const result = await generateStructured({
      provider: scriptedProvider([tooMany]),
      schema: eventBatchSchema,
      messages: MESSAGES,
      maxRepairAttempts: 0,
    });
    expect(result.ok).toBe(false);
  });
});
