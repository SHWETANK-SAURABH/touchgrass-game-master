'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { rememberHostToken } from '@/lib/use-game-session';
import { Loading, Notice, buttonPrimary, buttonSecondary, linkStyle } from './ui';

/**
 * Creates a game and takes its creator to it.
 *
 * It first asks the site whether playing is available at all, so that someone
 * is not shown a button that cannot work. The game is created on the game
 * server; this browser is given the host token for it and keeps it for this tab.
 */

type Availability =
  { phase: 'checking' } | { phase: 'available' } | { phase: 'unavailable'; reason: string };

const UNAVAILABLE: Record<string, { title: string; body: string }> = {
  NOT_CONFIGURED: {
    title: 'Playing is not set up on this site yet',
    body: 'This copy of the site has not been connected to a game server. If you run it yourself, the README shows how to start one and point the site at it.',
  },
  SERVER_UNAVAILABLE: {
    title: 'The game server is not answering',
    body: 'Games cannot be started right now. It may be starting up or offline. Try again in a moment.',
  },
};

const CREATE_FAILED: Record<string, string> = {
  GAME_NOT_PLAYABLE: 'This game cannot be played here yet.',
  NOT_CONFIGURED: 'Playing is not set up on this site yet.',
  SERVER_UNAVAILABLE: 'The game server is not answering. Try again in a moment.',
  NOT_CREATED: 'The game could not be created. Please try again.',
};

export function StartGame({ gameId, gameName }: { gameId: string; gameName: string }) {
  const router = useRouter();
  const [availability, setAvailability] = useState<Availability>({ phase: 'checking' });
  const [check, setCheck] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/play', { cache: 'no-store' });
        const config = (await response.json()) as { enabled: boolean; reason?: string };
        if (cancelled) return;
        setAvailability(
          config.enabled
            ? { phase: 'available' }
            : { phase: 'unavailable', reason: config.reason ?? 'SERVER_UNAVAILABLE' },
        );
      } catch {
        if (!cancelled) setAvailability({ phase: 'unavailable', reason: 'SERVER_UNAVAILABLE' });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [check]);

  const create = async (): Promise<void> => {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const body = (await response.json()) as {
        sessionId?: string;
        joinCode?: string;
        hostToken?: string;
        error?: string;
      };
      if (!response.ok || !body.sessionId || !body.joinCode || !body.hostToken) {
        setError(CREATE_FAILED[body.error ?? ''] ?? CREATE_FAILED.NOT_CREATED);
        setCreating(false);
        return;
      }
      rememberHostToken(body.sessionId, body.hostToken);
      router.push(
        `/session/${encodeURIComponent(body.sessionId)}?code=${encodeURIComponent(body.joinCode)}` as Route,
      );
    } catch {
      setError('The site could not be reached. Check your connection and try again.');
      setCreating(false);
    }
  };

  if (availability.phase === 'checking')
    return <Loading>Checking that games can be started…</Loading>;

  if (availability.phase === 'unavailable') {
    const message = UNAVAILABLE[availability.reason] ?? UNAVAILABLE.SERVER_UNAVAILABLE;
    return (
      <Notice
        tone="error"
        title={message?.title ?? 'Games cannot be started right now'}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                setAvailability({ phase: 'checking' });
                setCheck((current) => current + 1);
              }}
            >
              Check again
            </button>
            <Link href="/games" className={linkStyle}>
              Back to all games
            </Link>
          </div>
        }
      >
        {message?.body}
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <Notice tone="error" title="That did not work">
          {error}
        </Notice>
      )}
      <button
        type="button"
        className={`${buttonPrimary} w-full sm:w-auto`}
        disabled={creating}
        onClick={() => {
          void create();
        }}
      >
        {creating ? 'Creating your game…' : `Create a game of ${gameName}`}
      </button>
    </div>
  );
}
