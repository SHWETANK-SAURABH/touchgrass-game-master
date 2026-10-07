# @touchgrass/realtime

A WebSocket transport around one game session.

It connects sockets to a `GameSession` (`@touchgrass/game-session`): it reads a client's message,
works out which player that connection is, hands the intent to the session, and sends the
authoritative result to everyone in the game. It holds no game rules and no game state.

**This is a development-stage boundary.** One server holds one game, there is no authentication, and
it is not deployed anywhere. See [What it is not](#what-it-is-not).

```ts
import { createGameSession } from '@touchgrass/game-session';
import { createRealtimeServer } from '@touchgrass/realtime';

const session = createGameSession(createCommand, ctx); // one game
const server = await createRealtimeServer({ session: session.value, port: 3001 });

server.room.tick(ctx); // trusted, server side: advance time and broadcast
await server.close();
```

`npm run realtime:dev` starts one server around one new game and prints its join code.

## Modules

| Module         | Does                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `protocol.ts`  | The message envelopes and `parseClientMessage`. Knows messages, not games        |
| `room.ts`      | `createRoom`: ties connections to one session. Joins, actions, broadcast, `tick` |
| `ws-server.ts` | `createRealtimeServer`: a thin `ws` adapter. The only module that imports `ws`   |
| `dev.ts`       | The development entry point behind `npm run realtime:dev`                        |

## Protocol

A client may send exactly two messages. Both are strict: an extra field makes the message invalid.

```ts
{ type: 'join', joinCode: string, displayName: string }
{ type: 'action', intent: unknown }
```

There is no field for a player id, a session id, a state, a message id or a command.

The server sends:

```ts
{ type: 'joined', playerId, state }                 // to the connection that joined
{ type: 'update', entries, state }                  // to every joined connection, after a change
{ type: 'rejected', error: { code, message } }      // to the sender: the game refused
{ type: 'error', code }                             // to the sender: the transport refused
```

Transport error codes: `BAD_MESSAGE`, `NOT_JOINED`, `ALREADY_JOINED`, `WRONG_JOIN_CODE`.

- Text frames only. A binary frame is `BAD_MESSAGE`.
- A frame larger than the limit (4 KB by default) closes the socket with status 1009.
- Anything that is not JSON, or not one of the two envelopes, is `BAD_MESSAGE`.
- The envelope is validated here. `intent` is not inspected: it is passed to the session as it
  arrived and validated by the engine as a player intent. An invalid intent comes back as
  `rejected`, not `error`.

## How a connection becomes a player

1. The connection sends `join` with the game's join code and a display name.
2. The room checks the code against the one game it holds.
3. The room makes a new player id itself and asks the session to add that player.
4. Only if the game accepts does the room record that this connection is that player, and reply
   `joined` with the id and the state. The others in the room get an `update`.

From then on every `action` from that connection is submitted as that player. The client never
sends a player id; a message containing one is not a valid envelope.

**This is not authentication.** A connection is not a user. Anyone who has the join code can join,
and nothing proves who they are. The id means "the same connection that joined" and nothing else.
The table of connections is kept by the room and is never part of `GameState`.

## What it guarantees

- **One game per room, chosen by the server.** A room is given its `GameSession` when it is made.
  There is no session registry and no lookup. Nothing in a URL or a message selects a game; the
  join code is an admission check against that one game.
- **Joining is the only host command a client can cause,** and only for itself. Pause, resume,
  abort, removal and phase changes are not reachable from any message.
- **Broadcast is the session's result.** `update` carries the history entries the change added and
  the full authoritative state. Nothing a client sent is echoed.
- **A refusal reaches the sender only** and changes nothing. A connection that has not joined is
  sent nothing about the game.
- **Order is preserved.** The room is synchronous: a frame is handled and its messages are written
  before the next frame is read, so updates go out in history order.
- **No clock inside.** The adapter stamps each frame from an injected `Clock` (the system clock by
  default, a fixed one in tests). The room has no clock, timer or promise.

## What it is not

- **Not authenticated.** See above.
- **Not multi-game.** One session per server. No registry, no way for a client to create a game.
- **No reconnection and no leave.** A disconnect removes the connection and leaves the player in
  the game: no `REMOVE_PLAYER` is issued. Nobody can act as that player afterwards, and a new
  connection cannot become them.
- **No automatic tick.** `room.tick(ctx)` advances time and broadcasts if the game changed. It is a
  trusted server-side call and nothing calls it on a timer. A game moves forward in time only when
  a message is accepted or something calls `tick`, so a round nobody acts in does not end by itself.
- **No private views.** The full state is broadcast to every joined connection, including the join
  code and the random seed.
- **No duplicate detection, rate limiting or backpressure.** A message sent twice is processed
  twice; a slow client is written to like any other.
- **No safety check on display names.** They are free text shown to other players.
- **Not deployed.** Next.js cannot accept a WebSocket upgrade in a route handler, so this needs its
  own process or a custom server; neither exists. `realtime:dev` runs it with `tsx` for local use.
  The Docker image does not start it.
- **Not durable.** State is in one process's memory. A restart ends the game.
- **Not connected to the Game Master.**

## Dependencies

`@touchgrass/game-session`, `@touchgrass/game-engine`, `@touchgrass/shared`, `zod`, `ws`.
