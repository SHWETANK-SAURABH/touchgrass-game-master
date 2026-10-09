import type { Metadata } from 'next';
import Link from 'next/link';
import { listGameDefinitions } from '@touchgrass/game-definitions';
import { GameCard } from '@/components/game-card';
import { linkStyle, muted } from '@/components/ui';
import { isPlayable } from '@/lib/playable';

export const metadata: Metadata = {
  title: 'Games',
  description:
    'Every TouchGrass game: what it is, how many players it needs, and whether you can play it now.',
};

export default function GamesPage() {
  const games = listGameDefinitions();
  const playable = games.filter((game) => isPlayable(game.id));
  const upcoming = games.filter((game) => !isPlayable(game.id));

  return (
    <div className="space-y-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Games</h1>
        <p className="max-w-2xl text-lg">
          Pick a game to start one with your friends. Already have a link from a host?{' '}
          <Link href="/join" className={linkStyle}>
            Join their game
          </Link>
          .
        </p>
      </header>

      <section aria-labelledby="playable-heading" className="space-y-4">
        <h2 id="playable-heading" className="text-2xl font-black tracking-tight">
          Play now
        </h2>
        {playable.length === 0 ? (
          <p className={muted}>No games can be played yet.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {playable.map((game) => (
              <li key={game.id}>
                <GameCard game={game} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {upcoming.length > 0 && (
        <section aria-labelledby="upcoming-heading" className="space-y-4">
          <h2 id="upcoming-heading" className="text-2xl font-black tracking-tight">
            Coming soon
          </h2>
          <p className={`max-w-2xl ${muted}`}>
            These games have their rules written, but they cannot be played here yet. You can read
            how each one will work.
          </p>
          <ul className="grid gap-4 sm:grid-cols-2">
            {upcoming.map((game) => (
              <li key={game.id}>
                <GameCard game={game} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
