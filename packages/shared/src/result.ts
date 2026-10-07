/**
 * A tagged result type.
 *
 * The AI pipeline has several steps that are *expected* to fail during normal
 * operation — a model that returns malformed JSON, a proposal that violates a
 * safety rule, a command the engine refuses. Those are outcomes, not exceptions.
 * Modelling them as values forces every caller to handle the failure branch, and
 * keeps `throw` reserved for genuine bugs and infrastructure faults.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(
  result: Result<T, E>,
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** Maps the success value, leaving a failure untouched. */
export function mapResult<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Chains another fallible step onto a success. */
export function andThen<T, E, U>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Escape hatch for call sites that have already proved the result is ok. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap() called on a failed Result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
