import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type Result, createPlayerId as mintPlayerId, err, ok } from '@touchgrass/shared';
import {
  type EngineContext,
  type EngineError,
  type GameState,
  type HistoryEntry,
  type ValidatedGameEvent,
  engineError,
} from '@touchgrass/game-engine';
import type { GameSession, SessionUpdate } from '@touchgrass/game-session';
import {
  type HostCommand,
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
 *     → who is this connection?          the room's own tables
 *     → GameSession                      the one authoritative state
 *     → update to everyone in the room, or a refusal to the sender
 *
 * A room is given exactly one GameSession when it is made and never looks one
 * up. Nothing a client sends selects a game.
 *
 * Three kinds of caller reach a room, and they are kept apart:
 *
 *   a player        a connection bound to a player id. It may act, and leave.
 *   the host        the one connection that presented the host token. It may
 *                   send four commands: pause, resume, abort, remove a player.
 *   server code     whatever holds this object. It may call `tick`.
 *
 * Capabilities. The room hands out two kinds of random secret:
 *
 *   a player token  made at a join, sent once to the joiner. A later connection
 *                   that presents it becomes that same player.
 *   the host token  made when the game is created and given to its creator.
 *
 * They are bearer capabilities, not authentication. Whoever holds a player
 * token is that player; whoever holds the host token is the host. Nothing
 * proves who a person is. The tokens, and the tables of which connection is
 * whom, live here in memory. They are never part of GameState, never sent in an
 * update, and gone when the process stops.
 *
 * Everything is synchronous. A frame is handled, the session is called, and the
 * resulting messages are handed to the connections before `receive` returns, so
 * frames are processed in the order they are given and updates go out in the
 * order the game changed.
 *
 * The room has no clock and no timer. The caller passes the time with each
 * frame and with `tick`.
 *
 * A room can be closed, once and for good. Closing it tells every connection it
 * knows of, closes them, and forgets every binding and token. After that it
 * changes nothing: a frame is answered with SESSION_CLOSED and its connection
 * closed, and `tick` does nothing. Another room is not affected in any way.
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
   * Tells the room a connection exists before it has sent anything, so that
   * closing the room closes it too. `receive` does the same for a connection
   * the room has not seen. It returns false, and keeps nothing, if the room is
   * closed.
   */
  readonly attach: (connection: RoomConnection) => boolean;

  /**
   * Forgets a connection: who it was, and that it was the host if it was. The
   * player stays in the game and their token stays valid, so they can resume.
   * The game is not paused or stopped, and nobody is told.
   */
  readonly disconnect: (connection: RoomConnection) => void;

  /**
   * Brings the game up to `ctx.now` and, if that changed it, tells everyone in
   * the room. Trusted callers only: it is not reachable from a client message.
   * Nothing calls it automatically.
   */
  readonly tick: (ctx: EngineContext) => Result<SessionUpdate, EngineError>;

  /**
   * Has the game apply an external event the engine has validated, and tells
   * everyone in the room the result, as for any other change. Trusted callers
   * only: it is not reachable from a client message, and nothing calls it
   * automatically. The room does not judge the event; the session and the
   * engine do. A closed room refuses and changes nothing.
   */
  readonly applyEvent: (
    validated: ValidatedGameEvent,
    ctx: EngineContext,
  ) => Result<SessionUpdate, EngineError>;

  /** The player a connection currently is, if any. */
  readonly playerIdOf: (connection: RoomConnection) => string | undefined;

  /** Whether a connection is currently the host. */
  readonly isHost: (connection: RoomConnection) => boolean;

  /** How many connections are currently bound to a player. */
  readonly connectionCount: () => number;

  /**
   * Closes the room for good. Every connection it knows of, joined or not, is
   * sent SESSION_CLOSED and closed; every binding and token is forgotten.
   * Calling it again does nothing. The game itself is not touched.
   */
  readonly close: () => void;

  /** Whether `close` has been called. */
  readonly isClosed: () => boolean;
}

export interface RoomOptions {
  /** The one game this room is for. */
  readonly session: GameSession;
  /**
   * The secret that makes a connection the host. A room made without one has no
   * host: no connection can send host commands.
   */
  readonly hostToken?: string;
  /** Makes a new player id for a join. Defaults to a random one. */
  readonly createPlayerId?: () => string;
  /** Makes a new player token. Defaults to 32 random bytes. */
  readonly createToken?: () => string;
  /**
   * Makes the token of a given player, the same one every time it is asked.
   *
   * With this, a player's token does not depend on this room having been the
   * one they joined through: every player the game has, and has not lost, can
   * resume with their token, including in a room made later around the same
   * game restored. `createToken` is then not used for players.
   *
   * It must be unguessable, and different for every player and every game.
   */
  readonly playerToken?: (playerId: string) => string;
  /**
   * Told how many connections the room knows of, joined or not, each time that
   * number changes because one arrived or went away. It is not called when the
   * room is closed. The room does nothing with the answer and passes no time:
   * whoever listens decides what an empty room means.
   */
  readonly onConnections?: (count: number) => void;
  /**
   * Told each authoritative change the room is about to broadcast: the entries
   * the change added and the state after it. It is the same thing the
   * connections are sent, and it is told once per change whether or not anyone
   * is connected. A listener cannot alter it, and one that throws is ignored.
   */
  readonly onUpdate?: (update: SessionUpdate) => void;
  readonly maxMessageBytes?: number;
}

/** A new unguessable token: 32 random bytes, 43 characters. */
export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRoom(options: RoomOptions): Room {
  const { session, hostToken } = options;
  const createPlayerId = options.createPlayerId ?? mintPlayerId;
  const mintToken = options.createToken ?? createToken;
  const playerToken = options.playerToken;
  const onUpdate = options.onUpdate;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;

  /** Which player each bound connection is. */
  const playerOf = new Map<RoomConnection, string>();
  /** The one connection each player has, if they have one. */
  const connectionOf = new Map<string, RoomConnection>();
  /** Which player each outstanding player token is for. */
  const playerForToken = new Map<string, string>();
  /** The connection that presented the host token, if one has. */
  let hostConnection: RoomConnection | undefined;
  /** Every connection the room knows of, whether or not it is anyone yet. */
  const attached = new Set<RoomConnection>();
  let closed = false;

  const counted = (): void => {
    try {
      options.onConnections?.(attached.size);
    } catch {
      // A listener that fails must not stop the room handling the connection.
    }
  };
  const know = (connection: RoomConnection): void => {
    if (attached.has(connection)) return;
    attached.add(connection);
    counted();
  };
  const unknow = (connection: RoomConnection): void => {
    if (attached.delete(connection)) counted();
  };

  const write = (connection: RoomConnection, text: string): void => {
    try {
      connection.send(text);
    } catch {
      // A connection that cannot be written to is going away. Its own close
      // will remove it; one failed send must not stop the others.
    }
  };

  const send = (connection: RoomConnection, message: ServerMessage): void => {
    write(connection, encodeServerMessage(message));
  };

  const fail = (connection: RoomConnection, code: TransportErrorCode): void => {
    send(connection, { type: 'error', code });
  };

  /** A player who has left has no token and no connection bound to them. */
  const retire = (playerId: string): void => {
    for (const [token, owner] of playerForToken) {
      if (owner === playerId) playerForToken.delete(token);
    }
    const connection = connectionOf.get(playerId);
    if (connection) {
      playerOf.delete(connection);
      connectionOf.delete(playerId);
    }
  };

  /**
   * Brings the room's tables into line with the game.
   *
   * The session can be changed by trusted server code that does not go through
   * this room, for example by removing a player directly. The room is not told.
   * So whenever it is about to act for a connection or deliver an update, it
   * checks its tables against the authoritative state: a player who is no
   * longer in the game, or has left, loses their token and their binding.
   *
   * It runs only at those two moments. Nothing watches the session.
   */
  const reconcile = (state: GameState): void => {
    const present = new Set(
      state.players.filter((player) => player.status !== 'left').map((player) => player.id),
    );
    const known = new Set([...connectionOf.keys(), ...playerForToken.values()]);
    for (const playerId of known) {
      if (!present.has(playerId)) retire(playerId);
    }
    // Tokens that can be made again are made for every player the game has, so
    // one who joined through an earlier room of this game can resume in this one.
    if (playerToken) {
      for (const playerId of present) {
        if (!known.has(playerId)) playerForToken.set(playerToken(playerId), playerId);
      }
    }
  };

  /**
   * Sends the authoritative result of a change to every bound connection and to
   * the host. The message is built from the session's result and nothing else.
   *
   * The tables are reconciled against the state being sent first, so a
   * connection whose player has gone is not told. `departing` is the one
   * exception: the connection of a player this room has just removed, which is
   * sent this last update about its own removal.
   */
  const broadcast = (
    state: GameState,
    entries: readonly HistoryEntry[],
    options: { except?: RoomConnection; departing?: RoomConnection | undefined } = {},
  ): void => {
    reconcile(state);
    try {
      onUpdate?.({ state, entries });
    } catch {
      // A listener that fails must not stop the room telling its connections.
    }
    const text = encodeServerMessage({ type: 'update', entries: [...entries], state });
    const recipients = new Set(playerOf.keys());
    if (hostConnection) recipients.add(hostConnection);
    if (options.departing) recipients.add(options.departing);
    for (const connection of recipients) {
      if (connection !== options.except) write(connection, text);
    }
  };

  const bind = (connection: RoomConnection, playerId: string): void => {
    playerOf.set(connection, playerId);
    connectionOf.set(playerId, connection);
  };

  /** Everything `disconnect` does. Tokens are untouched. */
  const forget = (connection: RoomConnection): void => {
    const playerId = playerOf.get(connection);
    if (playerId !== undefined && connectionOf.get(playerId) === connection) {
      connectionOf.delete(playerId);
    }
    playerOf.delete(connection);
    if (hostConnection === connection) hostConnection = undefined;
  };

  /** Tells a connection the room is closed, and closes it. */
  const turnAway = (connection: RoomConnection): void => {
    fail(connection, 'SESSION_CLOSED');
    try {
      connection.close();
    } catch {
      // It is going away either way.
    }
  };

  const join = (
    connection: RoomConnection,
    message: { joinCode: string; displayName: string },
    ctx: EngineContext,
  ): void => {
    if (playerOf.has(connection)) return fail(connection, 'ALREADY_JOINED');
    if (message.joinCode !== session.getState().joinCode) {
      return fail(connection, 'WRONG_JOIN_CODE');
    }

    // The id is made here. Adding a player is a host command; this is the one
    // use of it a player can cause, and only for itself.
    const playerId = createPlayerId();
    const added = session.applyCommand(
      { type: 'ADD_PLAYER', playerId, displayName: message.displayName },
      ctx,
    );
    if (!added.ok) return send(connection, rejection(added.error));

    const token = playerToken ? playerToken(playerId) : mintToken();
    playerForToken.set(token, playerId);
    bind(connection, playerId);
    // The only time the token is ever sent, and only to the connection it is for.
    send(connection, { type: 'joined', playerId, token, state: added.value.state });
    broadcast(added.value.state, added.value.entries, { except: connection });
  };

  const resume = (connection: RoomConnection, token: string): void => {
    if (playerOf.has(connection)) return fail(connection, 'ALREADY_JOINED');

    const playerId = playerForToken.get(token);
    const state = session.getState();
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (playerId === undefined || !player || player.status === 'left') {
      return fail(connection, 'INVALID_TOKEN');
    }

    // One connection per player. The earlier one is forgotten before the new one
    // is bound, so there is no moment at which both can act.
    const previous = connectionOf.get(playerId);
    if (previous) {
      forget(previous);
      unknow(previous);
      // Told why, then closed. It is nobody from here on: anything it still
      // sends comes from a connection that has not joined.
      fail(previous, 'CONNECTION_REPLACED');
      previous.close();
    }
    bind(connection, playerId);
    // No token in this reply, and nobody else is told: the game did not change.
    send(connection, { type: 'joined', playerId, state });
  };

  const act = (connection: RoomConnection, intent: unknown, ctx: EngineContext): void => {
    const playerId = playerOf.get(connection);
    if (playerId === undefined) return fail(connection, 'NOT_JOINED');

    const outcome = session.submitAction(playerId, intent, ctx);
    if (!outcome.ok) return send(connection, rejection(outcome.error));
    broadcast(outcome.value.state, outcome.value.entries);
  };

  const leave = (connection: RoomConnection, ctx: EngineContext): void => {
    const playerId = playerOf.get(connection);
    if (playerId === undefined) return fail(connection, 'NOT_JOINED');
    // A transport rule, not an engine one. The engine can remove a player at any
    // time, but a game that loses its tagger or seeker mid-round is not handled,
    // so a player may only take themselves out before it starts.
    if (session.getState().status !== 'lobby') return fail(connection, 'CANNOT_LEAVE');

    const removed = session.applyCommand({ type: 'REMOVE_PLAYER', playerId }, ctx);
    if (!removed.ok) return send(connection, rejection(removed.error));

    // Forgotten at once, and told along with everyone else.
    retire(playerId);
    broadcast(removed.value.state, removed.value.entries, { departing: connection });
  };

  const authoriseHost = (connection: RoomConnection, token: string): void => {
    if (hostToken === undefined || !sameSecret(token, hostToken)) {
      return fail(connection, 'INVALID_TOKEN');
    }
    // The host role is not handed over silently. While one connection holds it,
    // another with the same token is refused.
    if (hostConnection && hostConnection !== connection) {
      return fail(connection, 'HOST_ALREADY_CONNECTED');
    }
    hostConnection = connection;
    send(connection, { type: 'host_authorized', state: session.getState() });
  };

  const command = (connection: RoomConnection, input: HostCommand, ctx: EngineContext): void => {
    if (hostConnection !== connection) return fail(connection, 'NOT_HOST');

    const applied = session.applyCommand(input, ctx);
    if (!applied.ok) return send(connection, rejection(applied.error));

    // A removed player stops being a connection of this room at once and can no
    // longer resume. Their connection is told with everyone else.
    const departing = input.type === 'REMOVE_PLAYER' ? connectionOf.get(input.playerId) : undefined;
    if (input.type === 'REMOVE_PLAYER') retire(input.playerId);
    broadcast(applied.value.state, applied.value.entries, { departing });
  };

  return {
    receive(connection, raw, ctx) {
      // A closed room reads nothing and changes nothing.
      if (closed) return turnAway(connection);
      know(connection);
      const message = parseClientMessage(raw, maxMessageBytes);
      if (!message.ok) return fail(connection, message.error);
      // Before deciding who this connection is, drop any binding or token whose
      // player the game no longer has.
      reconcile(session.getState());
      switch (message.value.type) {
        case 'join':
          return join(connection, message.value, ctx);
        case 'resume':
          return resume(connection, message.value.token);
        case 'action':
          return act(connection, message.value.intent, ctx);
        case 'leave':
          return leave(connection, ctx);
        case 'host_auth':
          return authoriseHost(connection, message.value.token);
        case 'host_command':
          return command(connection, message.value.command, ctx);
      }
    },

    attach(connection) {
      if (closed) return false;
      know(connection);
      return true;
    },

    disconnect(connection) {
      forget(connection);
      unknow(connection);
    },

    tick(ctx) {
      // A closed room no longer moves its game on. The state is reported as it is.
      if (closed) return ok({ state: session.getState(), entries: [] });
      const before = session.getState();
      const update = session.advanceTime(ctx);
      if (update.ok && update.value.state !== before) {
        broadcast(update.value.state, update.value.entries);
      }
      return update;
    },

    applyEvent(validated, ctx) {
      if (closed) {
        return err(engineError('INVALID_STATE_TRANSITION', 'The room is closed.'));
      }
      const update = session.applyEvent(validated, ctx);
      if (update.ok) broadcast(update.value.state, update.value.entries);
      return update;
    },

    playerIdOf: (connection) => playerOf.get(connection),

    isHost: (connection) => hostConnection === connection,

    connectionCount: () => playerOf.size,

    close() {
      if (closed) return;
      closed = true;
      const everyone = [...attached];
      attached.clear();
      playerOf.clear();
      connectionOf.clear();
      playerForToken.clear();
      hostConnection = undefined;
      for (const connection of everyone) turnAway(connection);
    },

    isClosed: () => closed,
  };
}
