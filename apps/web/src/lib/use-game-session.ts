'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState } from '@touchgrass/game-engine';
import { messageFor } from './session-view';

/**
 * One browser's connection to one game.
 *
 * It finds out where the game server is, opens a WebSocket to the game's own
 * address, and speaks the existing protocol: join, resume, action, leave,
 * host_auth, host_command. It holds no rule of any game. What it shows is the
 * state the server last sent, and everything a player does is a message the
 * server may refuse.
 *
 * A player's token and the host token are kept in this tab's session storage,
 * so reloading the page, or losing signal and coming back, resumes the same
 * player. They are never put in a URL.
 */

export type Connection =
  /** Finding the game server, or opening the socket. */
  | { readonly phase: 'connecting' }
  /** Connected, and this browser is not a player yet. */
  | { readonly phase: 'needs-join' }
  /** Connected as a player, the host, or both. */
  | { readonly phase: 'ready' }
  /** The connection dropped and is being opened again. */
  | { readonly phase: 'reconnecting' }
  /** It cannot continue. `code` says why. */
  | { readonly phase: 'stopped'; readonly code: string };

export interface GameSessionView {
  readonly connection: Connection;
  /** The game as the server last sent it. */
  readonly game: GameState | undefined;
  readonly playerId: string | undefined;
  readonly isHost: boolean;
  /** The latest thing the server refused, in plain words. */
  readonly notice: string | undefined;
  readonly dismissNotice: () => void;
  readonly join: (displayName: string, joinCode: string) => void;
  readonly act: (intent: Record<string, unknown>) => void;
  readonly hostCommand: (command: Record<string, unknown>) => void;
  readonly leave: () => void;
  readonly retry: () => void;
}

interface ServerMessage {
  readonly type: string;
  readonly code?: string;
  readonly playerId?: string;
  readonly token?: string;
  readonly state?: GameState;
  readonly error?: { readonly code: string };
}

const playerKey = (sessionId: string): string => `touchgrass:player:${sessionId}`;
const hostKey = (sessionId: string): string => `touchgrass:host:${sessionId}`;

/** Session storage, which may be unavailable. A missing value is simply absent. */
const stored = {
  get(key: string): string | undefined {
    try {
      return window.sessionStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string): void {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Without storage the game still works until the page is reloaded.
    }
  },
  remove(key: string): void {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Nothing to remove.
    }
  },
};

/** Keeps the host token for a game this browser has just created. */
export function rememberHostToken(sessionId: string, hostToken: string): void {
  stored.set(hostKey(sessionId), hostToken);
}

/** Codes after which trying again cannot help. */
const FINAL = new Set(['SESSION_NOT_FOUND', 'INVALID_SESSION_PATH', 'CONNECTION_REPLACED']);
const MAX_ATTEMPTS = 6;

export function useGameSession(sessionId: string): GameSessionView {
  const [connection, setConnection] = useState<Connection>({ phase: 'connecting' });
  const [game, setGame] = useState<GameState | undefined>(undefined);
  const [playerId, setPlayerId] = useState<string | undefined>(undefined);
  const [isHost, setIsHost] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /** Changing this opens a new socket. */
  const [generation, setGeneration] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  /** How many times in a row the connection has dropped. */
  const attemptRef = useRef(0);

  const send = useCallback((message: Record<string, unknown>): void => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else setNotice('You are not connected right now. Trying to reconnect…');
  }, []);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled: ReturnType<typeof setTimeout> | undefined;
    /** Why the socket is closing, when the server has said. */
    let finalCode: string | undefined;
    /** Which token each pending answer is about, in the order they were sent. */
    const awaiting: ('host' | 'player')[] = [];

    const stop = (code: string): void => {
      finalCode = code;
      if (!cancelled) setConnection({ phase: 'stopped', code });
    };

    const open = async (): Promise<void> => {
      let wsUrl: string;
      try {
        const response = await fetch('/api/play', { cache: 'no-store' });
        const config = (await response.json()) as {
          enabled: boolean;
          wsUrl?: string;
          reason?: string;
        };
        if (cancelled) return;
        if (!config.enabled || !config.wsUrl) return stop(config.reason ?? 'SERVER_UNAVAILABLE');
        wsUrl = config.wsUrl;
      } catch {
        if (!cancelled) stop('SITE_UNREACHABLE');
        return;
      }

      socket = new WebSocket(`${wsUrl}/sessions/${encodeURIComponent(sessionId)}`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled) return;
        // A connection that stays up for a while is a fresh start for the next drop.
        settled = setTimeout(() => {
          attemptRef.current = 0;
        }, 15_000);
        const hostToken = stored.get(hostKey(sessionId));
        const playerToken = stored.get(playerKey(sessionId));
        if (hostToken) {
          awaiting.push('host');
          socket?.send(JSON.stringify({ type: 'host_auth', token: hostToken }));
        }
        if (playerToken) {
          awaiting.push('player');
          socket?.send(JSON.stringify({ type: 'resume', token: playerToken }));
        } else {
          setConnection({ phase: 'needs-join' });
        }
      });

      socket.addEventListener('message', (event) => {
        if (cancelled) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.state) setGame(message.state);

        if (message.type === 'joined' && message.playerId) {
          if (message.token) stored.set(playerKey(sessionId), message.token);
          else if (awaiting.includes('player')) awaiting.splice(awaiting.indexOf('player'), 1);
          setPlayerId(message.playerId);
          setConnection({ phase: 'ready' });
          setNotice(undefined);
          return;
        }
        if (message.type === 'host_authorized') {
          if (awaiting.includes('host')) awaiting.splice(awaiting.indexOf('host'), 1);
          setIsHost(true);
          return;
        }
        if (message.type === 'rejected') {
          setNotice(messageFor(message.error?.code));
          return;
        }
        if (message.type === 'error' && message.code) {
          if (FINAL.has(message.code)) return stop(message.code);
          if (message.code === 'SESSION_CLOSED' || message.code === 'SESSION_UNAVAILABLE') {
            // The server closed this game's room, or could not open it. The
            // socket is about to close; the reconnect below tries again.
            return;
          }
          if (message.code === 'INVALID_TOKEN' || message.code === 'HOST_ALREADY_CONNECTED') {
            // A stored token did not work. Forget it, and carry on without it.
            const which = awaiting.shift();
            if (which === 'host') {
              if (message.code === 'INVALID_TOKEN') stored.remove(hostKey(sessionId));
              else setNotice(messageFor(message.code));
              return;
            }
            if (which === 'player') {
              stored.remove(playerKey(sessionId));
              setPlayerId(undefined);
              setConnection({ phase: 'needs-join' });
              return;
            }
          }
          setNotice(messageFor(message.code));
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled || finalCode) return;
        socketRef.current = null;
        clearTimeout(settled);
        setIsHost(false);
        attemptRef.current += 1;
        if (attemptRef.current >= MAX_ATTEMPTS) return stop('CONNECTION_LOST');
        setConnection({ phase: 'reconnecting' });
        // Wait a little longer each time, up to eight seconds.
        timer = setTimeout(
          () => {
            setGeneration((current) => current + 1);
          },
          Math.min(8_000, 500 * 2 ** (attemptRef.current - 1)),
        );
      });
    };

    void open();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(settled);
      socketRef.current = null;
      socket?.close();
    };
  }, [sessionId, generation]);

  return {
    connection,
    game,
    playerId,
    isHost,
    notice,
    dismissNotice: useCallback(() => {
      setNotice(undefined);
    }, []),
    join: useCallback(
      (displayName: string, joinCode: string) => {
        send({ type: 'join', displayName: displayName.trim(), joinCode: joinCode.trim() });
      },
      [send],
    ),
    act: useCallback(
      (intent: Record<string, unknown>) => {
        send({ type: 'action', intent });
      },
      [send],
    ),
    hostCommand: useCallback(
      (command: Record<string, unknown>) => {
        send({ type: 'host_command', command });
      },
      [send],
    ),
    leave: useCallback(() => {
      // Only offered before the game starts, which is when the server allows it.
      send({ type: 'leave' });
      stored.remove(playerKey(sessionId));
      setPlayerId(undefined);
      setConnection({ phase: 'needs-join' });
    }, [send, sessionId]),
    retry: useCallback(() => {
      attemptRef.current = 0;
      setConnection({ phase: 'connecting' });
      setGeneration((current) => current + 1);
    }, []),
  };
}
