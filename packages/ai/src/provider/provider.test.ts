import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServerEnv } from '@touchgrass/shared';
import { ModelProviderError } from './errors';
import { joinUrl, parseJsonOutput, requestJson } from './http';
import { createOllamaProvider } from './ollama';
import { createOpenAiCompatibleProvider } from './openai-compatible';
import {
  SUPPORTED_PROVIDER_IDS,
  createModelProvider,
  createModelProviderFromEnv,
} from './registry';
import type { ProviderConfig } from './types';

const CONFIG: ProviderConfig = {
  model: 'gemma3:4b',
  baseUrl: 'http://localhost:11434',
  timeoutMs: 5_000,
  maxRetries: 0,
  temperature: 0.8,
};

/** Replaces global fetch with a scripted sequence of responses. */
function mockFetch(...responses: (Response | Error)[]): ReturnType<typeof vi.fn> {
  let index = 0;
  const fn = vi.fn(() => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('joinUrl', () => {
  it('normalises slashes in both directions', () => {
    expect(joinUrl('http://host:1/', '/api/chat')).toBe('http://host:1/api/chat');
    expect(joinUrl('http://host:1', 'api/chat')).toBe('http://host:1/api/chat');
    expect(joinUrl('http://host:1//', '//api/chat')).toBe('http://host:1/api/chat');
  });
});

describe('parseJsonOutput', () => {
  it('parses a JSON object', () => {
    expect(parseJsonOutput('{"a":1}', 'test')).toEqual({ a: 1 });
  });

  it('rejects an empty completion with a specific code', () => {
    try {
      parseJsonOutput('   ', 'test');
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ModelProviderError);
      expect((cause as ModelProviderError).code).toBe('OUTPUT_NOT_JSON');
    }
  });

  it('keeps the offending text on the error so a bad generation is debuggable', () => {
    try {
      parseJsonOutput('Sure! Here is your JSON:', 'test');
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect((cause as ModelProviderError).context.raw).toContain('Sure!');
    }
  });
});

describe('requestJson', () => {
  it('surfaces an unreachable runtime with actionable wording', async () => {
    mockFetch(new TypeError('fetch failed'));
    await expect(
      requestJson({
        provider: 'ollama',
        url: 'http://localhost:11434/api/tags',
        method: 'GET',
        timeoutMs: 100,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
  });

  it('does not retry a 4xx, because the request itself was wrong', async () => {
    const fetchMock = mockFetch(json({ error: 'bad request' }, { status: 400 }));
    await expect(
      requestJson({
        provider: 'ollama',
        url: 'http://localhost:11434/api/chat',
        method: 'POST',
        timeoutMs: 100,
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_HTTP_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a 404 to a missing-model error', async () => {
    mockFetch(json({ error: 'model not found' }, { status: 404 }));
    await expect(
      requestJson({
        provider: 'ollama',
        url: 'http://localhost:11434/api/chat',
        method: 'POST',
        timeoutMs: 100,
        maxRetries: 2,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_AVAILABLE' });
  });

  it('retries a 5xx up to the budget and then gives up', async () => {
    const fetchMock = mockFetch(json({ error: 'overloaded' }, { status: 503 }));
    await expect(
      requestJson({
        provider: 'ollama',
        url: 'http://localhost:11434/api/chat',
        method: 'POST',
        timeoutMs: 100,
        maxRetries: 2,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_HTTP_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers when a retry succeeds', async () => {
    mockFetch(json({ error: 'overloaded' }, { status: 503 }), json({ models: [] }));
    await expect(
      requestJson({
        provider: 'ollama',
        url: 'http://localhost:11434/api/tags',
        method: 'GET',
        timeoutMs: 100,
        maxRetries: 1,
      }),
    ).resolves.toEqual({ models: [] });
  });

  it('sends a bearer token only when one is configured', async () => {
    const fetchMock = mockFetch(json({ ok: true }));
    await requestJson({
      provider: 'openai-compatible',
      url: 'http://host/v1/models',
      method: 'GET',
      timeoutMs: 100,
      maxRetries: 0,
      apiKey: 'secret-token',
    });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer secret-token');

    vi.unstubAllGlobals();
    const noKey = mockFetch(json({ ok: true }));
    await requestJson({
      provider: 'openai-compatible',
      url: 'http://host/v1/models',
      method: 'GET',
      timeoutMs: 100,
      maxRetries: 0,
    });
    const plainHeaders = (noKey.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      Record<string, string> | undefined;
    expect(plainHeaders?.authorization).toBeUndefined();
  });

  it('reports caller cancellation as CANCELLED rather than as a fault', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      requestJson({
        provider: 'ollama',
        url: 'http://localhost:11434/api/tags',
        method: 'GET',
        timeoutMs: 1_000,
        maxRetries: 2,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('createOllamaProvider', () => {
  it('reports healthy when the configured model is present', async () => {
    mockFetch(json({ models: [{ model: 'gemma3:4b' }, { model: 'llama3:8b' }] }));
    const health = await createOllamaProvider(CONFIG).health();
    expect(health).toMatchObject({
      ok: true,
      reachable: true,
      modelAvailable: true,
      provider: 'ollama',
      model: 'gemma3:4b',
    });
  });

  it('matches a model configured without its tag', async () => {
    mockFetch(json({ models: [{ model: 'gemma3:4b' }] }));
    const health = await createOllamaProvider({ ...CONFIG, model: 'gemma3' }).health();
    expect(health.modelAvailable).toBe(true);
  });

  it('tells the user to pull when the daemon is up but the model is missing', async () => {
    mockFetch(json({ models: [{ model: 'llama3:8b' }] }));
    const health = await createOllamaProvider(CONFIG).health();
    expect(health.ok).toBe(false);
    expect(health.reachable).toBe(true);
    expect(health.detail).toMatch(/npm run ai:pull/);
  });

  it('tells the user to start the daemon when it is unreachable', async () => {
    mockFetch(new TypeError('fetch failed'));
    const health = await createOllamaProvider(CONFIG).health();
    expect(health.ok).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.detail).toMatch(/npm run ai:up/);
  });

  it('never throws from health, because it renders in a page', async () => {
    mockFetch(new TypeError('fetch failed'));
    await expect(createOllamaProvider(CONFIG).health()).resolves.toMatchObject({ ok: false });
  });

  it('passes the JSON schema as the format field, constraining decoding', async () => {
    const fetchMock = mockFetch(json({ model: 'gemma3:4b', message: { content: '{"a":1}' } }));
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const result = await createOllamaProvider(CONFIG).generateJson({
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: schema,
    });

    expect(result.data).toEqual({ a: 1 });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.format).toEqual(schema);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('gemma3:4b');
  });

  it('reports a malformed response rather than returning undefined', async () => {
    mockFetch(json({ model: 'gemma3:4b' }));
    await expect(
      createOllamaProvider(CONFIG).generateJson({
        messages: [{ role: 'user', content: 'go' }],
        jsonSchema: {},
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MALFORMED_RESPONSE' });
  });

  it('reports non-JSON output distinctly from a transport fault', async () => {
    mockFetch(json({ model: 'gemma3:4b', message: { content: 'Sure, here you go!' } }));
    await expect(
      createOllamaProvider(CONFIG).generateJson({
        messages: [{ role: 'user', content: 'go' }],
        jsonSchema: {},
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_NOT_JSON' });
  });

  it('returns token usage when the runtime provides it', async () => {
    mockFetch(
      json({
        model: 'gemma3:4b',
        message: { content: 'hello' },
        prompt_eval_count: 42,
        eval_count: 7,
      }),
    );
    const result = await createOllamaProvider(CONFIG).generateText({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ promptTokens: 42, completionTokens: 7 });
  });
});

describe('createOpenAiCompatibleProvider', () => {
  const config: ProviderConfig = { ...CONFIG, baseUrl: 'http://gpu-host:8000/v1' };

  it('reports healthy when the server serves the configured model', async () => {
    mockFetch(json({ data: [{ id: 'gemma3:4b' }] }));
    const health = await createOpenAiCompatibleProvider(config).health();
    expect(health).toMatchObject({ ok: true, reachable: true, provider: 'openai-compatible' });
  });

  it('accepts a server that reports a path-style model id', async () => {
    mockFetch(json({ data: [{ id: '/models/gemma3:4b' }] }));
    const health = await createOpenAiCompatibleProvider(config).health();
    expect(health.modelAvailable).toBe(true);
  });

  it('assumes availability when a single-model server lists nothing', async () => {
    mockFetch(json({ data: [] }));
    const health = await createOpenAiCompatibleProvider(config).health();
    expect(health.modelAvailable).toBe(true);
  });

  it('reports the served models when the configured one is absent', async () => {
    mockFetch(json({ data: [{ id: 'mistral-7b' }] }));
    const health = await createOpenAiCompatibleProvider(config).health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/mistral-7b/);
  });

  it('requests structured output through response_format json_schema', async () => {
    const fetchMock = mockFetch(
      json({ model: 'gemma3:4b', choices: [{ message: { content: '{"a":1}' } }] }),
    );
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const result = await createOpenAiCompatibleProvider(config).generateJson({
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: schema,
      schemaName: 'game_master_turn',
    });

    expect(result.data).toEqual({ a: 1 });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      response_format?: { type?: string; json_schema?: Record<string, unknown> };
    };
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema).toMatchObject({
      name: 'game_master_turn',
      strict: true,
      schema,
    });
  });

  it('posts to /chat/completions relative to the configured base url', async () => {
    const fetchMock = mockFetch(
      json({ model: 'gemma3:4b', choices: [{ message: { content: 'hi' } }] }),
    );
    await createOpenAiCompatibleProvider(config).generateText({
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gpu-host:8000/v1/chat/completions');
  });

  it('reports a null content as malformed rather than silently returning empty', async () => {
    mockFetch(
      json({
        model: 'gemma3:4b',
        choices: [{ message: { content: null }, finish_reason: 'length' }],
      }),
    );
    await expect(
      createOpenAiCompatibleProvider(config).generateText({
        messages: [{ role: 'user', content: 'go' }],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MALFORMED_RESPONSE' });
  });
});

describe('registry', () => {
  it('exposes exactly the providers the env schema accepts', () => {
    expect([...SUPPORTED_PROVIDER_IDS].sort()).toEqual(['ollama', 'openai-compatible']);
  });

  it('builds each provider by id', () => {
    expect(createModelProvider('ollama', CONFIG).id).toBe('ollama');
    expect(createModelProvider('openai-compatible', CONFIG).id).toBe('openai-compatible');
  });

  it('builds a provider from a parsed environment', () => {
    const provider = createModelProviderFromEnv(
      parseServerEnv({
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_NAME: 'gemma3:12b',
        MODEL_BASE_URL: 'http://gpu-host:8000/v1',
      }),
    );
    expect(provider.id).toBe('openai-compatible');
    expect(provider.model).toBe('gemma3:12b');
    expect(provider.baseUrl).toBe('http://gpu-host:8000/v1');
  });

  it('defaults to local Ollama when nothing is configured', () => {
    const provider = createModelProviderFromEnv(parseServerEnv({}));
    expect(provider.id).toBe('ollama');
    expect(provider.baseUrl).toBe('http://localhost:11434');
  });
});
