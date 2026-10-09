import type { Route } from 'next';
import Link from 'next/link';
import type { GameDefinition } from '@touchgrass/game-definitions';
import { isPlayable } from '@/lib/playable';
import { GameFacts, GameStatusBadge, buttonPrimary, buttonQuiet, card, muted } from './ui';

/** One game in the catalogue: what it is, who it is for, and what you can do with it. */
export function GameCard({ game }: { game: GameDefinition }) {
  const playable = isPlayable(game.id);
  return (
    <article className={`${card} flex h-full flex-col gap-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-xl font-black tracking-tight">{game.name}</h3>
        <GameStatusBadge gameId={game.id} />
      </div>
      <p className="text-bark-800 dark:text-moss-100">{game.tagline}</p>
      <GameFacts game={game} />
      <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
        {playable ? (
          <Link href={`/play/${game.id}` as Route} className={buttonPrimary}>
            Play {game.name}
          </Link>
        ) : (
          <p className={`text-sm ${muted}`}>
            You can read the rules. Playing it here is not ready yet.
          </p>
        )}
        <Link href={`/games/${game.id}` as Route} className={buttonQuiet}>
          Rules<span className="sr-only"> for {game.name}</span>
        </Link>
      </div>
    </article>
  );
}
