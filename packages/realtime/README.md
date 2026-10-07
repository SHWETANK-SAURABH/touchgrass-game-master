# @touchgrass/realtime

A WebSocket transport around one game session.

It connects sockets to a `GameSession` (`@touchgrass/game-session`): it reads a client's message,
works out who that connection is, hands the request to the session, and sends the authoritative
result to everyone in the game. It holds no game rules and no game state.

**This is a development-stage boundary.** One server holds one game. It uses bearer tokens instead
of authentication, over an unencrypted socket, and it is not deployed anywhere. See
[Security limits](#security-limits) and [What it is not](#what-it-is-not).

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

| Module           | Does                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `protocol.ts`    | The message envelopes and `parseClientMessage`. Knows messages, not games      |
| `room.ts`        | `createRoom`: connections, players, tokens, the host role, broadcast, `tick`   |
| `hosted-game.ts` | `createHostedGame`: makes a session, its room and its host token together      |
| `ws-server.ts`   | `createRealtimeServer`: a thin `ws` adapter. The only module that imports `ws` |
| `dev.ts`         | The development entry point behind `npm run realtime:dev`                      |

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

| Transport error          | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `BAD_MESSAGE`            | Not text, too large, not JSON, or not one of the six envelopes    |
| `NOT_JOINED`             | An action or leave from a connection that is not a player         |
| `ALREADY_JOINED`         | A join or resume from a connection that is already a player       |
| `WRONG_JOIN_CODE`        | The join code is not this game's                                  |
| `INVALID_TOKEN`          | The token is not valid for what it was presented as               |
| `NOT_HOST`               | A host command from a connection that is not the host             |
| `HOST_ALREADY_CONNECTED` | The host token was presented while another connection is the host |
| `CANNOT_LEAVE`           | A leave after the game has started                                |

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

**Resume.** A connection sends `resume` with a player token and is bound to that player. No player
is created and nothing is broadcast. If the player still had a connection, it is closed first: a
player has at most one connection, and the earlier one can no longer act or hear. A player who has
left cannot resume.

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

## What it guarantees

- **One game per room, chosen by the server.** There is no session registry and no lookup. Nothing
  in a URL or a message selects a game.
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
- **Not multi-game.** One session per server. No registry, no way for a client to create a game.
- **No automatic tick.** `room.tick(ctx)` advances time and broadcasts if the game changed. It is a
  trusted server-side call and nothing calls it on a timer, so a round nobody acts in does not end
  by itself.
- **No private views.** The full state is broadcast, including the join code and the random seed.
- **No duplicate detection, rate limiting or backpressure.**
- **No safety check on display names.** They are free text shown to other players.
- **No handling of a tagger or seeker removed mid-game.** The host can do it; the game carries on
  without one.
- **Not deployed.** Next.js cannot accept a WebSocket upgrade in a route handler, so this needs its
  own process or a custom server; neither exists. The Docker image does not start it.
- **Not durable.** State and tokens are in one process's memory. A restart ends the game.
- **Not connected to the Game Master.**

## Dependencies

`@touchgrass/game-session`, `@touchgrass/game-engine`, `@touchgrass/shared`, `zod`, `ws`.
