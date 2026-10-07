/**
 * Injected sources of non-determinism.
 *
 * The game engine must be a pure function of (state, command) so that the same
 * session log always replays to the same state — that is what makes the engine,
 * and not the model, the authority on what happened. Reading `Date.now()` or
 * `Math.random()` inside engine code would silently break that property, so both
 * are passed in as explicit capabilities instead.
 */

/** Wall-clock source. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock frozen at one instant — used by tests and by log replay. */
export function fixedClock(epochMs: number): Clock {
  return { now: () => epochMs };
}

/** A seeded pseudo-random source. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
}

/**
 * mulberry32 — small, fast, and good enough for shuffling players into roles.
 * Not cryptographic; nothing security-relevant may depend on it.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextInt: (maxExclusive: number) => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error(`nextInt requires a positive integer bound, received ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
  };
}

/** Derives a numeric seed from a session id so a session's randomness is reproducible. */
export function seedFromString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Fisher-Yates, driven entirely by the supplied Rng. Does not mutate `items`. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
