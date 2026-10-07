import type { MastraModelConfig } from '@mastra/core/llm';
import type { ChatMessage, ModelProvider } from '../provider/types';

/**
 * Presents a TouchGrass `ModelProvider` to Mastra as a language model.
 *
 *   Game Master (Mastra agent) → this adapter → ModelProvider → Ollama → Gemma
 *
 * Mastra talks to models through the AI SDK's language-model interface. Rather
 * than add a second, Ollama-specific client library beside the provider
 * abstraction this project already has, the adapter implements that interface on
 * top of `ModelProvider`. So the runtime is still chosen in exactly one place
 * (MODEL_PROVIDER / MODEL_NAME / MODEL_BASE_URL), and moving from local Ollama to
 * a hosted open-weight endpoint changes configuration, not Game Master code.
 *
 * It supports what the Game Master needs and nothing else: text in, text out,
 * with an optional JSON schema that the runtime enforces while decoding. Tools
 * are not supported; if any are passed they are ignored and reported as a
 * warning, so this model can never be used to call one.
 */

/** The AI SDK v2 language-model shape, taken from the type Mastra accepts. */
type LanguageModel = Extract<
  MastraModelConfig,
  {
    specificationVersion: 'v2';
    doGenerate: (...args: never[]) => PromiseLike<{ content: unknown }>;
  }
>;
type CallOptions = Parameters<LanguageModel['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<LanguageModel['doGenerate']>>;
type StreamResult = Awaited<ReturnType<LanguageModel['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;

/** Flattens the AI SDK prompt into the plain chat messages a ModelProvider takes. */
export function toChatMessages(prompt: CallOptions['prompt']): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content });
      continue;
    }
    if (message.role === 'tool') continue;
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n');
    if (text !== '') messages.push({ role: message.role, content: text });
  }
  return messages;
}

export function createProviderLanguageModel(provider: ModelProvider): LanguageModel {
  const doGenerate = async (options: CallOptions): Promise<GenerateResult> => {
    const messages = toChatMessages(options.prompt);
    const common = {
      messages,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    };

    // With a JSON schema, the runtime constrains decoding to it. A failure here
    // is a ModelProviderError and is left to propagate: the caller decides what
    // an unreachable model means, and nothing falls back to another model.
    const format = options.responseFormat;
    const generation =
      format?.type === 'json' && format.schema
        ? await provider.generateJson({
            ...common,
            jsonSchema: format.schema as Record<string, unknown>,
            ...(format.name ? { schemaName: format.name } : {}),
          })
        : await provider.generateText(common);

    const text = 'raw' in generation ? generation.raw : generation.text;
    const inputTokens = generation.usage?.promptTokens;
    const outputTokens = generation.usage?.completionTokens;

    return {
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens === undefined || outputTokens === undefined
            ? undefined
            : inputTokens + outputTokens,
      },
      warnings:
        options.tools && options.tools.length > 0
          ? [{ type: 'other', message: 'Tools are not supported by this model and were ignored.' }]
          : [],
    };
  };

  return {
    specificationVersion: 'v2',
    provider: provider.id,
    modelId: provider.model,
    supportedUrls: {},
    doGenerate,

    // The runtime call is not streamed; the finished result is replayed as a
    // stream because Mastra drives every model through its streaming interface.
    async doStream(options: CallOptions): Promise<StreamResult> {
      const result = await doGenerate(options);
      const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      const parts: StreamPart[] = [
        { type: 'stream-start', warnings: result.warnings },
        { type: 'text-start', id: 'text-0' },
        { type: 'text-delta', id: 'text-0', delta: text.join('') },
        { type: 'text-end', id: 'text-0' },
        { type: 'finish', finishReason: result.finishReason, usage: result.usage },
      ];
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
