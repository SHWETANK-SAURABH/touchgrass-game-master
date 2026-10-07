import { type RawData, WebSocketServer } from 'ws';
import { type Clock, systemClock } from '@touchgrass/shared';
import { contextAt } from '@touchgrass/game-engine';
import type { GameSession } from '@touchgrass/game-session';
import { MAX_MESSAGE_BYTES } from './protocol';
import { type Room, type RoomConnection, createRoom } from './room';

/**
 * The WebSocket adapter.
 *
 * It turns sockets into the room's connections and frames into calls to the
 * room, and does nothing else. It holds no game logic and no table of games:
 * a server is built around the one GameSession it is given, and every socket
 * that connects is a connection to that game's room. There is no path, query
 * or message by which a client could choose a different one.
 *
 * This is where the time comes from. Each frame is stamped with the injected
 * clock as it arrives; the room, the session and the engine never read one.
 */

export interface RealtimeServerOptions {
  /** The one game this server is for. */
  readonly session: GameSession;
  /** The port to listen on. 0 picks a free one. */
  readonly port: number;
  /** Where the time comes from. Defaults to the system clock. */
  readonly clock?: Clock;
  readonly host?: string;
  /** Frames larger than this are refused and the socket is closed. */
  readonly maxMessageBytes?: number;
  /** Makes a new player id for a join. Defaults to a random one. */
  readonly createPlayerId?: () => string;
}

export interface RealtimeServer {
  /** The port actually bound. */
  readonly port: number;
  /** The room, for trusted server-side calls such as `tick`. */
  readonly room: Room;
  /** How many sockets are open, joined or not. */
  readonly socketCount: () => number;
  /** Closes every socket and stops listening. Resolves once the port is free. */
  readonly close: () => Promise<void>;
}

function textOf(data: RawData, isBinary: boolean): string | null {
  if (isBinary) return null;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Starts listening. Resolves once the port is bound. */
export function createRealtimeServer(options: RealtimeServerOptions): Promise<RealtimeServer> {
  const clock = options.clock ?? systemClock;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const room = createRoom({
    session: options.session,
    maxMessageBytes,
    ...(options.createPlayerId ? { createPlayerId: options.createPlayerId } : {}),
  });

  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
      // ws closes a socket that sends a larger frame, with status 1009.
      maxPayload: maxMessageBytes,
    });

    server.on('connection', (socket) => {
      const connection: RoomConnection = {
        send: (text) => {
          socket.send(text);
        },
        close: () => {
          socket.close();
        },
      };
      socket.on('message', (data, isBinary) => {
        room.receive(connection, textOf(data, isBinary), contextAt(clock));
      });
      socket.on('close', () => {
        room.disconnect(connection);
      });
      // An oversized or malformed frame arrives here; ws then closes the socket.
      socket.on('error', () => {
        room.disconnect(connection);
      });
    });

    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;

      resolve({
        port,
        room,
        socketCount: () => server.clients.size,
        close: async () => {
          // Wait for each socket to report closed, so nothing is left half open
          // when this resolves.
          const sockets = [...server.clients].map(
            (socket) =>
              new Promise<void>((done) => {
                socket.once('close', () => {
                  done();
                });
                socket.terminate();
              }),
          );
          const stopped = new Promise<void>((closed, failed) => {
            server.close((error) => {
              if (error) failed(error);
              else closed();
            });
          });
          await Promise.all([...sockets, stopped]);
        },
      });
    });
  });
}
