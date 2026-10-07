import { type Result, createPlayerId as mintPlayerId } from '@touchgrass/shared';
import type { EngineContext, EngineError, GameState, HistoryEntry } from '@touchgrass/game-engine';
import type { GameSession, SessionUpdate } from '@touchgrass/game-session';
import {
  MAX_MESSAGE_BYTES,
  type ServerMessage,
  type TransportErrorCode,
  encodeServerMessage,
  parseClientMessage,
  rejection,
} from './protocol';

/**
 * A room: the connections attached to one game.
 *
 *   incoming frame
 *     → envelope validation              protocol.ts
 *     → which player is this connection? the room's own table
 *     → GameSession                      the one authoritative state
 *     → update to every joined connection, or a refusal to the sender
 *
 * A room is given exactly one GameSession when it is made and never looks one
 * up. Nothing a client sends selects a game.
 *
 * Identity. A connection has no identity until it joins. On a join the room
 * makes up a new player id itself, asks the session to add that player, and
 * only if that succeeds records "this connection is that player". Every later
 * action from the connection is submitted as that player. A client never sends
 * a player id, and a message that contains one is not a valid envelope.
 *
 * That is not authentication. A connection is not a user: anyone who has the
 * join code can join, and nothing proves who they are. The id only means "the
 * same connection that joined".
 *
 * The table of connections lives here, in the room, and nowhere in GameState.
 * The game does not know sockets exist.
 *
 * Everything is synchronous. A frame is handled, the session is called, and the
 * resulting messages are handed to the connections before `receive` returns, so
 * frames are processed in the order they are given and updates go out in the
 * order the game changed.
 *
 * The room has no clock and no timer. The caller passes the time with each
 * frame and with `tick`.
 */

/** The little a room needs from a connection. A WebSocket is adapted to this. */
export interface RoomConnection {
  /** Sends one text message. */
  send(text: string): void;
  close(): void;
}

export interface Room {
  /**
   * Handles one frame from a connection. `raw` is untrusted: whatever arrived.
   * A connection needs no registration; one that has not joined is simply not
   * in the room yet.
   */
  readonly receive: (connection: RoomConnection, raw: unknown, ctx: EngineContext) => void;

  /**
   * Forgets a connection. The player it was stays in the game: no command is
   * issued, and nothing can act as that player afterwards.
   */
  readonly disconnect: (connection: RoomConnection) => void;

  /**
   * Brings the game up to `ctx.now` and, if that changed it, tells every joined
   * connection. Trusted callers only: it is not reachable from a client message.
   * Nothing calls it automatically.
   */
  readonly tick: (ctx: EngineContext) => Result<SessionUpdate, EngineError>;

  /** The player a connection joined as, if it has. */
  readonly playerIdOf: (connection: RoomConnection) => string | undefined;

  /** How many connections are currently joined. */
  readonly connectionCount: () => number;
}

export interface RoomOptions {
  /** The one game this room is for. */
  readonly session: GameSession;
  /** Makes a new player id for a join. Defaults to a random one. */
  readonly createPlayerId?: () => string;
  readonly maxMessageBytes?: number;
}

export function createRoom(options: RoomOptions): Room {
  const { session } = options;
  const createPlayerId = options.createPlayerId ?? mintPlayerId;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;

  /** Which player each joined connection is. Insertion order is join order. */
  const players = new Map<RoomConnection, string>();

  const send = (connection: RoomConnection, message: ServerMessage): void => {
    try {
      connection.send(encodeServerMessage(message));
    } catch {
      // A connection that cannot be written to is going away. Its own close
      // will remove it; one failed send must not stop the others.
    }
  };

  const fail = (connection: RoomConnection, code: TransportErrorCode): void => {
    send(connection, { type: 'error', code });
  };

  /** Sends the authoritative result of a change to every joined connection. */
  const broadcast = (
    state: GameState,
    entries: readonly HistoryEntry[],
    except?: RoomConnection,
  ): void => {
    const text = encodeServerMessage({ type: 'update', entries: [...entries], state });
    for (const connection of players.keys()) {
      if (connection === except) continue;
      try {
        connection.send(text);
      } catch {
        // As above.
      }
    }
  };

  const join = (
    connection: RoomConnection,
    message: { joinCode: string; displayName: string },
    ctx: EngineContext,
  ): void => {
    if (players.has(connection)) return fail(connection, 'ALREADY_JOINED');
    if (message.joinCode !== session.getState().joinCode) {
      return fail(connection, 'WRONG_JOIN_CODE');
    }

    // The id is made here. Adding a player is a host command; this is the one
    // use of it a client can cause, and only for itself.
    const playerId = createPlayerId();
    const added = session.applyCommand(
      { type: 'ADD_PLAYER', playerId, displayName: message.displayName },
      ctx,
    );
    if (!added.ok) return send(connection, rejection(added.error));

    players.set(connection, playerId);
    send(connection, { type: 'joined', playerId, state: added.value.state });
    broadcast(added.value.state, added.value.entries, connection);
  };

  const act = (connection: RoomConnection, intent: unknown, ctx: EngineContext): void => {
    const playerId = players.get(connection);
    if (playerId === undefined) return fail(connection, 'NOT_JOINED');

    const outcome = session.submitAction(playerId, intent, ctx);
    if (!outcome.ok) return send(connection, rejection(outcome.error));
    broadcast(outcome.value.state, outcome.value.entries);
  };

  return {
    receive(connection, raw, ctx) {
      const message = parseClientMessage(raw, maxMessageBytes);
      if (!message.ok) return fail(connection, message.error);
      switch (message.value.type) {
        case 'join':
          return join(connection, message.value, ctx);
        case 'action':
          return act(connection, message.value.intent, ctx);
      }
    },

    disconnect(connection) {
      players.delete(connection);
    },

    tick(ctx) {
      const before = session.getState();
      const update = session.advanceTime(ctx);
      if (update.ok && update.value.state !== before) {
        broadcast(update.value.state, update.value.entries);
      }
      return update;
    },

    playerIdOf: (connection) => players.get(connection),

    connectionCount: () => players.size,
  };
}
