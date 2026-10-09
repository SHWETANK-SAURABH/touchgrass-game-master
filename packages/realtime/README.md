# @touchgrass/realtime

The WebSocket transport: a room around one game session, and listeners that put sockets in rooms.

It connects sockets to a `GameSession` (`@touchgrass/game-session`): it reads a client's message,
works out who that connection is, hands the request to the session, and sends the authoritative
result to everyone in the game. It holds no game rules and no game state.

There are two listeners. `createRealtimeServer` serves one room, for development.
`createRoutedRealtimeServer` serves many rooms from one port, choosing by the address a socket
connects to; the production game server is built on it (see
[Many rooms behind one listener](#many-rooms-behind-one-listener)).

**It authenticates nobody.** It uses bearer tokens over an unencrypted socket, and expects TLS to
be ended by a reverse proxy. See [Security limits](#security-limits) and
[What it is not](#what-it-is-not).

```ts
import { createHostedGame, createRealtimeServer } from '@touchgrass/realtime';

const game = createHostedGame(createCommand, ctx); // session + room + host token
if (!game.ok) return game.error;

const server = await createRealtimeServer({ room: game.value.room, port: 3001 });
game.value.hostToken; // give this to whoever should control the game

server.room.tick(ctx); // trusted, server side: advance time and broadcast
await server.close();
```

## Trying it locally

`npm run realtime:dev` starts one server around one new game and prints its join code and host
token.

```
TouchGrass realtime (development) listening on ws://localhost:3001
Game: tag   Join code: VNM2FN
Host token: …
```

`REALTIME_PORT` and `REALTIME_GAME` change the port and the game. Stop it with Ctrl+C; the game and
every token are gone.

## Modules

| Module             | Does                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `protocol.ts`      | The message envelopes and `parseClientMessage`. Knows messages, not games         |
| `room.ts`          | `createRoom`: connections, players, tokens, the host role, broadcast, `tick`      |
| `hosted-game.ts`   | `createHostedGame`: makes a session, its room and its host token together         |
| `ws-server.ts`     | `createRealtimeServer`: a thin `ws` adapter around one room                       |
| `routed-server.ts` | `createRoutedRealtimeServer`: the same adapter for many rooms behind one listener |
| `dev.ts`           | The development entry point behind `npm run realtime:dev`                         |

## Protocol

A client may send exactly six messages. All are strict: an extra field makes the message invalid.

```ts
{ type: 'join', joinCode: string, displayName: string }
{ type: 'resume', token: string }
{ type: 'action', intent: unknown }
{ type: 'leave' }
{ type: 'host_auth', token: string }
{ type: 'host_command', command: HostCommand }
```

There is no field for a player id, a session id, a state or a message id.

`HostCommand` is one of exactly four, each validated with the engine's own schema:

```ts
{ type: 'PAUSE_SESSION', reason: string }
{ type: 'RESUME_SESSION' }
{ type: 'ABORT_SESSION', reason: string }
{ type: 'REMOVE_PLAYER', playerId: string }
```

The server sends:

```ts
{ type: 'joined', playerId, token?, state }         // token only in the reply to a join
{ type: 'host_authorized', state }                  // to the connection that became the host
{ type: 'update', entries, state }                  // to every player and the host, after a change
{ type: 'rejected', error: { code, message } }      // to the sender: the game refused
{ type: 'error', code }                             // to the sender: the transport refused
```

| Transport error          | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `BAD_MESSAGE`            | Not text, too large, not JSON, or not one of the six envelopes     |
| `NOT_JOINED`             | An action or leave from a connection that is not a player          |
| `ALREADY_JOINED`         | A join or resume from a connection that is already a player        |
| `WRONG_JOIN_CODE`        | The join code is not this game's                                   |
| `INVALID_TOKEN`          | The token is not valid for what it was presented as                |
| `NOT_HOST`               | A host command from a connection that is not the host              |
| `HOST_ALREADY_CONNECTED` | The host token was presented while another connection is the host  |
| `CANNOT_LEAVE`           | A leave after the game has started                                 |
| `INVALID_SESSION_PATH`   | The address connected to is not `/sessions/<sessionId>`            |
| `SESSION_NOT_FOUND`      | The address names a session that does not exist                    |
| `SESSION_UNAVAILABLE`    | The session exists but could not be made ready                     |
| `SESSION_CLOSED`         | The session is no longer served. The connection is then closed     |
| `CONNECTION_REPLACED`    | Another connection resumed as this player. This one is then closed |

The four session errors are sent by a listener that serves many sessions, and by a room that has
been closed. `CONNECTION_REPLACED` is sent to a connection that is being taken over. No message
envelope changed.

- Text frames only. A binary frame is `BAD_MESSAGE`.
- A frame larger than the limit (4 KB by default) closes the socket with status 1009.
- `intent` is not inspected by the transport. It is passed to the session as it arrived and
  validated by the engine. An invalid intent comes back as `rejected`, not `error`.
- `command` is inspected: anything outside the four above is `BAD_MESSAGE`.

## Who a connection is

Three kinds of caller reach a room, and they are kept apart.

| Caller      | How it is recognised                             | What it may do                                      |
| ----------- | ------------------------------------------------ | --------------------------------------------------- |
| Player      | A connection bound to a player id by join/resume | Send intents as that player; leave in the lobby     |
| Host        | The one connection that presented the host token | Pause, resume, abort, remove a player. Nothing else |
| Server code | Holds the room object in process                 | `tick`                                              |

### Players

**Join.** The connection sends `join` with the game's join code and a display name. The room checks
the code against its one game, makes a new player id itself, and asks the session to add that
player. Only if the game accepts does it bind the connection to that player, make a player token,
and reply `joined` with the id, the token and the state. The token is sent this once, to this
connection only. The others in the room get an `update`.

**Act.** Every `action` from the connection is submitted as that player. The client never sends a
player id; a message containing one is not a valid envelope.

**Disconnect.** The room forgets the connection. The player stays in the game, the token stays
valid, the game is not paused, and nobody is told.

**Resume.** A connection sends `resume` with a player token and is bound to that player. It is the
one way to reconnect; there is no other message for it.

- The reply is `joined` with the player id and the state, and no token. No player is created,
  the game does not change, and nobody else is told.
- A token that is not a current player's is `INVALID_TOKEN`: an unknown or altered token, a token
  from another game, the host token, and the token of a player who has left or been removed. The
  connection is not bound and nothing changes. It stays open and may try again.
- A connection that is already a player is `ALREADY_JOINED`, whatever token it sends. A token makes
  a connection the one player it is for, and no connection is ever two players.
- **Takeover.** If the player still has a connection, the new one replaces it. The earlier
  connection is unbound first, then sent `CONNECTION_REPLACED` and closed. A player has at most
  one connection at any moment: the earlier one can no longer act or hear, and anything it still
  sends is answered `NOT_JOINED`. Two resumes for one player are handled in the order they arrive,
  and the later one is the player.

**Tokens that can be made again.** By default a player token is a random value made at the join
and remembered by that room only, so it works only in that room. A room made with
`playerToken: (playerId) => string` instead asks that function for a player's token every time,
and accepts the token of every player the game has and has not lost. A room made later around the
same game, restored from a snapshot, therefore accepts the tokens those players were given
before. The room keeps the function's results in memory like any other token; it never puts one in
the game state. What makes such a token unguessable is the function's business, not the room's.

**Leave.** A player may `leave` while the game is in the lobby. The room issues `REMOVE_PLAYER` for
that player, and on success invalidates the token, frees the place and tells everyone. After the
game starts, `leave` is refused with `CANNOT_LEAVE`. This is a rule of the transport, not the
engine: a game that loses its only tagger or seeker mid-round is not handled, so a player cannot
take themselves out then.

### The host

`createHostedGame` returns a host token to its caller. A connection that sends it in `host_auth`
becomes the host and may send the four host commands.

- One host connection at a time. While one is connected, another presenting the same token is
  refused with `HOST_ALREADY_CONNECTED`; the role is not taken over silently.
- A host that disconnects loses only the role. The game is not paused or stopped, and the token
  works again afterwards.
- A removed player's token is invalidated and their connection stops being part of the room.
- The host is not a player unless the same connection also joins. It receives updates either way.
- A room made without a host token (`createRoom({ session })`) has no host at all.

## Security limits

The tokens are **bearer capabilities, not authentication.**

- Whoever has a player token is that player. Whoever has the host token is the host. Nothing proves
  who a person is, and there are no accounts.
- The socket is plain `ws`. Tokens and everything else can be read, and altered, by anyone on the
  network path. This is acceptable on a development machine and nowhere else.
- Tokens exist only in the room's memory. They are never part of `GameState`, never in an `update`,
  and never logged (the development entry point prints the host token once, on purpose). They are
  lost when the process stops.
- A token belongs to the room that issued it and means nothing to any other.
- Anyone with the join code can join until the game is full. Nothing limits guesses at a join code
  or a token.
- The `Origin` of a connection is not checked.

## Many rooms behind one listener

```ts
const server = await createRoutedRealtimeServer({ port: 3001, route });
// route(sessionId) → a Room, or why there is none
```

A client connects to `ws://host/sessions/<sessionId>`. The session id is read from that address
when the socket connects, `route` is asked for the room, and the socket becomes a connection of that
room and of no other. After that it is an ordinary connection: the same six envelopes, the same
checks, the same broadcasts.

- **The address chooses, once.** No message carries a session id, and the envelopes are strict, so
  nothing sent later can move a connection to another room. A query string is ignored.
- **It fails closed.** An address that is not exactly `/sessions/<sessionId>`, an unknown session,
  a session that cannot be made ready, and a `route` that throws each get one `error` frame and a
  closed socket. A failing `route` is reported as `SESSION_UNAVAILABLE` with no detail.
- **Nothing is read early.** `route` may take time, for example to load a session. The socket is
  paused until it has a room; what it sent meanwhile is then handled in order, or dropped unread if
  it is refused.
- **No table.** The adapter asks `route` for every socket and keeps nothing. Whoever supplies
  `route` decides which sessions exist and owns their rooms.
- **Broadcasts stay in their room.** A room writes only to its own connections, so nothing one
  session does reaches a connection of another.

### Trusted server calls: `tick`, `applyEvent`, `onUpdate`

```ts
room.tick(ctx); //                    advance time
room.applyEvent(validated, ctx); //   apply an external event the engine validated
createRoom({ session, onUpdate: (update) => { … } });
```

None of these is reachable from a client message. `applyEvent` has the session apply an event the
engine has already validated and, if the engine accepts it, broadcasts the result with the same
`update` message as any other change. The room does not judge the event: the engine decides whether
it is legal and still current, and a caller acting for a Game Master must pass only what the safety
package released. A closed room refuses.

`onUpdate` is told each change the room broadcasts, once, with the entries it added and the state
after it, whether or not anyone is connected. It is what the connections are sent. A listener
cannot alter it, and one that throws is ignored.

### Plain HTTP and a heartbeat on the same listener

`createRoutedRealtimeServer({ …, http, heartbeatMs })`.

- `http(request, response)` answers requests on the same port that are not WebSocket upgrades, such
  as a health check. Left out, such a request is answered 426. A handler that throws is answered
  500 with no detail.
- `heartbeatMs` pings every socket that has a room. One that has not answered the previous ping by
  the next is closed, so a peer that vanished without closing does not stay a connection of its
  room. Left out or 0, no ping is sent.

### Being told what happens at the listener

`createRoutedRealtimeServer({ …, onSocket, onError })`. `onSocket` is told when a socket opens,
is given its room, is refused (with the code it was sent) and closes: the kind of thing that
happened, never an address or a session. `onError` is handed an error the listener reports after
it has started, and whatever a failing `route` threw; the client is still told only
`SESSION_UNAVAILABLE`. Listeners that throw are ignored.

### Knowing whether a room is in use

```ts
createRoom({ session, onConnections: (count) => { … } });
```

`onConnections` is told how many connections the room knows of, joined or not, each time one
arrives or goes away. A connection that is taken over by a resume counts as gone at that moment.
It is not called when the room is closed. The room does nothing with the number, has no idea of
"idle", and reads no clock: whoever listens decides what an empty room means. A listener that
throws is ignored.

### Closing a room

```ts
room.attach(connection); // the room now knows of it, before it has sent anything
room.close(); //            once, and for good
```

`close()` sends `SESSION_CLOSED` to every connection the room knows of, joined or not, closes them,
and forgets every binding and token. From then on the room changes nothing: any frame is answered
with `SESSION_CLOSED` and its connection closed, `attach` returns false, and `tick` does nothing.
The game object is not touched, and no other room is affected. A room cannot be reopened; serving
the session again means making a new room.

## What it guarantees

- **One game per room, chosen by the server.** A room is given its session when it is made and
  never looks one up. No message selects a game. Behind `createRealtimeServer` nothing in the URL
  does either; behind `createRoutedRealtimeServer` the address a socket connects to selects its
  room, once.
- **A player acts only as themselves,** and a player's message cannot become a host command.
- **The host can send four commands and no others.** `ADD_PLAYER`, `ADVANCE_PHASE` and anything
  else the engine accepts from trusted code are not expressible on the wire.
- **Broadcast is the session's result.** `update` carries the history entries the change added and
  the full authoritative state. Nothing a client sent is echoed.
- **A refusal reaches the sender only** and changes nothing.
- **Order is preserved.** The room is synchronous, so updates go out in history order.
- **No clock inside.** The adapter stamps each frame from an injected `Clock`. The room has no
  clock, timer or promise.

## What it is not

- **Not authenticated or encrypted.** See above. Real authentication and TLS are deferred.
- **No registry of its own.** `createRealtimeServer` is one session per server. The routed
  listener serves many rooms but holds no table of them: it asks its caller's `route` for each
  socket. Neither gives a client a way to create a game.
- **No automatic tick.** `room.tick(ctx)` advances time and broadcasts if the game changed. It is a
  trusted server-side call and nothing calls it on a timer, so a round nobody acts in does not end
  by itself.
- **No private views.** The full state is broadcast, including the join code and the random seed.
- **No duplicate detection, rate limiting or backpressure.**
- **No safety check on display names.** They are free text shown to other players.
- **No handling of a tagger or seeker removed mid-game.** The host can do it; the game carries on
  without one.
- **Not a server you deploy by itself.** Next.js cannot accept a WebSocket upgrade in a route
  handler, so the transport runs in its own process: the game server in `@touchgrass/server`, which
  uses the routed listener here. See [DEPLOYMENT.md](../../DEPLOYMENT.md).
- **Not durable by itself.** A room and its tokens are in one process's memory. Keeping a game
  across a restart is the server package's job.
- **Not connected to the Game Master.** The room does not know one exists. It offers trusted
  server code two things a Game Master integration uses: `applyEvent`, and `onUpdate`.

## Dependencies

`@touchgrass/game-session`, `@touchgrass/game-engine`, `@touchgrass/shared`, `zod`, `ws`.
