import type { ReactNode } from 'react';
import { isPlayable } from '@/lib/playable';

/**
 * The few shared pieces of the interface: buttons, cards, badges and notices.
 *
 * Kept as class names and tiny components rather than a component library. The
 * site is used outdoors, on phones, in daylight: large targets, strong
 * contrast, and a focus ring on everything that can be reached by keyboard.
 */

const focus =
  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-sun-500';

export const buttonPrimary = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-moss-700 px-5 py-3 text-base font-bold text-white transition hover:bg-moss-800 disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;

export const buttonSecondary = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-moss-700 px-5 py-3 text-base font-bold text-moss-800 transition hover:bg-moss-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-moss-400 dark:text-moss-100 dark:hover:bg-bark-800 ${focus}`;

export const buttonQuiet = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-moss-800 underline decoration-moss-400 underline-offset-4 hover:text-moss-900 dark:text-moss-200 ${focus}`;

export const buttonDanger = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-red-700 px-5 py-3 text-base font-bold text-red-800 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-400 dark:text-red-200 dark:hover:bg-red-950 ${focus}`;

export const card =
  'rounded-2xl border border-moss-200 bg-white p-5 shadow-sm dark:border-bark-700 dark:bg-bark-800';

export const input = `block w-full min-h-12 rounded-xl border-2 border-moss-300 bg-white px-4 py-3 text-base text-bark-900 placeholder:text-bark-700/60 dark:border-bark-700 dark:bg-bark-900 dark:text-moss-50 ${focus}`;

export const label = 'mb-1.5 block text-sm font-bold';

export const muted = 'text-bark-700 dark:text-moss-200/80';

export const linkStyle = `font-semibold text-moss-800 underline decoration-moss-400 underline-offset-4 hover:text-moss-900 dark:text-moss-200 ${focus}`;

export function Badge({
  tone,
  children,
}: {
  tone: 'ready' | 'soon' | 'info' | 'warn';
  children: ReactNode;
}) {
  const tones = {
    ready: 'bg-moss-700 text-white',
    soon: 'bg-bark-700/10 text-bark-800 dark:bg-moss-100/10 dark:text-moss-100',
    info: 'bg-moss-100 text-moss-900 dark:bg-moss-900 dark:text-moss-100',
    warn: 'bg-sun-400 text-bark-900',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Whether a game can be played now, said in words and not by colour alone. */
export function GameStatusBadge({ gameId }: { gameId: string }) {
  return isPlayable(gameId) ? (
    <Badge tone="ready">Playable now</Badge>
  ) : (
    <Badge tone="soon">Coming soon</Badge>
  );
}

/** Something the person should know. An error is announced; the rest is polite. */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'error' | 'success';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    info: 'border-moss-300 bg-moss-100 text-bark-900 dark:border-moss-700 dark:bg-moss-900/60 dark:text-moss-50',
    error:
      'border-red-300 bg-red-50 text-red-950 dark:border-red-500 dark:bg-red-950 dark:text-red-50',
    success:
      'border-moss-500 bg-moss-100 text-bark-900 dark:border-moss-400 dark:bg-moss-900 dark:text-moss-50',
  } as const;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border-2 p-4 ${tones[tone]}`}
    >
      {title && <p className="font-bold">{title}</p>}
      <div className={title ? 'mt-1 text-sm' : 'text-sm'}>{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** A spinner with words, for anything that takes a moment. */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className={`flex items-center gap-3 ${muted}`}>
      <span
        aria-hidden="true"
        className="border-moss-300 border-t-moss-700 size-5 animate-spin rounded-full border-2"
      />
      {children}
    </p>
  );
}

/** A short list of facts about a game, the same everywhere it appears. */
export function GameFacts({
  game,
}: {
  game: {
    minPlayers: number;
    maxPlayers: number;
    recommendedDurationMinutes: number;
    intensity: string;
    spaceRequirement: string;
  };
}) {
  return (
    <dl className={`flex flex-wrap gap-x-5 gap-y-1 text-sm ${muted}`}>
      <div className="flex gap-1.5">
        <dt className="font-semibold">Players</dt>
        <dd>
          {game.minPlayers}–{game.maxPlayers}
        </dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="font-semibold">Time</dt>
        <dd>about {game.recommendedDurationMinutes} min</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="font-semibold">Effort</dt>
        <dd>{game.intensity}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="font-semibold">Space</dt>
        <dd>{game.spaceRequirement}</dd>
      </div>
    </dl>
  );
}
