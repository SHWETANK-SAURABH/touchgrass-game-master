import Link from 'next/link';
import { listGameDefinitions } from '@touchgrass/game-definitions';
import { GameCard } from '@/components/game-card';
import { ModelStatus } from '@/components/model-status';
import { buttonPrimary, buttonSecondary, card, linkStyle, muted } from '@/components/ui';
import { isPlayable } from '@/lib/playable';

const STEPS = [
  {
    title: 'Pick a game',
    detail:
      'Choose Tag or Hide & Seek. Each one says how many players it needs and how long it takes.',
  },
  {
    title: 'Share the link',
    detail: 'Create a game and send the link to your friends. Everyone joins on their own phone.',
  },
  {
    title: 'Go outside and play',
    detail:
      'When everyone is ready the round starts. Tap what happened, and the scores and the clock update for everybody.',
  },
] as const;

export default function HomePage() {
  const games = listGameDefinitions();
  const playable = games.filter((game) => isPlayable(game.id));

  return (
    <div className="space-y-14">
      <section className="space-y-6">
        <h1 className="text-4xl leading-tight font-black tracking-tight sm:text-5xl">
          Outdoor games,
          <br />
          <span className="text-moss-700 dark:text-moss-400">refereed by your phone.</span>
        </h1>
        <p className="max-w-2xl text-lg">
          TouchGrass runs real games in the real world. You and your friends go outside and play; it
          hands out the roles, keeps the score and runs the clock. An AI Game Master can add a twist
          to each round, and every twist is checked for safety before anyone sees it.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/games" className={buttonPrimary}>
            Find a game
          </Link>
          <Link href="/join" className={buttonSecondary}>
            Join a game
          </Link>
        </div>
      </section>

      <section aria-labelledby="how-heading" className="space-y-4">
        <h2 id="how-heading" className="text-2xl font-black tracking-tight">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className={card}>
              <span
                aria-hidden="true"
                className="bg-moss-700 flex size-9 items-center justify-center rounded-full text-base font-black text-white"
              >
                {index + 1}
              </span>
              <h3 className="mt-3 text-lg font-black">
                <span className="sr-only">Step {index + 1}: </span>
                {step.title}
              </h3>
              <p className={`mt-1 text-sm ${muted}`}>{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="play-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="play-heading" className="text-2xl font-black tracking-tight">
            Ready to play
          </h2>
          <Link href="/games" className={linkStyle}>
            See all {games.length} games
          </Link>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {playable.map((game) => (
            <li key={game.id}>
              <GameCard game={game} />
            </li>
          ))}
        </ul>
        <p className={`text-sm ${muted}`}>
          Both need 2 to 4 players. {games.length - playable.length} more games are on the way; you
          can already read their rules.
        </p>
      </section>

      <section aria-labelledby="gm-heading" className="space-y-4">
        <h2 id="gm-heading" className="text-2xl font-black tracking-tight">
          About the Game Master
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={card}>
            <h3 className="text-lg font-black">It suggests. It never decides.</h3>
            <p className={`mt-2 text-sm ${muted}`}>
              At the start of a round the Game Master may propose one twist: a safe zone, a bonus
              challenge, a little more time. Ordinary code then checks that the twist is allowed in
              the game and is not sending anyone near a road, a roof or water. Only then do players
              see it. If the AI is switched off or slow, the game is played exactly the same without
              it.
            </p>
            <p className="mt-3">
              <a
                href="https://github.com/SHWETANK-SAURABH/touchgrass_game_master#how-the-game-master-works"
                className={linkStyle}
                target="_blank"
                rel="noreferrer"
              >
                How the safety checks work
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          </div>
          <ModelStatus />
        </div>
      </section>
    </div>
  );
}
