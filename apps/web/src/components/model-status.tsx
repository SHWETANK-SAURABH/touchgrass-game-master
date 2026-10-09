'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Live model-runtime status.
 *
 * A client component that polls /api/health, rather than a server render, for a
 * practical reason: the status is a property of a daemon that starts and stops
 * independently of the app, so it has to be re-checkable without a page reload.
 * It is also the first thing a contributor needs after cloning — "is my Gemma
 * actually there?" — so it belongs on the landing page, not behind a CLI command.
 */

interface ModelHealth {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  reachable: boolean;
  modelAvailable: boolean;
  latencyMs: number;
  detail?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'misconfigured';
  model?: ModelHealth;
  error?: string;
}

type State =
  | { phase: 'loading' }
  | { phase: 'loaded'; data: HealthResponse }
  | { phase: 'error'; message: string };

export function ModelStatus() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  // Deliberately free of a synchronous setState: every state write happens after
  // the await, so mounting does not trigger a cascading render. The initial state
  // is already `loading`, so there is nothing to set on the way in.
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      setState({ phase: 'loaded', data: (await response.json()) as HealthResponse });
    } catch (cause) {
      setState({
        phase: 'error',
        message: cause instanceof Error ? cause.message : 'Health check failed.',
      });
    }
  }, []);

  useEffect(() => {
    // Fetching on mount is the "subscribe to an external system" case the rule
    // documents as valid: the model daemon lives outside React and its liveness
    // cannot be derived from props. Every setState happens after an await, so no
    // cascading render occurs — the rule cannot see through the async callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The manual path does show a spinner, which is safe here: it runs from an event
  // handler rather than from an effect body.
  const recheck = useCallback(() => {
    setState({ phase: 'loading' });
    void load();
  }, [load]);

  const tone =
    state.phase === 'loaded' && state.data.status === 'ok'
      ? 'border-moss-400 bg-moss-100 dark:bg-moss-900/40'
      : state.phase === 'loading'
        ? 'border-moss-200 bg-moss-50 dark:border-bark-700 dark:bg-bark-800'
        : 'border-sun-400 bg-sun-400/10';

  const summary =
    state.phase === 'loading'
      ? 'Checking whether the AI model is running…'
      : state.phase === 'error'
        ? 'We could not check on the AI model just now.'
        : state.data.status === 'ok'
          ? 'The AI model is running, so the Game Master can add twists.'
          : state.data.status === 'misconfigured'
            ? 'The AI model is not set up correctly on this site.'
            : 'The AI model is not running. Games still work; they just have no Game Master twists.';

  return (
    <section className={`rounded-2xl border-2 p-5 ${tone}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-black">Game Master status</h3>
        <button
          type="button"
          onClick={recheck}
          className="focus-visible:outline-sun-500 min-h-11 rounded-lg border-2 border-current px-3 text-sm font-semibold hover:bg-black/5 focus-visible:outline-3 focus-visible:outline-offset-2 dark:hover:bg-white/10"
        >
          Check again
        </button>
      </div>

      <p className="mt-2 font-semibold">{summary}</p>

      {state.phase === 'loaded' && state.data.status === 'misconfigured' && (
        <p className="mt-2 text-sm">
          If you run this site yourself: run <code className="font-mono">npm run setup</code> and
          check the settings it creates.
        </p>
      )}

      {state.phase === 'loaded' && state.data.model && (
        <details className="mt-3 text-sm">
          <summary className="focus-visible:outline-sun-500 cursor-pointer rounded font-semibold focus-visible:outline-3 focus-visible:outline-offset-2">
            Technical details
          </summary>
          <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="font-semibold">Provider</dt>
            <dd className="font-mono text-xs sm:text-sm">{state.data.model.provider}</dd>
            <dt className="font-semibold">Model</dt>
            <dd className="font-mono text-xs sm:text-sm">{state.data.model.model}</dd>
            <dt className="font-semibold">Reachable</dt>
            <dd>{state.data.model.reachable ? `yes (${state.data.model.latencyMs}ms)` : 'no'}</dd>
            <dt className="font-semibold">Model present</dt>
            <dd>{state.data.model.modelAvailable ? 'yes' : 'no'}</dd>
          </dl>
          {state.data.model.detail && (
            <p className="mt-2 rounded-md bg-black/5 p-3 dark:bg-white/10">
              {state.data.model.detail}
            </p>
          )}
        </details>
      )}
    </section>
  );
}
