import { describe, expect, it } from 'vitest';
import { ModelProviderError } from '../provider/errors';
import { createProviderLanguageModel, toChatMessages } from './model-adapter';
import { scriptedProvider } from './test-support';

const prompt = [
  { role: 'system' as const, content: 'You are a referee.' },
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'What now?' }] },
];

describe('createProviderLanguageModel', () => {
  it('identifies itself by the provider and model it wraps', () => {
    const model = createProviderLanguageModel(scriptedProvider(['hi']));
    expect(model.specificationVersion).toBe('v2');
    expect(model.provider).toBe('scripted');
    expect(model.modelId).toBe('scripted-model');
  });

  it('sends a JSON request, with the schema, when a JSON schema is asked for', async () => {
    const provider = scriptedProvider([{ a: 1 }]);
    const schema = { type: 'object' as const, properties: { a: { type: 'number' as const } } };
    const result = await createProviderLanguageModel(provider).doGenerate({
      prompt,
      responseFormat: { type: 'json', schema, name: 'thing' },
      temperature: 0.2,
      maxOutputTokens: 50,
    });

    expect(result.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(provider.requests[0]).toMatchObject({
      jsonSchema: schema,
      schemaName: 'thing',
      temperature: 0.2,
      maxTokens: 50,
      messages: [
        { role: 'system', content: 'You are a referee.' },
        { role: 'user', content: 'What now?' },
      ],
    });
  });

  it('sends a plain text request otherwise', async () => {
    const provider = scriptedProvider(['Go!']);
    const result = await createProviderLanguageModel(provider).doGenerate({ prompt });
    expect(result.content).toEqual([{ type: 'text', text: 'Go!' }]);
    expect(provider.requests[0]).not.toHaveProperty('jsonSchema');
  });

  it('lets a provider failure through unchanged', async () => {
    const down = new ModelProviderError('PROVIDER_UNREACHABLE', 'ollama is unreachable');
    const model = createProviderLanguageModel(scriptedProvider([down]));
    await expect(model.doGenerate({ prompt })).rejects.toBe(down);
    await expect(model.doStream({ prompt })).rejects.toBe(down);
  });

  it('ignores tools and says so, so it can never be used to call one', async () => {
    const provider = scriptedProvider(['Go!']);
    const result = await createProviderLanguageModel(provider).doGenerate({
      prompt,
      tools: [
        {
          type: 'function',
          name: 'applyEvent',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.content.every((part) => part.type === 'text')).toBe(true);
    expect(JSON.stringify(provider.requests[0])).not.toContain('applyEvent');
  });

  it('replays the finished reply as a stream', async () => {
    const { stream } = await createProviderLanguageModel(scriptedProvider(['Go!'])).doStream({
      prompt,
    });
    const types: string[] = [];
    let text = '';
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      types.push(value.type);
      if (value.type === 'text-delta') text += value.delta;
    }
    expect(types).toEqual(['stream-start', 'text-start', 'text-delta', 'text-end', 'finish']);
    expect(text).toBe('Go!');
  });
});

describe('toChatMessages', () => {
  it('joins text parts and drops tool messages', () => {
    expect(
      toChatMessages([
        ...prompt,
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'One.' },
            { type: 'text', text: 'Two.' },
          ],
        },
        { role: 'tool', content: [] },
      ]),
    ).toEqual([
      { role: 'system', content: 'You are a referee.' },
      { role: 'user', content: 'What now?' },
      { role: 'assistant', content: 'One.\nTwo.' },
    ]);
  });
});
