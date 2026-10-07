import { TouchGrassError } from '@touchgrass/shared';

/**
 * Why a generation failed.
 *
 * The codes exist so the Game Master can pick a fallback per cause rather than
 * treating every failure the same way. An unreachable daemon means fall back to a
 * scripted event and tell the host; a schema violation means try the repair loop
 * once. Collapsing both into "AI error" would make the difference invisible.
 */
export const MODEL_ERROR_CODES = [
  /** The runtime could not be contacted at all. */
  'PROVIDER_UNREACHABLE',
  /** The request exceeded its deadline. */
  'PROVIDER_TIMEOUT',
  /** The runtime answered, but not with a success status. */
  'PROVIDER_HTTP_ERROR',
  /** The configured model is not present on the runtime. */
  'MODEL_NOT_AVAILABLE',
  /** The response body was not the shape the adapter expected. */
  'PROVIDER_MALFORMED_RESPONSE',
  /** The generated text was not parseable JSON. */
  'OUTPUT_NOT_JSON',
  /** The generated JSON parsed but failed schema validation after every retry. */
  'OUTPUT_SCHEMA_INVALID',
  /** The caller cancelled. */
  'CANCELLED',
] as const;

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export class ModelProviderError extends TouchGrassError {
  override readonly code: ModelErrorCode;

  constructor(
    code: ModelErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, context, options);
    this.code = code;
  }

  /**
   * True when the same request might succeed if sent again.
   *
   * Transport faults qualify; a schema violation does not, because the next
   * identical request produces the same violation. `PROVIDER_HTTP_ERROR` is
   * deliberately excluded: it covers both a retryable 5xx and a pointless-to-retry
   * 4xx, so the transport layer decides that one from the status code instead of
   * from this flag. Callers use this to choose a fallback, not to drive a loop.
   */
  get retryable(): boolean {
    return this.code === 'PROVIDER_TIMEOUT' || this.code === 'PROVIDER_UNREACHABLE';
  }
}

export function isModelProviderError(value: unknown): value is ModelProviderError {
  return value instanceof ModelProviderError;
}
