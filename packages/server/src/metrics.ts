/**
 * Counters and timers for one process.
 *
 * The names are fixed, and there are no labels. A metric says how many times
 * something happened, or how long it took: never which session, which player,
 * or what a model said. That keeps the set of series small and bounded, and
 * leaves nothing in it worth protecting.
 *
 * It is a plain object in memory. Nothing exports it, scrapes it or sends it
 * anywhere; whoever holds it can read it.
 */

export const COUNTER_NAMES = [
  'game_master_invocations',
  'game_master_successes',
  'game_master_failures',
  'game_master_timeouts',
  'game_master_safety_rejections',
  'game_master_engine_rejections',
  'game_master_schema_rejections',
  'game_master_skipped',
  'tool_invocations',
  'tool_failures',
  'session_creates',
  'session_loads',
  'session_evictions',
  'session_eviction_failures',
  'session_unloads',
  'persistence_failures',
  'websocket_connections_opened',
  'websocket_connections_refused',
  'websocket_connections_closed',
  'unexpected_errors',
] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

export const TIMER_NAMES = ['game_master_turn_ms', 'tool_call_ms'] as const;
export type TimerName = (typeof TIMER_NAMES)[number];

export interface TimerSnapshot {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<CounterName, number>>;
  readonly timers: Readonly<Record<TimerName, TimerSnapshot>>;
}

export interface Metrics {
  readonly increment: (name: CounterName, by?: number) => void;
  readonly observe: (name: TimerName, milliseconds: number) => void;
  /** A copy of every value as it stands. */
  readonly read: () => MetricsSnapshot;
}

export function createMetrics(): Metrics {
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0])) as Record<
    CounterName,
    number
  >;
  const timers = Object.fromEntries(
    TIMER_NAMES.map((name) => [name, { count: 0, totalMs: 0, maxMs: 0 }]),
  ) as Record<TimerName, { count: number; totalMs: number; maxMs: number }>;

  return {
    increment(name, by = 1) {
      // A name that is not one of the fixed ones is ignored, not added.
      if (Object.hasOwn(counters, name) && Number.isFinite(by)) counters[name] += by;
    },
    observe(name, milliseconds) {
      if (!Object.hasOwn(timers, name) || !Number.isFinite(milliseconds)) return;
      const timer = timers[name];
      const value = Math.max(0, milliseconds);
      timer.count += 1;
      timer.totalMs += value;
      timer.maxMs = Math.max(timer.maxMs, value);
    },
    read: () => ({
      counters: { ...counters },
      timers: Object.fromEntries(TIMER_NAMES.map((name) => [name, { ...timers[name] }])) as Record<
        TimerName,
        TimerSnapshot
      >,
    }),
  };
}
