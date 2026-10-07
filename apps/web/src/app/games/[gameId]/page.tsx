import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GAME_IDS, findGameDefinition } from '@touchgrass/game-definitions';
import { policyFor } from '@touchgrass/safety';

interface PageProps {
  params: Promise<{ gameId: string }>;
}

export function generateStaticParams(): { gameId: string }[] {
  return GAME_IDS.map((gameId) => ({ gameId }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { gameId } = await params;
  const game = findGameDefinition(gameId);
  if (!game) return { title: 'Unknown game' };
  return { title: game.name, description: game.tagline };
}

export default async function GamePage({ params }: PageProps) {
  const { gameId } = await params;
  const game = findGameDefinition(gameId);
  if (!game) notFound();

  // The policy is derived here rather than hand-written, which is the point: the
  // safety configuration for a session comes from the game definition, so the
  // page cannot show limits that differ from the ones a real session would use.
  const policy = policyFor(game);

  return (
    <article className="space-y-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-black tracking-tight">{game.name}</h1>
        <p className="text-bark-800 dark:text-moss-100/80 text-lg">{game.tagline}</p>
        <p className="text-bark-700 dark:text-moss-200/60 font-mono text-xs">
          {game.minPlayers}–{game.maxPlayers} players · {game.recommendedDurationMinutes} min ·{' '}
          {game.spaceRequirement} space · {game.intensity} intensity ·{' '}
          {game.equipment.length === 0 ? 'no equipment' : game.equipment.join(', ')}
        </p>
      </header>

      <Section title="How it works">
        <p className="text-bark-800 dark:text-moss-100/80">{game.description}</p>
      </Section>

      <Section title="Roles">
        <ul className="space-y-2">
          {game.roles.map((role) => (
            <li
              key={role.id}
              className="border-moss-200 dark:border-bark-700 rounded-lg border p-3"
            >
              <p className="font-bold">
                {role.label}
                <span className="text-bark-700 dark:text-moss-200/60 ml-2 font-mono text-xs font-normal">
                  min {role.min}
                  {role.max === undefined ? ' · no cap' : ` · max ${role.max}`}
                  {role.isDefault ? ' · default' : ''}
                </span>
              </p>
              <p className="text-bark-800 dark:text-moss-100/75 mt-1 text-sm">{role.description}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Phases">
        <ol className="space-y-2">
          {game.phases.map((phase, index) => (
            <li key={phase.id} className="flex gap-3">
              <span className="bg-moss-600 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white">
                {index + 1}
              </span>
              <div>
                <p className="font-bold">
                  {phase.label}
                  {phase.typicalDurationSeconds !== undefined && (
                    <span className="text-bark-700 dark:text-moss-200/60 ml-2 font-mono text-xs font-normal">
                      ~{Math.round(phase.typicalDurationSeconds / 60)} min
                    </span>
                  )}
                </p>
                <p className="text-bark-800 dark:text-moss-100/75 mt-0.5 text-sm">
                  {phase.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="What the Game Master may propose">
        <div className="flex flex-wrap gap-1.5">
          {game.allowedEventKinds.map((kind) => (
            <span
              key={kind}
              className="bg-moss-200 text-moss-800 dark:bg-moss-900 dark:text-moss-200 rounded px-2 py-0.5 font-mono text-[11px] font-semibold"
            >
              {kind}
            </span>
          ))}
        </div>
        <p className="text-bark-800 dark:text-moss-100/75 mt-3 text-sm">
          Themes it draws from: {game.modifierThemes.join(', ')}.
        </p>
        <h3 className="mt-5 font-bold">Example twists</h3>
        <ul className="mt-2 space-y-1.5">
          {game.gameMaster.exampleTwists.map((twist) => (
            <li
              key={twist}
              className="border-moss-400 text-bark-800 dark:text-moss-100/80 border-l-2 pl-3 text-sm italic"
            >
              “{twist}”
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Safety profile">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="font-semibold">Contact policy</dt>
          <dd className="font-mono text-xs sm:text-sm">{game.safety.contactPolicy}</dd>
          <dt className="font-semibold">Max intensity</dt>
          <dd className="font-mono text-xs sm:text-sm">{game.safety.maxIntensity}</dd>
          <dt className="font-semibold">Players separate</dt>
          <dd>{game.safety.involvesSeparation ? 'yes, inherently' : 'no'}</dd>
          <dt className="font-semibold">Daylight required</dt>
          <dd>{game.safety.requiresDaylight ? 'yes' : 'no'}</dd>
          <dt className="font-semibold">Max generated rule length</dt>
          <dd>{policy.maxRuleDurationSeconds}s (derived from intensity)</dd>
          <dt className="font-semibold">Hazard categories enforced</dt>
          <dd>{policy.enforcedHazards.length}</dd>
        </dl>

        <h3 className="mt-5 font-bold">Inherent risks</h3>
        <ul className="text-bark-800 dark:text-moss-100/80 mt-2 list-disc space-y-1 pl-5 text-sm">
          {game.safety.inherentRisks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>

        <h3 className="mt-5 font-bold">Never proposed in this game</h3>
        <ul className="text-bark-800 dark:text-moss-100/80 mt-2 list-disc space-y-1 pl-5 text-sm">
          {game.gameMaster.avoid.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-bold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
