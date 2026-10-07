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
 * Ollama adapter — the local development default.
 *
 * Ollama is the right runtime for development because it makes an open-weight
 * model a one-command dependency: `ollama pull gemma3:4b` and the Game Master
 * works offline, with no API key, no per-token cost, and no data leaving the
 * machine. That last point is not incidental for a product aimed at children
 * playing outside.
 *
 * It talks to /api/chat with `format` set to a JSON Schema, which constrains
 * decoding rather than merely asking the model to behave.
 */

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
}

interface OllamaTagsResponse {
  models?: { name?: string; model?: string }[];
}

export function createOllamaProvider(config: ProviderConfig): ModelProvider {
  const provider = 'ollama';

  const chat = async (
    request: GenerateTextRequest | GenerateJsonRequest,
    format?: Record<string, unknown>,
  ): Promise<{ response: OllamaChatResponse; latencyMs: number }> => {
    const startedAt = performance.now();
    const response = await requestJson<OllamaChatResponse>({
      provider,
      url: joinUrl(config.baseUrl, '/api/chat'),
      method: 'POST',
      timeoutMs: request.timeoutMs ?? config.timeoutMs,
      maxRetries: config.maxRetries,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      body: {
        model: config.model,
        messages: request.messages,
        stream: false,
        ...(format ? { format } : {}),
        options: {
          temperature: request.temperature ?? config.temperature,
          ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
        },
      },
    });
    return { response, latencyMs: Math.round(performance.now() - startedAt) };
  };

  const contentOf = (response: OllamaChatResponse): string => {
    const content = response.message?.content;
    if (typeof content !== 'string') {
      throw new ModelProviderError(
        'PROVIDER_MALFORMED_RESPONSE',
        'Ollama response did not contain message.content.',
        { provider, model: config.model },
      );
    }
    return content;
  };

  return {
    id: provider,
    model: config.model,
    baseUrl: config.baseUrl,

    async health(options = {}): Promise<ProviderHealth> {
      const startedAt = performance.now();
      const base = {
        provider,
        model: config.model,
        baseUrl: config.baseUrl,
      };

      try {
        const tags = await requestJson<OllamaTagsResponse>({
          provider,
          url: joinUrl(config.baseUrl, '/api/tags'),
          method: 'GET',
          // Health is a liveness probe in a page render path, so it gets a short
          // deadline of its own rather than the generation timeout.
          timeoutMs: options.timeoutMs ?? 3_000,
          maxRetries: 0,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });

        const available = (tags.models ?? [])
          .map((entry) => entry.model ?? entry.name ?? '')
          .filter((name) => name !== '');

        // Ollama reports "gemma3:4b"; a config of "gemma3" should still match.
        const modelAvailable = available.some(
          (name) => name === config.model || name.split(':')[0] === config.model.split(':')[0],
        );

        return {
          ...base,
          ok: modelAvailable,
          reachable: true,
          modelAvailable,
          latencyMs: Math.round(performance.now() - startedAt),
          ...(modelAvailable
            ? {}
            : {
                detail:
                  available.length === 0
                    ? `Ollama is running but has no models. Run: npm run ai:pull`
                    : `Ollama is running but "${config.model}" is not among [${available.join(', ')}]. Run: npm run ai:pull`,
              }),
        };
      } catch (cause) {
        const message =
          cause instanceof ModelProviderError
            ? cause.message
            : `Could not reach Ollama at ${config.baseUrl}.`;
        return {
          ...base,
          ok: false,
          reachable: false,
          modelAvailable: false,
          latencyMs: Math.round(performance.now() - startedAt),
          detail: `${message} Start it with: npm run ai:up`,
        };
      }
    },

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
      const { response, latencyMs } = await chat(request);
      return {
        text: contentOf(response),
        model: response.model ?? config.model,
        latencyMs,
        usage: {
          ...(response.prompt_eval_count === undefined
            ? {}
            : { promptTokens: response.prompt_eval_count }),
          ...(response.eval_count === undefined ? {} : { completionTokens: response.eval_count }),
        },
      };
    },

    async generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult> {
      const { response, latencyMs } = await chat(request, request.jsonSchema);
      const raw = contentOf(response);
      return {
        data: parseJsonOutput(raw, provider),
        raw,
        model: response.model ?? config.model,
        latencyMs,
        usage: {
          ...(response.prompt_eval_count === undefined
            ? {}
            : { promptTokens: response.prompt_eval_count }),
          ...(response.eval_count === undefined ? {} : { completionTokens: response.eval_count }),
        },
      };
    },
  };
}
