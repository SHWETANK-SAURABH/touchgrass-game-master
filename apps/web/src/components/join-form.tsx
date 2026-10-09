'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sessionIdFrom } from '@/lib/session-view';
import { Notice, buttonPrimary, input, label, muted } from './ui';

/**
 * Takes someone to a game they were invited to. They paste the link the host
 * shared, or type the game's id; the join code is asked for on the game's own
 * page, where it is checked by the server.
 */
export function JoinForm() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const found = sessionIdFrom(value);
        if (!found) {
          setError('Paste the link the host sent you, or type the game ID exactly as shown.');
          return;
        }
        const query = found.code ? `?code=${encodeURIComponent(found.code)}` : '';
        router.push(`/session/${encodeURIComponent(found.sessionId)}${query}` as Route);
      }}
    >
      <div>
        <label htmlFor="join-link" className={label}>
          Game link or game ID
        </label>
        <input
          id="join-link"
          name="link"
          className={input}
          value={value}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="join-link-help"
          aria-invalid={error ? true : undefined}
          placeholder="Paste the link from your host"
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
        />
        <p id="join-link-help" className={`mt-1.5 text-sm ${muted}`}>
          The host sees a link and a join code as soon as they create a game.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" className={`${buttonPrimary} w-full sm:w-auto`}>
        Find the game
      </button>
    </form>
  );
}
