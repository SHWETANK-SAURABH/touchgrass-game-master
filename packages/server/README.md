# @touchgrass/server

The application layer for a persistent game: it creates or loads a game, serves it over the
realtime transport, saves it when asked, and shuts everything down.

It is where four existing pieces meet. Each keeps its own job.

| Piece                              | Owns                                             |
| ---------------------------------- | ------------------------------------------------ |
| `SessionStore` (MongoDB or memory) | Stored snapshots                                 |
| `GameSession`                      | The running game. The authority while it runs    |
| `Room` (realtime)                  | Connections and bearer tokens                    |
| This package                       | Starting them, explicit saves, and shutting down |

**This is a development-stage server.** `startPersistentServer` serves one game from one listener.
`startSessionServer` serves many games from one listener, through a
[session registry](#many-games-in-one-process). There is no authentication, the socket is
unencrypted, and it is not deployed anywhere.

```
CREATE   createGameSession → saveSession → store            (saved once, or it fails)
LOAD     store → loadSession → restoreGameSession → GameSession
SERVE    GameSession → Room → WebSocket server
SAVE     only when asked:  server.save() → saveSession → store
```

## Running it locally

It needs a MongoDB server. A local installation is enough; nothing here starts one.

```
MONGODB_URI=mongodb://127.0.0.1:27017 npm run server:dev
```

| Variable             | Meaning                                          | Default      |
| -------------------- | ------------------------------------------------ | ------------ |
| `MONGODB_URI`        | Connection string. Required                      | none         |
| `MONGODB_DATABASE`   | Database name                                    | `touchgrass` |
| `MONGODB_COLLECTION` | Collection name                                  | `sessions`   |
| `SERVER_PORT`        | Port to listen on                                | `3001`       |
| `SERVER_GAME`        | Game definition id for a new game                | `tag`        |
| `SESSION_ID`         | Load this stored session instead of creating one | none         |

It prints the session id, the join code and a host token. To bring the same game back later, start
it again with `SESSION_ID` set to that id.

A new game is saved once, when it is created. While it runs, **nothing is saved unless you type
`save`** in the terminal.

`quit` and Ctrl+C stop the server gracefully, with `shutdown()`: the game is saved once if it has
unsaved changes, and the server says which happened. If that final save fails, the error is printed
and the process exits with a non-zero status. Killing the process any other way saves nothing.

The terminal is the only way to ask for a save. There is no network command for it, because nothing
authenticates who would be asking. Exposing save, load or delete to clients needs an authentication
decision first.

## API

```ts
createPersistentSessions(store): PersistentSessions
// { create(command, ctx), load(sessionId), save(session), delete(sessionId) }

hostSession(session): { session, room, hostToken }

createSessionHandle({ hosted, persist, beforeStop?, afterStop? }): SessionHandle
// SessionHandle: { session, room, hostToken, save(), hasUnsavedChanges(), close(), shutdown() }

startPersistentServer({ store, game, port, clock? }): Promise<Result<PersistentServer, …>>
// game: { create: command } | { load: sessionId }
// PersistentServer: a SessionHandle, plus { port }

createSessionRegistry({ store }): SessionRegistry
// { create(command, ctx), load(sessionId), get(sessionId), delete(sessionId), shutdown() }

startSessionServer({ store, port, clock? }): Promise<Result<SessionServer, …>>
// SessionServer: { port, registry, socketCount(), shutdown() }

parseServerConfig(env): Result<ServerConfig, ServerConfigError>
```

### Create

`create` makes a game through `createGameSession` and then saves its first snapshot. It reports
success only if that save succeeded.

- If the save fails, the failure is returned and no session comes back. Nothing is retried and
  nothing remembers the session that was briefly made.
- An id that is already stored is refused with `SESSION_ALREADY_EXISTS` and the stored game is left
  as it is. The check and the save are two steps, not one atomic operation.
- A game that cannot be created is `SESSION_NOT_CREATED`, with the reason.

### Load

`load` is `loadSession`: the store is read and the snapshot goes through `restoreGameSession`.

- A session that is not stored is `SESSION_NOT_FOUND`. Nothing is created in its place.
- A stored snapshot that cannot be restored is `INVALID_SNAPSHOT`, with the reason. It is left in
  the store.
- **Restore means restore.** The game comes back exactly as it was saved. Its timers, rounds,
  scores and roles are not changed, and nothing is advanced, paused or reset because time has
  passed since the save. What a running game should do about the time it was away is undecided.

### Save and delete

`save` is `saveSession` and `delete` is `deleteSession`. This package never reads a `GameState`,
builds a snapshot or talks to MongoDB itself.

- A failed save is returned. The running game is unchanged and stays usable.
- Deleting a stored game does not touch a running one or its connections.

**A server makes its saves one at a time.** `server.save()` never has two writes at the store
together:

- A save asked for while another is still going waits for it. Saves run in the order they were
  asked for.
- A waiting save stores the game as it is when it starts, not as it was when it was asked for, so a
  later save never stores an older state than an earlier one.
- Each caller gets the result of its own save. A save that fails does not hold up the ones behind
  it.
- A save asked for when none is pending starts at once, as before.

This orders the saves of one server handle. It is not a lock on the stored game: two processes
serving the same session still overwrite each other, and the last write wins. Nothing here detects
that.

Errors are the persistence lifecycle's own: `INVALID_SESSION_ID`, `SESSION_NOT_FOUND`,
`STORAGE_ERROR`, `INVALID_SNAPSHOT`. No driver error reaches this layer.

## Persistence is explicit

Saving happens in three places only, each asked for by a caller: once when a game is created, when
`save()` is called, and once inside `shutdown()` if the game has unsaved changes.

No join, action, host command, tick, leave, resume or disconnect saves anything. The room and the
session do not know a store exists. So the stored game is whatever it was at the last successful
save, and a running game is usually ahead of it. If the process stops without `shutdown()`, whether
by `close()`, a crash or a kill, everything since the last save is lost. There is no autosave.

## Knowing whether there is anything to save

```ts
server.hasUnsavedChanges(): boolean
```

It answers one question: has the game changed since this server last saved it successfully?

- **It is an in-memory query at the application boundary.** It exists on the `PersistentServer`
  handle and nowhere else. The session, the room, the store and the persistence lifecycle have no
  such method and know nothing of it.
- **It compares two references.** The server keeps the exact `GameState` object that was last
  saved. A `GameSession` replaces its state object only when the game really changes, so
  `session.getState() !== lastSavedState` is an exact test. There is no counter, flag or listener.
- **It does not save, and it does not cause a save.** A true answer does nothing. Saving is still
  only `save()`.
- **It is not stored or sent.** It adds nothing to `GameState`, the history, the snapshot or the
  MongoDB document, and nothing to any message a client receives.

When it is false and when it is true:

| After                                                    | Answer                                     |
| -------------------------------------------------------- | ------------------------------------------ |
| Creating a game (its first snapshot has just been saved) | `false`                                    |
| Loading a stored game                                    | `false`                                    |
| An accepted action, command, join or leave               | `true`                                     |
| A refused operation                                      | as before                                  |
| Time advancing when nothing was due                      | as before                                  |
| Time advancing when a round ended or something expired   | `true`                                     |
| A successful `save()`                                    | `false`, unless the game changed during it |
| A failed `save()`                                        | as before                                  |

**A change during a save is not lost.** `save()` notes the state it is about to save before it waits
for the store. If the game changes while the store is working, the state that was saved is the
earlier one, and the answer stays `true` until a later save succeeds. A save that has been sent but
not yet confirmed still counts as unsaved.

**It speaks only for this server.** It means "this handle has successfully saved this state". It
does not mean the store still holds it. It cannot see that:

- another process has overwritten the stored snapshot;
- another process has deleted it;
- the database's copy differs for any other reason.

There is no optimistic concurrency control, so none of those can be detected.

## Stopping: `close()` and `shutdown()`

There are two ways to stop, and the difference is deliberate.

```ts
await server.close(); //    stop, without persistence
await server.shutdown(); // stop gracefully, keeping the game
```

|                           | `close()` | `shutdown()`                 |
| ------------------------- | --------- | ---------------------------- |
| Stops the realtime server | yes       | yes, first                   |
| Saves unsaved changes     | **never** | once, if there are any       |
| Closes the store          | yes       | yes, last                    |
| Returns                   | nothing   | the result of the final save |

**`close()` is resource shutdown without persistence.** It does not save and does not look at
whether there is anything to save. Whatever changed since the last save is discarded. A save that a
caller had already asked for is allowed to finish first: neither `close()` nor `shutdown()` closes
the store while a save is pending.

**`shutdown()` is graceful, persistence-aware shutdown.** Its order is fixed:

```
realtime server stops  →  save, if there are unsaved changes  →  store closes
```

- The realtime server is stopped first, so no client message can change the game while the final
  state is being saved. The save does not begin until it has finished stopping.
- Saves that are already under way are waited for before deciding whether anything is unsaved. If
  one of them stored the current state, no further save is made.
- A game with unsaved changes is saved, through the same `save()` as an explicit save.
- A game with nothing unsaved is not saved: the store receives no save call.
- The save happens at most once. It is never retried.
- The result of the final save is returned, or success if nothing needed saving.

**If the final save fails,** the store is still closed, the persistence error is returned to the
caller, and `hasUnsavedChanges()` stays true. Nothing pretends the game was kept. Because the store
is closed, it cannot be tried again on this server.

**If something will not close.** The store is always closed, whatever happens before it. If the
realtime server fails to stop, `close()` still closes the store, and `shutdown()` still attempts the
final save and closes the store; the failure is then thrown. If the store fails to close, that is
thrown. If both fail, the first is thrown. After a `shutdown()` that threw, `hasUnsavedChanges()`
still says whether the game was saved.

**Calling them more than once.**

- `shutdown()` again returns the first call's result and does nothing more: no second save, nothing
  closed twice.
- `close()` after `shutdown()`, or `close()` again, does nothing.
- `shutdown()` after `close()` does nothing and reports success. It cannot save, because the store
  is already closed; `hasUnsavedChanges()` still tells whether anything was lost.

`shutdown()` is not autosave. It runs when a caller calls it, starts no timer, and adds nothing to
what happens while a game is running. How long the final save may take is whatever the store allows;
with an unreachable MongoDB server that can be the driver's full wait.

## The room is always new

Bearer tokens and connections are not part of a snapshot, so they are never stored.

- Loading a game creates a new `GameSession` and a new `Room` around it.
- The room starts with no connections and a new host token.
- Every player is still in the game, but no token issued before works: a player cannot resume, and
  the old host token is refused.

One server is one room around one session. A loaded session is the one the room is built around; it
is not copied.

## The store

The application creates the store and owns it.

- `dev.ts` reads the environment, parses it with `parseServerConfig`, and passes the result to
  `createMongoSessionStore`. That is the only place the environment is read and the only place a
  MongoDB store is made. The store package reads no environment variable.
- `startPersistentServer` takes any `SessionStore`, so the tests use the in-memory one.
- A `PersistentServer`'s `close()` and `shutdown()` both end by closing the store, even if stopping
  the realtime server failed. A server that failed to start does not close the store it was given.
- A registry is given one store for all its sessions and closes it once, in `registry.shutdown()`.
  For MongoDB that is one `MongoSessionStore`, so one client and one connection pool, however many
  games are loaded.

## Many games in one process

```ts
const registry = createSessionRegistry({ store });
```

A registry holds the games loaded in one process.

```
Application
 ├── SessionStore        one, shared, closed once by the registry
 └── SessionRegistry
      ├── SessionHandle A    session, room, host token, dirty marker, save queue
      ├── SessionHandle B
      └── SessionHandle C
```

A `SessionHandle` is everything that belongs to one game alone. It is what a `PersistentServer` is
without its port, and its `save()`, `hasUnsavedChanges()`, `close()` and `shutdown()` behave as
described above, with one difference: **a registry's handle never closes the store.** The store is
shared, and only the registry closes it.

**One id, at most one loaded session.** Inside one registry there is never a second `GameSession`
for an id that is loaded.

| Call                   | What happens                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `create(command, ctx)` | Makes the game, saves its first snapshot, then makes its room and token          |
| `load(id)`             | Returns the loaded handle, or joins a load under way, or restores from the store |
| `get(id)`              | The handle if it is loaded here now. The store is not asked                      |
| `delete(id)`           | Deletes the stored snapshot. Refused while the session is loaded                 |
| `shutdown()`           | Shuts down every loaded session, then closes the store                           |

- **Create.** The id is reserved before the store is touched, so of two creations of one id exactly
  one goes on; the other is `SESSION_ALREADY_EXISTS`, as is an id that is loaded or already stored.
  The room and host token are made only after the first snapshot is saved. If anything fails,
  nothing is left: no entry, no room, no token, and the id can be tried again.
- **Load.** `load` of a loaded id is not an error: it returns the same handle and does not read the
  store. Loads that overlap share one restore and one handle, or one failure. A failed load is not
  remembered. A loaded game always gets a new room and a new host token.
- **Delete, unload and ending a game are three things.** Ending a game is the `ABORT_SESSION` host
  command. Unloading is the handle's `close()` (discard unsaved changes) or `shutdown()` (save them
  first); either removes it from the registry. `delete` removes the stored snapshot, and refuses a
  loaded session with `SESSION_LOADED`: otherwise the live game's next save would write it back.
  For the same reason a handle that has been unloaded can no longer save; its `save()` returns
  `STORAGE_ERROR`.
- **One at a time per id.** A load, a delete and an unload of the same id never overlap. A load
  asked for while that session is shutting down waits for its final save and then restores it. A
  delete asked for after a load finds the session loaded; a load asked for after a delete finds
  nothing.
- **Independent across ids.** Each handle has its own dirty marker and its own save queue. Saving
  one game does not wait for another's save and does not change whether another has unsaved
  changes. There is no shared queue.
- **Isolated rooms.** Each handle has its own room, so its own player tokens, host token and
  connections. A token from one session is `INVALID_TOKEN` in another, and a host command or a
  broadcast never leaves its room.

**`registry.shutdown()`** is the process-level stop:

```
refuse new work  →  wait for what is under way  →  shut down every session  →  close the store
```

- From the moment it is called, `create`, `load` and `delete` return `REGISTRY_CLOSED`. A registry
  does not reopen.
- A create or load already under way is waited for. If it succeeds, that session is shut down with
  the rest.
- Every loaded session gets `shutdown()`: one save if it has unsaved changes, none otherwise. They
  run together, each through its own save queue.
- A session that cannot be saved does not stop the others. The store is closed last, once, whatever
  happened.
- It returns success, or `SHUTDOWN_INCOMPLETE` with the sessions that were not saved, each with its
  persistence error, and whether the store closed. A session its own caller was already shutting
  down is waited for but reported to that caller, not here.
- Calling it again returns the first call's result.

**What a registry is not.**

- It is not networking. It attaches no listener. `startSessionServer`, below, puts one in front of
  it.
- It is not a lock. The rule is per registry, in one process. Another process, or a second registry
  over the same store, can load the same session, and the last save wins.
- It does not evict. A finished game stays loaded until its handle is closed or shut down.

Nothing is kept at module level. Two registries are independent.

`createPersistentSessions` remains the registry-free layer underneath: it holds only a store, and
loading the same id through it twice gives two independent sessions.

## One listener for many games

```ts
const server = unwrap(await startSessionServer({ store, port: 3001 }));
const game = unwrap(await server.registry.create(command, ctx)); // trusted server code
// a client connects to  ws://host:3001/sessions/<game.session.id>
```

```
client ──► ws://host/sessions/<sessionId>     the address chooses the session, once
             ▼
       one WebSocket listener                  reads the address, asks for the room
             ▼
       SessionRegistry                         get, or load from the one store
             ▼
       SessionHandle ──► Room ──► GameSession  as behind a single-game server
```

`startSessionServer` owns one registry over the one store it is given, and one listener. Each piece
keeps its own job:

| Piece         | Decides                                                             |
| ------------- | ------------------------------------------------------------------- |
| The transport | Which session a socket is for, from its address, when it connects   |
| The registry  | Which sessions are loaded. It is the only thing that loads one      |
| The room      | Everything about a connection after that: who it is, what it may do |
| The session   | The game                                                            |

**Routing.** A socket connects to `/sessions/<sessionId>`. The server takes the handle from
`registry.get`, or else `registry.load`, and the socket becomes a connection of that handle's room.
The message envelopes are unchanged and none carries a session id, so nothing a client sends later
can reach another session. The join code is still checked by the room, as before.

| A socket that connects to                          | Gets                                  |
| -------------------------------------------------- | ------------------------------------- |
| A loaded session                                   | That session's room                   |
| A stored session that is not loaded                | It is loaded, then that room          |
| An address that is not `/sessions/<sessionId>`     | `INVALID_SESSION_PATH`, and is closed |
| A session that does not exist                      | `SESSION_NOT_FOUND`, and is closed    |
| A session the store cannot give, or cannot restore | `SESSION_UNAVAILABLE`, and is closed  |
| Any session, while the server is shutting down     | `SESSION_CLOSED`, and is closed       |

A refusal is one `error` frame with the code and nothing else: no storage detail reaches a client.
Connections that arrive together for a session that is not loaded share one load and one room.

**Sessions are not created over the network.** The protocol has no message for it, and nothing
authenticates who would be asking. Trusted server code creates them with `server.registry.create`.
The same goes for saving, unloading and deleting: they are calls on the registry and its handles.

**Isolation.** Each session has its own room, so its own connections, player tokens and host
token. A broadcast goes to its room's connections only. A token from one session is
`INVALID_TOKEN` at another's address. Sessions do not wait for each other: there is no lock around
them, and each still makes its own saves one at a time.

**A connection going away.** When a socket closes, for any reason, its room forgets it. The player
stays in the game, and other connections of that session and of every other session are untouched.

**A session being unloaded.** A handle's `close()` or `shutdown()` begins by closing its room:
every connection of that session is sent `SESSION_CLOSED` and closed, including ones that never
sent anything, and the room accepts nothing more. Connections of other sessions are not touched.
This is true of every handle, so `startPersistentServer` now sends its clients `SESSION_CLOSED`
before it stops as well.

- A handle that has been unloaded is finished. Its room answers `SESSION_CLOSED`, its `tick` does
  nothing, and its `save()` returns `STORAGE_ERROR`, so it can neither change the game nor write a
  snapshot back.
- A later connection to the same address loads the session again from the store, into a new room
  with a new host token. No token from the old room works. If the session was still being saved,
  the new connection waits for that save.
- `registry.delete` still refuses a loaded session. After unloading and deleting, connecting to
  that address is `SESSION_NOT_FOUND`.

**`server.shutdown()`** stops everything:

```
refuse new connections  →  registry.shutdown()  →  listener stops
```

`registry.shutdown()` closes every session's connections, saves each session once if it has
unsaved changes, and closes the store. The listener then stops and any socket still open is
closed. It returns the registry's result, and calling it again returns the same result.

**What it does not do.** Nothing here is authentication: anyone who can reach the port and knows
a session id can connect to it, which also loads it if it is stored. Nothing evicts a loaded
session, advances time, or saves on its own. There is no reconnect beyond the existing `resume`
within one loaded room, and no development command starts this server yet; `npm run server:dev`
is still the single-game server.

## Tests

The tests use the in-memory store and need no database. One file runs the full flow against a real
MongoDB server, but only when asked:

```
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
```

Without `MONGODB_TEST_URI` it is skipped. With it, it uses a database with a random name and drops
it afterwards.

## Not here

Autosave, saving per action, retries, transactions, revision checks, locks, creating a session
over the network, join-code routing, eviction of finished games, authentication, stored tokens,
reconnecting old clients after a restore, several servers sharing a game, Redis, and any adjustment
of a running game's clock on load.

## Dependencies

`@touchgrass/game-session`, `@touchgrass/session-store`, `@touchgrass/session-persistence`,
`@touchgrass/realtime`, `@touchgrass/game-engine`, `@touchgrass/shared`, `zod`.
