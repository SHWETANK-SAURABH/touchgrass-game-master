import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GAME_IDS, findGameDefinition } from '@touchgrass/game-definitions';
import { StartGame } from '@/components/start-game';
import { GameFacts, GameStatusBadge, Notice, card, linkStyle, muted } from '@/components/ui';
import { isPlayable } from '@/lib/playable';

interface PageProps {
  params: Promise<{ gameId: string }>;
}

export function generateStaticParams(): { gameId: string }[] {
  return GAME_IDS.map((gameId) => ({ gameId }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { gameId } = await params;
  const game = findGameDefinition(gameId);
  return { title: game ? `Play ${game.name}` : 'Unknown game' };
}

const STEPS = [
  'Create the game. You become the host.',
  'Share the link that appears. Each player opens it on their own phone and joins.',
  'Join the game yourself, then everyone taps “I am ready”.',
  'The first round starts as soon as everyone is ready.',
] as const;

export default async function PlayPage({ params }: PageProps) {
  const { gameId } = await params;
  const game = findGameDefinition(gameId);
  if (!game) notFound();

  return (
    <div className="space-y-8">
      <p>
        <Link href="/games" className={linkStyle}>
          ← All games
        </Link>
      </p>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Play {game.name}</h1>
          <GameStatusBadge gameId={game.id} />
        </div>
        <p className="max-w-2xl text-lg">{game.tagline}</p>
        <GameFacts game={game} />
      </header>

      {isPlayable(game.id) ? (
        <>
          <section className={card} aria-labelledby="steps-heading">
            <h2 id="steps-heading" className="text-xl font-black tracking-tight">
              Starting a game
            </h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5">
              {STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className={`mt-3 text-sm ${muted}`}>
              You need {game.minPlayers} to {game.maxPlayers} players, each with a phone.{' '}
              <Link href={`/games/${game.id}` as Route} className={linkStyle}>
                Read the rules first
              </Link>
              .
            </p>
          </section>
          <StartGame gameId={game.id} gameName={game.name} />
        </>
      ) : (
        <Notice
          title={`${game.name} cannot be played here yet`}
          action={
            <div className="flex flex-wrap gap-4">
              <Link href={`/games/${game.id}` as Route} className={linkStyle}>
                Read the rules
              </Link>
              <Link href="/games" className={linkStyle}>
                See what you can play now
              </Link>
            </div>
          }
        >
          Its rules are written, but the game engine does not run it from start to finish yet, so we
          do not offer a game that could not be completed.
        </Notice>
      )}
    </div>
  );
}
