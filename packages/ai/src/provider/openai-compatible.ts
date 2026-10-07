import { ModelProviderError } from './errors';
import { joinUrl, parseJsonOutput, requestJson } from './http';
import type {
  GenerateJsonRequest,
  GenerateJsonResult,
  GenerateTextRequest,
  GenerateTextResult,
  ModelProvider,
  ProviderConfig,
  ProviderHealth,
} from './types';

/**
 * OpenAI-compatible adapter — the production path.
 *
 * This exists in Phase 1 for one reason: an abstraction with a single
 * implementation is an untested guess. Writing the second adapter is what proves
 * the port is actually provider-shaped and not accidentally Ollama-shaped.
 *
 * It is also the realistic production target. Serving Gemma on a DigitalOcean GPU
 * droplet means vLLM, TGI, or llama.cpp's server, and all three expose
 * /v1/chat/completions. The model stays open-weight and self-hosted; only the
 * wire protocol changes, and it changes behind this file.
 *
 * Note the one genuine behavioural difference from Ollama: structured output goes
 * through `response_format: json_schema`, which requires the schema to be
 * strict-mode compatible. `toJsonSchema` in structured.ts emits that form, so the
 * same schema serves both adapters.
 */

interface OpenAiChatResponse {
  model?: string;
  choices?: { message?: { role?: string; content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiModelsResponse {
  data?: { id?: string }[];
}

export function createOpenAiCompatibleProvider(config: ProviderConfig): ModelProvider {
  const provider = 'openai-compatible';

  const chat = async (
    request: GenerateTextRequest | GenerateJsonRequest,
    responseFormat?: Record<string, unknown>,
  ): Promise<{ response: OpenAiChatResponse; latencyMs: number }> => {
    const startedAt = performance.now();
    const response = await requestJson<OpenAiChatResponse>({
      provider,
      url: joinUrl(config.baseUrl, '/chat/completions'),
      method: 'POST',
      timeoutMs: request.timeoutMs ?? config.timeoutMs,
      maxRetries: config.maxRetries,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      body: {
        model: config.model,
        messages: request.messages,
        stream: false,
        temperature: request.temperature ?? config.temperature,
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(responseFormat ? { response_format: responseFormat } : {}),
      },
    });
    return { response, latencyMs: Math.round(performance.now() - startedAt) };
  };

  const contentOf = (response: OpenAiChatResponse): string => {
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ModelProviderError(
        'PROVIDER_MALFORMED_RESPONSE',
        'Response did not contain choices[0].message.content.',
        { provider, model: config.model, finishReason: response.choices?.[0]?.finish_reason },
      );
    }
    return content;
  };

  const usageOf = (response: OpenAiChatResponse) => ({
    ...(response.usage?.prompt_tokens === undefined
      ? {}
      : { promptTokens: response.usage.prompt_tokens }),
    ...(response.usage?.completion_tokens === undefined
      ? {}
      : { completionTokens: response.usage.completion_tokens }),
  });

  return {
    id: provider,
    model: config.model,
    baseUrl: config.baseUrl,

    async health(options = {}): Promise<ProviderHealth> {
      const startedAt = performance.now();
      const base = { provider, model: config.model, baseUrl: config.baseUrl };

      try {
        const models = await requestJson<OpenAiModelsResponse>({
          provider,
          url: joinUrl(config.baseUrl, '/models'),
          method: 'GET',
          timeoutMs: options.timeoutMs ?? 3_000,
          maxRetries: 0,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });

        const served = (models.data ?? []).map((entry) => entry.id ?? '').filter((id) => id !== '');
        // Single-model servers often report a filesystem path as the id, so a
        // suffix match is the pragmatic check.
        const modelAvailable =
          served.length === 0 ||
          served.some((id) => id === config.model || id.endsWith(config.model));

        return {
          ...base,
          ok: modelAvailable,
          reachable: true,
          modelAvailable,
          latencyMs: Math.round(performance.now() - startedAt),
          ...(modelAvailable
            ? {}
            : {
                detail: `Server is up but does not serve "${config.model}". It reports [${served.join(', ')}].`,
              }),
        };
      } catch (cause) {
        const message =
          cause instanceof ModelProviderError
            ? cause.message
            : `Could not reach an OpenAI-compatible server at ${config.baseUrl}.`;
        return {
          ...base,
          ok: false,
          reachable: false,
          modelAvailable: false,
          latencyMs: Math.round(performance.now() - startedAt),
          detail: `${message} Check MODEL_BASE_URL and that the inference host is running.`,
        };
      }
    },

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
      const { response, latencyMs } = await chat(request);
      return {
        text: contentOf(response),
        model: response.model ?? config.model,
        latencyMs,
        usage: usageOf(response),
      };
    },

    async generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult> {
      const { response, latencyMs } = await chat(request, {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName ?? 'structured_output',
          strict: true,
          schema: request.jsonSchema,
        },
      });
      const raw = contentOf(response);
      return {
        data: parseJsonOutput(raw, provider),
        raw,
        model: response.model ?? config.model,
        latencyMs,
        usage: usageOf(response),
      };
    },
  };
}
