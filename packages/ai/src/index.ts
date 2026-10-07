export type {
  ChatMessage,
  GenerateOptions,
  GenerateTextRequest,
  GenerateTextResult,
  GenerateJsonRequest,
  GenerateJsonResult,
  GenerationUsage,
  ModelProvider,
  ProviderConfig,
  ProviderHealth,
} from './provider/types';

export {
  MODEL_ERROR_CODES,
  ModelProviderError,
  isModelProviderError,
  type ModelErrorCode,
} from './provider/errors';

export { joinUrl, parseJsonOutput, requestJson } from './provider/http';

export { createOllamaProvider } from './provider/ollama';
export { createOpenAiCompatibleProvider } from './provider/openai-compatible';
export {
  SUPPORTED_PROVIDER_IDS,
  createModelProvider,
  createModelProviderFromEnv,
} from './provider/registry';

export {
  type GenerateStructuredRequest,
  type StructuredFailure,
  type StructuredResult,
  generateStructured,
  toJsonSchema,
  describeIssues,
} from './structured';
