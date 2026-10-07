import type { ModelProviderId, ServerEnv } from '@touchgrass/shared';
import { createOllamaProvider } from './ollama';
import { createOpenAiCompatibleProvider } from './openai-compatible';
import type { ModelProvider, ProviderConfig } from './types';

/**
 * The one place a concrete adapter is chosen.
 *
 * A `Record` keyed by the provider id, rather than a switch, so adding a runtime
 * is one entry here plus one file — and so TypeScript fails the build if the env
 * schema gains a provider that has no factory.
 */
const FACTORIES: Record<ModelProviderId, (config: ProviderConfig) => ModelProvider> = {
  ollama: createOllamaProvider,
  'openai-compatible': createOpenAiCompatibleProvider,
};

export function createModelProvider(
  providerId: ModelProviderId,
  config: ProviderConfig,
): ModelProvider {
  return FACTORIES[providerId](config);
}

/** Builds the provider described by a parsed environment. */
export function createModelProviderFromEnv(env: ServerEnv): ModelProvider {
  return createModelProvider(env.MODEL_PROVIDER, {
    model: env.MODEL_NAME,
    baseUrl: env.MODEL_BASE_URL,
    ...(env.MODEL_API_KEY ? { apiKey: env.MODEL_API_KEY } : {}),
    timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS,
    maxRetries: env.MODEL_MAX_RETRIES,
    temperature: env.MODEL_TEMPERATURE,
  });
}

export const SUPPORTED_PROVIDER_IDS = Object.keys(FACTORIES) as ModelProviderId[];
