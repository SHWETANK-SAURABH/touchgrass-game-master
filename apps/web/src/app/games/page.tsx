import type { Metadata } from 'next';
import Link from 'next/link';
import { listGameDefinitions } from '@touchgrass/game-definitions';

export const metadata: Metadata = {
  title: 'Games',
  description:
    'Every TouchGrass game, with its roles, phases, safety profile, and the optional event kinds it supports.',
};

export default function GamesPage() {
  const games = listGameDefinitions();

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-black tracking-tight">Games</h1>
        <p className="text-bark-800 dark:text-moss-100/80 max-w-2xl">
          Each game is a validated data file in{' '}
          <code className="font-mono text-sm">packages/game-definitions</code>, not code. It
          declares its own roles, phases, contact policy, inherent risks, and the subset of event
          kinds the Game Master is permitted to propose. Adding a sixth game is a pull request
          against one file.
        </p>
      </header>

      <ul className="space-y-4">
        {games.map((game) => (
          <li
            key={game.id}
            className="border-moss-200 dark:border-bark-700 dark:bg-bark-800/60 rounded-xl border bg-white/60 p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-xl font-bold">
                <Link href={`/games/${game.id}`} className="hover:text-moss-600">
                  {game.name}
                </Link>
              </h2>
              <p className="text-bark-700 dark:text-moss-200/60 font-mono text-xs">
                {game.minPlayers}–{game.maxPlayers} players · {game.recommendedDurationMinutes} min
                · {game.spaceRequirement} space · {game.intensity} intensity
              </p>
            </div>

            <p className="text-bark-800 dark:text-moss-100/80 mt-2 text-sm">{game.tagline}</p>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {game.allowedEventKinds.map((kind) => (
                <span
                  key={kind}
                  className="bg-moss-200 text-moss-800 dark:bg-moss-900 dark:text-moss-200 rounded px-2 py-0.5 font-mono text-[11px] font-semibold"
                >
                  {kind}
                </span>
              ))}
            </div>

            <p className="text-bark-700 dark:text-moss-200/60 mt-4 text-xs">
              Contact: {game.safety.contactPolicy} · Separation:{' '}
              {game.safety.involvesSeparation ? 'expected' : 'none'} ·{' '}
              {game.safety.inherentRisks.length} inherent risks documented
            </p>

            <Link
              href={`/games/${game.id}`}
              className="text-moss-700 decoration-moss-400 dark:text-moss-300 mt-3 inline-block text-sm font-semibold underline underline-offset-4"
            >
              Full rules, roles and Game Master guidance →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
