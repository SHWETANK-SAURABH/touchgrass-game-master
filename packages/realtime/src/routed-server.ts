import { WebSocketServer } from 'ws';
import { type Clock, systemClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import { MAX_MESSAGE_BYTES, type TransportErrorCode, encodeServerMessage } from './protocol';
import type { Room, RoomConnection } from './room';
import { stopListening, textOf } from './ws-server';

/**
 * The WebSocket adapter for many rooms behind one listener.
 *
 *   socket connects to  /sessions/<sessionId>
 *     → the session id is read from the address
 *     → `route` is asked for that session's room
 *     → the socket becomes a connection of that room, and of no other
 *
 * A socket is given its room once, when it connects, from the address it
 * connected to. Nothing it sends afterwards can change which room that is: no
 * message carries a session id, and the messages are exactly the ones a
 * single-room server accepts.
 *
 * The adapter keeps no table of rooms and does not know where they come from.
 * It asks `route` every time. Whoever supplies `route` decides which sessions
 * exist and owns their rooms.
 *
 * It fails closed. A socket whose address names no session, or whose session
 * cannot be found or made ready, is sent one error and closed. Until a socket
 * has its room, nothing it sends is read.
 *
 * As with the single-room adapter, the socket is plain `ws` and unencrypted,
 * and this is where the time comes from.
 */

/** Sessions are served under this path: `/sessions/<sessionId>`. */
export const SESSION_PATH_PREFIX = '/sessions/';

/** The longest session id an address may carry. */
const MAX_SESSION_ID_LENGTH = 200;

/** Why a socket was not given a room. */
export type RouteError = Extract<
  TransportErrorCode,
  'INVALID_SESSION_PATH' | 'SESSION_NOT_FOUND' | 'SESSION_UNAVAILABLE' | 'SESSION_CLOSED'
>;

/**
 * The session id in the address a socket connected to, or null if the address
 * is not exactly `/sessions/<sessionId>`. A query string is not part of the
 * address and is ignored.
 */
export function sessionIdFromPath(url: string | undefined): string | null {
  if (url === undefined) return null;
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  if (!path.startsWith(SESSION_PATH_PREFIX)) return null;
  const encoded = path.slice(SESSION_PATH_PREFIX.length);
  if (encoded === '' || encoded.includes('/')) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (sessionId.trim() === '' || sessionId.length > MAX_SESSION_ID_LENGTH) return null;
  return sessionId;
}

export interface RoutedRealtimeServerOptions {
  /**
   * Finds the room for a session id, or says why there is none. It may load the
   * session. If it throws or rejects, the socket is refused as
   * SESSION_UNAVAILABLE.
   */
  readonly route: (sessionId: string) => Promise<Room | RouteError> | Room | RouteError;
  /** The port to listen on. 0 picks a free one. */
  readonly port: number;
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  readonly host?: string;
  /** Frames larger than this are refused and the socket is closed. */
  readonly maxMessageBytes?: number;
  /**
   * Told when a socket connects, is given its room, is refused, and closes. It
   * is told the kind of thing that happened and, for a refusal, the code sent:
   * never an address or a session. A listener that throws is ignored.
   */
  readonly onSocket?: (event: {
    readonly type: 'opened' | 'attached' | 'refused' | 'closed';
    readonly code?: RouteError;
  }) => void;
  /**
   * Told what went wrong when the listener itself reports an error after it
   * started, or when `route` throws. A listener that throws is ignored.
   */
  readonly onError?: (error: unknown) => void;
}

export interface RoutedRealtimeServer {
  /** The port actually bound. */
  readonly port: number;
  /** How many sockets are open, with a room or not. */
  readonly socketCount: () => number;
  /** Closes every socket and stops listening. Resolves once the port is free. */
  readonly close: () => Promise<void>;
}

/** Starts listening. Resolves once the port is bound. */
export function createRoutedRealtimeServer(
  options: RoutedRealtimeServerOptions,
): Promise<RoutedRealtimeServer> {
  const clock = options.clock ?? systemClock;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;

  const tell = (type: 'opened' | 'attached' | 'refused' | 'closed', code?: RouteError): void => {
    try {
      options.onSocket?.({ type, ...(code ? { code } : {}) });
    } catch {
      // Being told is a courtesy.
    }
  };
  const failed = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Being told is a courtesy.
    }
  };

  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
      // ws closes a socket that sends a larger frame, with status 1009.
      maxPayload: maxMessageBytes,
    });

    server.on('connection', (socket, request) => {
      /** The room this socket belongs to, once it has one. */
      let room: Room | undefined;
      let gone = false;
      tell('opened');
      const connection: RoomConnection = {
        send: (text) => {
          socket.send(text);
        },
        close: () => {
          socket.close();
        },
      };

      const refuse = (code: RouteError): void => {
        if (gone) return;
        tell('refused', code);
        try {
          socket.send(encodeServerMessage({ type: 'error', code }));
        } catch {
          // It is being closed either way.
        }
        socket.close();
        // A paused socket cannot finish closing. Whatever it had sent is let
        // through now and dropped: it has no room, so nothing reads it.
        socket.resume();
      };

      const leave = (): void => {
        if (!gone) tell('closed');
        gone = true;
        room?.disconnect(connection);
        room = undefined;
      };
      socket.on('close', leave);
      // An oversized or malformed frame arrives here; ws then closes the socket.
      socket.on('error', leave);
      socket.on('message', (data, isBinary) => {
        // Nothing is read before the socket has its room: it is paused until then.
        room?.receive(connection, textOf(data, isBinary), contextAt(clock));
      });

      const sessionId = sessionIdFromPath(request.url);
      if (sessionId === null) return refuse('INVALID_SESSION_PATH');

      // Frames wait, unread and in order, while the room is found.
      socket.pause();
      void Promise.resolve()
        .then(() => options.route(sessionId))
        .catch((error: unknown): RouteError => {
          failed(error);
          return 'SESSION_UNAVAILABLE';
        })
        .then((found) => {
          // The socket went away while its room was being found: nothing to attach.
          if (gone) return;
          if (typeof found === 'string') return refuse(found);
          // The room was closed between being found and now.
          if (!found.attach(connection)) return refuse('SESSION_CLOSED');
          room = found;
          tell('attached');
          socket.resume();
        });
    });

    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      // From here an error of the listener has nobody waiting for it. It is
      // handed to whoever monitors errors instead of going unobserved.
      server.on('error', failed);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        port,
        socketCount: () => server.clients.size,
        close: () => stopListening(server),
      });
    });
  });
}
