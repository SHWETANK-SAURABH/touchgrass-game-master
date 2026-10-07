/**
 * The model provider port.
 *
 * Everything the application knows about inference is in this file. There is no
 * `import { Ollama }` anywhere outside `ollama.ts`, which is what makes the
 * "replaceable model" claim structural rather than aspirational: swapping to a
 * vLLM endpoint on a GPU host is a change to one environment variable, because
 * the application only ever holds a `ModelProvider`.
 *
 * The interface is deliberately small. It does not expose streaming, embeddings,
 * function calling, or a chat session abstraction, because the Game Master does
 * not need them: it needs one JSON object per turn, within a deadline. A port that
 * only promises what is actually required is a port that any open-weight runtime
 * can satisfy.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface GenerateOptions {
  /** 0 is deterministic-ish; the Game Master wants variety, so the default is higher. */
  readonly temperature?: number;
  /** Upper bound on generated tokens. Keeps a runaway generation from eating the deadline. */
  readonly maxTokens?: number;
  /** Overrides the provider-wide request timeout for one call. */
  readonly timeoutMs?: number;
  /** Lets a caller cancel, e.g. when the session ends mid-turn. */
  readonly signal?: AbortSignal;
}

export interface GenerateTextRequest extends GenerateOptions {
  readonly messages: readonly ChatMessage[];
}

export interface GenerateJsonRequest extends GenerateOptions {
  readonly messages: readonly ChatMessage[];
  /**
   * A JSON Schema the runtime must constrain generation to.
   *
   * Both supported runtimes enforce this during decoding rather than checking
   * afterwards, which is the single biggest reason a 4B open-weight model is
   * viable here: the grammar does the structural work, leaving Zod to catch the
   * semantic mistakes that remain.
   */
  readonly jsonSchema: Record<string, unknown>;
  /** Schema name, where the runtime requires one. */
  readonly schemaName?: string;
}

export interface GenerationUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface GenerateTextResult {
  readonly text: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage?: GenerationUsage;
}

export interface GenerateJsonResult {
  /** Parsed JSON, still unvalidated. Typed `unknown` on purpose — see structured.ts. */
  readonly data: unknown;
  /** The raw string, kept for logging a malformed generation verbatim. */
  readonly raw: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly usage?: GenerationUsage;
}

export interface ProviderHealth {
  readonly ok: boolean;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  /** Reachability of the runtime itself. */
  readonly reachable: boolean;
  /** Whether the configured model is actually loaded or pullable there. */
  readonly modelAvailable: boolean;
  readonly latencyMs: number;
  /** Human-readable next step when something is wrong. */
  readonly detail?: string;
}

export interface ModelProvider {
  /** Matches MODEL_PROVIDER, so logs and health output name the adapter in use. */
  readonly id: string;
  readonly model: string;
  readonly baseUrl: string;

  /** Cheap liveness probe. Must not generate tokens. */
  health(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProviderHealth>;

  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;

  /** Schema-constrained generation. Throws ModelProviderError on failure. */
  generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult>;
}

export interface ProviderConfig {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly temperature: number;
}
