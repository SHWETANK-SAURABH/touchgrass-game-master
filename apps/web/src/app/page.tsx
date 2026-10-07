import Link from 'next/link';
import { listGameDefinitions } from '@touchgrass/game-definitions';
import { GAME_EVENT_KINDS } from '@touchgrass/game-definitions';
import { HAZARD_CATEGORIES } from '@touchgrass/safety';
import { ModelStatus } from '@/components/model-status';

const PIPELINE = [
  {
    step: 'AI proposes',
    detail:
      'Gemma, running on an open-weight runtime, emits a structured GameEvent constrained by a JSON Schema. It never touches state.',
  },
  {
    step: 'Zod validates',
    detail:
      'The proposal is parsed against a strict discriminated union. Unknown keys, long rules, and oversized score changes are rejected outright.',
  },
  {
    step: 'Safety validates',
    detail:
      'A deterministic rule set checks the proposal against the hazard taxonomy and the game policy. No model is consulted.',
  },
  {
    step: 'Engine executes',
    detail:
      'A pure reducer applies the approved event. Same state plus same command always gives the same result, on any host.',
  },
  {
    step: 'Players act',
    detail: 'Outdoors. On grass. The screen refereed; the world is where the game happened.',
  },
] as const;

export default function HomePage() {
  const games = listGameDefinitions();

  return (
    <div className="space-y-12">
      <section className="space-y-5">
        <p className="bg-moss-200 text-moss-800 dark:bg-moss-900 dark:text-moss-200 inline-block rounded-full px-3 py-1 text-xs font-bold tracking-wider uppercase">
          Hacktoberfest · Touch Grass
        </p>
        <h1 className="text-4xl leading-tight font-black tracking-tight sm:text-5xl">
          The screen is the referee.
          <br />
          <span className="text-moss-600 dark:text-moss-400">The world is the game.</span>
        </h1>
        <p className="text-bark-800 dark:text-moss-100/80 max-w-2xl text-lg">
          TouchGrass runs real outdoor games — tag, hide &amp; seek, treasure hunts — with an
          open-weight model acting as Game Master. It invents twists, shrinks boundaries, rebalances
          teams, and writes riddles about the park you are standing in. Everything it proposes is
          validated by deterministic code before a single player hears it.
        </p>
      </section>

      <ModelStatus />

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">Why an agent, not a chatbot</h2>
        <p className="text-bark-800 dark:text-moss-100/80 max-w-2xl">
          A chatbot bolted onto a game would narrate. This Game Master changes the rules of play
          while the round is running — which means its output has to be structured, bounded, and
          refusable. The model proposes; it never decides.
        </p>
        <ol className="space-y-3">
          {PIPELINE.map((stage, index) => (
            <li
              key={stage.step}
              className="border-moss-200 dark:border-bark-700 dark:bg-bark-800/60 flex gap-4 rounded-lg border bg-white/60 p-4"
            >
              <span className="bg-moss-600 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white">
                {index + 1}
              </span>
              <div>
                <h3 className="font-bold">{stage.step}</h3>
                <p className="text-bark-800 dark:text-moss-100/75 mt-1 text-sm">{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat value={String(games.length)} label="games defined as data" />
        <Stat value={String(GAME_EVENT_KINDS.length)} label="event kinds the model may propose" />
        <Stat value={String(HAZARD_CATEGORIES.length)} label="hazard categories catalogued" />
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-2xl font-bold tracking-tight">The games</h2>
          <Link
            href="/games"
            className="text-moss-700 decoration-moss-400 hover:text-moss-600 dark:text-moss-300 text-sm font-semibold underline underline-offset-4"
          >
            See all rules and safety profiles →
          </Link>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {games.map((game) => (
            <li key={game.id}>
              <Link
                href={`/games/${game.id}`}
                className="border-moss-200 hover:border-moss-400 dark:border-bark-700 dark:bg-bark-800/60 block h-full rounded-lg border bg-white/60 p-4 transition"
              >
                <h3 className="font-bold">{game.name}</h3>
                <p className="text-bark-800 dark:text-moss-100/75 mt-1 text-sm">{game.tagline}</p>
                <p className="text-bark-700 dark:text-moss-200/60 mt-3 font-mono text-xs">
                  {game.minPlayers}–{game.maxPlayers} players · {game.recommendedDurationMinutes}{' '}
                  min · {game.intensity} intensity
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-moss-200 dark:border-bark-700 dark:bg-bark-800/60 rounded-lg border bg-white/60 p-4">
      <p className="text-moss-600 dark:text-moss-400 text-3xl font-black">{value}</p>
      <p className="text-bark-800 dark:text-moss-100/75 mt-1 text-sm">{label}</p>
    </div>
  );
}
