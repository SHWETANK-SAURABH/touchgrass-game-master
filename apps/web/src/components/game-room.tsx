'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { findGameDefinition } from '@touchgrass/game-definitions';
import type { GameState } from '@touchgrass/game-engine';
import {
  findPlayer,
  formatClock,
  inForce,
  messageFor,
  presentPlayers,
  recentActivity,
  reportOptions,
  roleDescription,
  roleLabel,
  scoreboard,
  secondsLeft,
} from '@/lib/session-view';
import { type GameSessionView, useGameSession } from '@/lib/use-game-session';
import {
  Badge,
  Loading,
  Notice,
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  buttonSecondary,
  card,
  input,
  label,
  linkStyle,
  muted,
} from './ui';

/**
 * A game, as one person in it sees it.
 *
 * This screen shows what the server sent and offers the actions the protocol
 * already has. It decides nothing about the game: the engine hands out roles,
 * keeps the score, ends the rounds and names the winners, and the screen
 * follows.
 */

const STOPPED: Record<string, { title: string; body: string; retry: boolean }> = {
  SESSION_NOT_FOUND: {
    title: 'We could not find that game',
    body: 'It may have been removed, or the link may be incomplete. Ask the host to share it again, or start a new game.',
    retry: false,
  },
  INVALID_SESSION_PATH: {
    title: 'That game link does not look right',
    body: 'Ask the host to share the link again.',
    retry: false,
  },
  CONNECTION_REPLACED: {
    title: 'You opened this game somewhere else',
    body: 'A player can be connected from one place at a time, so this window was disconnected. You can take it back here.',
    retry: true,
  },
  CONNECTION_LOST: {
    title: 'The connection was lost',
    body: 'We tried several times and could not reach the game. Check your signal, then try again. Your place in the game is kept.',
    retry: true,
  },
  NOT_CONFIGURED: {
    title: 'Playing is not set up on this site yet',
    body: 'This copy of the site has not been connected to a game server.',
    retry: false,
  },
  SERVER_UNAVAILABLE: {
    title: 'The game server is not answering',
    body: 'It may be starting up or offline. Try again in a moment.',
    retry: true,
  },
  SITE_UNREACHABLE: {
    title: 'The site could not be reached',
    body: 'Check your connection and try again.',
    retry: true,
  },
};

/** The time now, updated often enough for a countdown. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

export function GameRoom({ sessionId, initialCode }: { sessionId: string; initialCode: string }) {
  const session = useGameSession(sessionId);
  const { connection, game, playerId, isHost, notice } = session;
  const now = useNow();

  if (connection.phase === 'stopped') {
    const message = STOPPED[connection.code] ?? {
      title: 'This game cannot be shown',
      body: messageFor(connection.code),
      retry: true,
    };
    return (
      <Notice
        tone="error"
        title={message.title}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {message.retry && (
              <button type="button" className={buttonPrimary} onClick={session.retry}>
                Try again
              </button>
            )}
            <Link href="/games" className={linkStyle}>
              Browse games
            </Link>
            <Link href="/join" className={linkStyle}>
              Join a different game
            </Link>
          </div>
        }
      >
        {message.body}
      </Notice>
    );
  }

  if (connection.phase === 'connecting' && !game) return <Loading>Connecting to the game…</Loading>;

  const me = game ? findPlayer(game, playerId) : undefined;
  const joined = me !== undefined && me.status !== 'left';

  return (
    <div className="space-y-6">
      {connection.phase === 'reconnecting' && (
        <Notice title="Reconnecting…">
          The connection dropped. We are getting you back in; your place in the game is kept.
        </Notice>
      )}
      {notice && (
        <Notice
          tone="error"
          action={
            <button type="button" className={buttonQuiet} onClick={session.dismissNotice}>
              Dismiss
            </button>
          }
        >
          {notice}
        </Notice>
      )}

      {!joined && (
        <JoinPanel
          session={session}
          initialCode={initialCode}
          game={game}
          disabled={connection.phase !== 'needs-join' && connection.phase !== 'ready'}
        />
      )}

      {game && (joined || isHost) && (
        <GameView
          game={game}
          playerId={joined ? playerId : undefined}
          isHost={isHost}
          session={session}
          sessionId={sessionId}
          now={now}
        />
      )}
    </div>
  );
}

function JoinPanel({
  session,
  initialCode,
  game,
  disabled,
}: {
  session: GameSessionView;
  initialCode: string;
  game: GameState | undefined;
  disabled: boolean;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(initialCode);
  const started = game !== undefined && game.status !== 'lobby';

  if (started) {
    return (
      <Notice title="This game has already started">
        New players can only join before the first round. You can watch the host controls below, or
        start a new game.
      </Notice>
    );
  }

  return (
    <section className={card} aria-labelledby="join-heading">
      <h2 id="join-heading" className="text-xl font-black tracking-tight">
        Join this game
      </h2>
      <p className={`mt-1 text-sm ${muted}`}>
        Pick the name the other players will see, and enter the join code from the host.
      </p>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '' && code.trim() !== '') session.join(name, code);
        }}
      >
        <div>
          <label htmlFor="player-name" className={label}>
            Your name
          </label>
          <input
            id="player-name"
            className={input}
            value={name}
            maxLength={40}
            required
            autoComplete="nickname"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor="join-code" className={label}>
            Join code
          </label>
          <input
            id="join-code"
            className={`${input} font-mono tracking-widest uppercase`}
            value={code}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
            }}
          />
        </div>
        <div className="sm:col-span-2">
          <button
            type="submit"
            className={`${buttonPrimary} w-full sm:w-auto`}
            disabled={disabled || name.trim() === '' || code.trim() === ''}
          >
            Join the game
          </button>
        </div>
      </form>
    </section>
  );
}

function GameView({
  game,
  playerId,
  isHost,
  session,
  sessionId,
  now,
}: {
  game: GameState;
  playerId: string | undefined;
  isHost: boolean;
  session: GameSessionView;
  sessionId: string;
  now: number;
}) {
  const definition = findGameDefinition(game.gameId);
  const me = findPlayer(game, playerId);
  const players = presentPlayers(game);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black tracking-tight">{definition?.name ?? 'Game'}</h2>
          <p className={`text-sm ${muted}`}>
            {me ? `You are ${me.displayName}.` : 'You are hosting and not playing.'}
            {isHost && me ? ' You are also the host.' : ''}
          </p>
        </div>
        <StatusBadge game={game} />
      </header>

      {game.status === 'lobby' && (
        <Lobby
          game={game}
          me={me}
          isHost={isHost}
          session={session}
          sessionId={sessionId}
          minPlayers={definition?.minPlayers ?? 2}
          maxPlayers={definition?.maxPlayers ?? players.length}
        />
      )}

      {(game.status === 'active' || game.status === 'paused') && (
        <Round game={game} playerId={playerId} session={session} now={now} />
      )}

      {(game.status === 'completed' || game.status === 'aborted') && <Results game={game} />}

      {isHost && game.status !== 'completed' && game.status !== 'aborted' && (
        <HostControls game={game} session={session} />
      )}

      {game.status !== 'lobby' && <Activity game={game} />}
    </div>
  );
}

function StatusBadge({ game }: { game: GameState }) {
  if (game.status === 'lobby') return <Badge tone="info">Waiting for players</Badge>;
  if (game.status === 'paused') return <Badge tone="warn">Paused</Badge>;
  if (game.status === 'completed') return <Badge tone="ready">Finished</Badge>;
  if (game.status === 'aborted') return <Badge tone="soon">Stopped by the host</Badge>;
  return (
    <Badge tone="ready">
      Round {game.currentRound} of {game.settings.totalRounds}
    </Badge>
  );
}

function Lobby({
  game,
  me,
  isHost,
  session,
  sessionId,
  minPlayers,
  maxPlayers,
}: {
  game: GameState;
  me: ReturnType<typeof findPlayer>;
  isHost: boolean;
  session: GameSessionView;
  sessionId: string;
  minPlayers: number;
  maxPlayers: number;
}) {
  const players = presentPlayers(game);
  const waitingFor = Math.max(0, minPlayers - players.length);
  const notReady = players.filter((player) => !player.ready).length;

  return (
    <div className="space-y-6">
      <Invite sessionId={sessionId} joinCode={game.joinCode} />

      <section className={card} aria-labelledby="players-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="players-heading" className="text-lg font-black">
            Players ({players.length} of {maxPlayers})
          </h3>
          <p className={`text-sm ${muted}`}>
            Needs {minPlayers} to {maxPlayers} players
          </p>
        </div>

        {players.length === 0 ? (
          <p className={`mt-3 ${muted}`}>
            Nobody has joined yet. Share the link above, then join the game yourself.
          </p>
        ) : (
          <ul className="divide-moss-200 dark:divide-bark-700 mt-3 divide-y">
            {players.map((player) => (
              <li key={player.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="font-semibold">
                  {player.displayName}
                  {player.id === me?.id && <span className={`ml-2 text-sm ${muted}`}>(you)</span>}
                </span>
                {player.ready ? (
                  <Badge tone="ready">Ready</Badge>
                ) : (
                  <Badge tone="soon">Not ready</Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 font-semibold" role="status">
          {waitingFor > 0
            ? `Waiting for ${String(waitingFor)} more ${waitingFor === 1 ? 'player' : 'players'} to join.`
            : notReady > 0
              ? `The game starts when everyone is ready. Waiting for ${String(notReady)}.`
              : 'Everyone is ready. Starting…'}
        </p>

        {me && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonPrimary}
              disabled={me.ready}
              onClick={() => {
                session.act({ type: 'PLAYER_READY' });
              }}
            >
              {me.ready ? 'You are ready' : 'I am ready'}
            </button>
            <button type="button" className={buttonQuiet} onClick={session.leave}>
              Leave the game
            </button>
          </div>
        )}
        {!me && isHost && (
          <p className={`mt-3 text-sm ${muted}`}>
            You created this game. Join it above to play, or stay as host only.
          </p>
        )}
      </section>
    </div>
  );
}

function Invite({ sessionId, joinCode }: { sessionId: string; joinCode: string }) {
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState('');
  useEffect(() => {
    // The address of this page, with the join code, so one link is enough.
    const timer = setTimeout(() => {
      setLink(
        `${window.location.origin}/session/${encodeURIComponent(sessionId)}?code=${encodeURIComponent(joinCode)}`,
      );
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [sessionId, joinCode]);

  return (
    <section className={card} aria-labelledby="invite-heading">
      <h3 id="invite-heading" className="text-lg font-black">
        Invite players
      </h3>
      <p className={`mt-1 text-sm ${muted}`}>
        Send this link to the people playing. They open it on their own phone and join.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label htmlFor="invite-link" className={label}>
            Link
          </label>
          <input
            id="invite-link"
            className={`${input} font-mono text-sm`}
            value={link}
            readOnly
            onFocus={(event) => {
              event.target.select();
            }}
          />
        </div>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            void navigator.clipboard
              .writeText(link)
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                setCopied(false);
              });
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="mt-3">
        <span className="font-bold">Join code:</span>{' '}
        <span className="font-mono text-lg font-black tracking-widest">{joinCode}</span>
      </p>
      <p className="sr-only" role="status">
        {copied ? 'Link copied.' : ''}
      </p>
    </section>
  );
}

function Round({
  game,
  playerId,
  session,
  now,
}: {
  game: GameState;
  playerId: string | undefined;
  session: GameSessionView;
  now: number;
}) {
  const definition = findGameDefinition(game.gameId);
  const me = findPlayer(game, playerId);
  const left = secondsLeft(game, now);
  const options = reportOptions(game, definition, playerId, now);
  const rules = inForce(game, now);
  const paused = game.status === 'paused';

  return (
    <div className="space-y-6">
      <section className={`${card} text-center`} aria-label="Round clock">
        <p className={`text-sm font-bold tracking-wide uppercase ${muted}`}>
          Round {game.currentRound} of {game.settings.totalRounds}
        </p>
        <p className="mt-1 font-mono text-6xl font-black tabular-nums" aria-live="off">
          {left === null ? '–:––' : formatClock(left)}
        </p>
        <p className={`mt-1 text-sm ${muted}`}>
          {paused ? 'Paused by the host. The clock is stopped.' : 'left in this round'}
        </p>
      </section>

      {me && (
        <section className={card} aria-labelledby="role-heading">
          <h3 id="role-heading" className="text-lg font-black">
            Your role: {roleLabel(definition, me.roleId)}
          </h3>
          <p className={`mt-1 text-sm ${muted}`}>
            {me.status === 'out'
              ? 'You are out for this round. You are back in next round.'
              : (roleDescription(definition, me.roleId) ?? '')}
          </p>

          {options.length > 0 && !paused && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={buttonPrimary}
                  onClick={() => {
                    session.act(option.intent);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {options.length === 0 && !paused && me.status === 'active' && (
            <p className="mt-3 font-semibold">Nothing to report right now. Go and play!</p>
          )}
        </section>
      )}

      {rules.length > 0 && (
        <section className={card} aria-labelledby="rules-heading">
          <h3 id="rules-heading" className="text-lg font-black">
            In force right now
          </h3>
          <ul className="mt-2 space-y-2" aria-live="polite">
            {rules.map((rule) => (
              <li key={rule.key} className="flex items-start justify-between gap-3">
                <span className="font-semibold">{rule.text}</span>
                <span className={`shrink-0 font-mono text-sm ${muted}`}>
                  {formatClock(rule.seconds)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Scores game={game} playerId={playerId} />
    </div>
  );
}

function Scores({ game, playerId }: { game: GameState; playerId: string | undefined }) {
  const definition = findGameDefinition(game.gameId);
  return (
    <section className={card} aria-labelledby="scores-heading">
      <h3 id="scores-heading" className="text-lg font-black">
        Scores
      </h3>
      <table className="mt-2 w-full text-left">
        <thead className={`text-sm ${muted}`}>
          <tr>
            <th scope="col" className="py-1 font-semibold">
              Player
            </th>
            <th scope="col" className="py-1 font-semibold">
              Role
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              Points
            </th>
          </tr>
        </thead>
        <tbody className="divide-moss-200 dark:divide-bark-700 divide-y">
          {scoreboard(game).map(({ player, winner }) => (
            <tr key={player.id}>
              <th scope="row" className="py-2 font-semibold">
                {player.displayName}
                {player.id === playerId && (
                  <span className={`ml-2 text-sm font-normal ${muted}`}>(you)</span>
                )}
                {winner && (
                  <span className="ml-2">
                    <Badge tone="warn">Winner</Badge>
                  </span>
                )}
              </th>
              <td className={`py-2 text-sm ${muted}`}>
                {roleLabel(definition, player.roleId)}
                {player.status === 'out' ? ' (out this round)' : ''}
              </td>
              <td className="py-2 text-right font-mono text-lg font-black tabular-nums">
                {player.score}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Results({ game }: { game: GameState }) {
  const winners = presentPlayers(game).filter((player) => game.winnerIds.includes(player.id));
  return (
    <div className="space-y-6">
      {game.status === 'completed' ? (
        <Notice tone="success" title="The game is over">
          {winners.length === 0
            ? 'Nobody won this one.'
            : winners.length === 1
              ? `${winners[0]?.displayName ?? 'Someone'} wins!`
              : `It is a tie between ${winners.map((player) => player.displayName).join(' and ')}.`}
        </Notice>
      ) : (
        <Notice title="The host stopped this game">It ended before the last round.</Notice>
      )}
      <Scores game={game} playerId={undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/play/${game.gameId}` as Route} className={buttonPrimary}>
          Play again
        </Link>
        <Link href="/games" className={linkStyle}>
          Choose another game
        </Link>
      </div>
    </div>
  );
}

function HostControls({ game, session }: { game: GameState; session: GameSessionView }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={card} aria-labelledby="host-heading">
      <h3 id="host-heading" className="text-lg font-black">
        Host controls
      </h3>
      <p className={`mt-1 text-sm ${muted}`}>Only you see these. They apply to everyone.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {game.status === 'active' && (
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => {
              session.hostCommand({ type: 'PAUSE_SESSION', reason: 'Paused by the host' });
            }}
          >
            Pause the game
          </button>
        )}
        {game.status === 'paused' && (
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              session.hostCommand({ type: 'RESUME_SESSION' });
            }}
          >
            Resume the game
          </button>
        )}
        {!confirming ? (
          <button
            type="button"
            className={buttonDanger}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Stop the game
          </button>
        ) : (
          <div
            className="flex flex-wrap items-center gap-3"
            role="group"
            aria-label="Stop the game?"
          >
            <span className="font-semibold">Stop the game for everyone?</span>
            <button
              type="button"
              className={buttonDanger}
              onClick={() => {
                session.hostCommand({ type: 'ABORT_SESSION', reason: 'Stopped by the host' });
                setConfirming(false);
              }}
            >
              Yes, stop it
            </button>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep playing
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Activity({ game }: { game: GameState }) {
  const items = recentActivity(game);
  if (items.length === 0) return null;
  return (
    <section className={card} aria-labelledby="activity-heading">
      <h3 id="activity-heading" className="text-lg font-black">
        What just happened
      </h3>
      <ol className="mt-2 space-y-1.5 text-sm">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-2">
            {item.fromGameMaster && <Badge tone="warn">Game Master</Badge>}
            <span>{item.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
