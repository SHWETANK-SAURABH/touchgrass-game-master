import { ModelProviderError } from './errors';

/**
 * Shared transport for every adapter.
 *
 * Both runtimes speak plain JSON over HTTP, so the retry, timeout, and error
 * classification logic belongs here once rather than in each adapter. Keeping it
 * central also means a new adapter inherits the same deadline behaviour, which is
 * what makes the provider abstraction safe to swap under a live session.
 */

export interface JsonRequestInit {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly signal?: AbortSignal;
  /** Names the provider in error messages. */
  readonly provider: string;
}

/** Joins a base URL and path without doubling or dropping a slash. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

/**
 * Issues a JSON request with a deadline and bounded retries.
 *
 * The retry policy is decided by *cause*, not by a generic error flag:
 *
 *  - transport faults (refused connection, timeout) may clear on another attempt
 *  - 5xx means the runtime is struggling, which may also clear
 *  - 4xx means the request itself was wrong, so repeating it only spends the
 *    player's deadline on a guaranteed second failure
 *  - caller cancellation is never retried and never reported as a fault
 */
export async function requestJson<T>(init: JsonRequestInit): Promise<T> {
  let lastError: ModelProviderError | undefined;

  for (let attempt = 0; attempt <= init.maxRetries; attempt += 1) {
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(init.url, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(init.apiKey ? { authorization: `Bearer ${init.apiKey}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });
    } catch (cause) {
      // The caller cancelled: never retry, and never dress it up as a fault.
      if (init.signal?.aborted) {
        throw new ModelProviderError('CANCELLED', `${init.provider} request was cancelled.`, {
          url: init.url,
        });
      }

      const transportError = isAbortError(cause)
        ? new ModelProviderError(
            'PROVIDER_TIMEOUT',
            `${init.provider} did not respond within ${String(init.timeoutMs)}ms.`,
            { url: init.url, timeoutMs: init.timeoutMs, attempt },
            { cause },
          )
        : new ModelProviderError(
            'PROVIDER_UNREACHABLE',
            `${init.provider} is unreachable at ${init.url}. Is the model runtime running?`,
            { url: init.url, attempt },
            { cause },
          );

      if (attempt === init.maxRetries) throw transportError;
      lastError = transportError;
      continue;
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      const httpError = new ModelProviderError(
        response.status === 404 ? 'MODEL_NOT_AVAILABLE' : 'PROVIDER_HTTP_ERROR',
        `${init.provider} returned ${String(response.status)} ${response.statusText}${detail ? `: ${detail}` : ''}`,
        { url: init.url, status: response.status, attempt },
      );

      // Anything below 500 is a verdict on the request, including the 404 that
      // both runtimes use for "no such model". Fail now rather than three times.
      if (response.status < 500 || attempt === init.maxRetries) throw httpError;
      lastError = httpError;
      continue;
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new ModelProviderError(
        'PROVIDER_MALFORMED_RESPONSE',
        `${init.provider} returned a body that is not valid JSON.`,
        { url: init.url },
        { cause },
      );
    }
  }

  throw (
    lastError ??
    new ModelProviderError('PROVIDER_UNREACHABLE', `${init.provider} request failed.`, {
      url: init.url,
    })
  );
}

/** Parses generated text as JSON, with the raw string preserved on failure. */
export function parseJsonOutput(raw: string, provider: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ModelProviderError('OUTPUT_NOT_JSON', `${provider} returned an empty completion.`, {
      provider,
    });
  }
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    throw new ModelProviderError(
      'OUTPUT_NOT_JSON',
      `${provider} returned text that is not valid JSON.`,
      { provider, raw: trimmed.slice(0, 500) },
      { cause },
    );
  }
}
