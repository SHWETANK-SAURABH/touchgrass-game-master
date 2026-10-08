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

### Many games: `npm run sessions:dev`

```
MONGODB_URI=mongodb://127.0.0.1:27017 npm run sessions:dev
```

This starts the multi-session server: one process, one listener, one MongoDB store, one registry,
and any number of games at `ws://localhost:<port>/sessions/<sessionId>`. `npm run server:dev` is
unchanged and is still the single-game server.

It reads the four variables above that are not about one game (`MONGODB_*`, `SERVER_PORT`), and
three of its own:

| Variable                   | Meaning                                              | Default    |
| -------------------------- | ---------------------------------------------------- | ---------- |
| `SESSION_IDLE_MS`          | Evict a session that has had no connection this long | 30 minutes |
| `SESSION_FINISHED_IDLE_MS` | The same, once its game is over                      | 0          |
| `SESSION_SWEEP_MS`         | How often to look for sessions to evict              | 1 minute   |

Sessions are made and managed from its terminal, because nothing authenticates a network caller:

| Command           | Does                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `create [gameId]` | Makes a game (default `tag`), prints its address, join code and host token |
| `list`            | The sessions in memory, each with its state and connection count           |
| `save <id>`       | Saves one now                                                              |
| `evict <id>`      | Releases one from memory, saving it first if needed                        |
| `quit`            | Saves what is unsaved and stops. Ctrl+C does the same                      |

It prints one line for each thing that happens to a session (`created`, `loaded`, `idle`,
`eviction_started`, `evicted`, `eviction_failed`, `unloaded`) with the session id and, for a
failure, an error code. It never prints a player token or anything from a game. A stored session
that is not in memory is loaded when someone connects to it. If a session cannot be saved on the
way out, the errors are printed and the exit status is non-zero.

This entry point holds the only timer in the package: the sweep, which does nothing but call
`registry.evictIdle()`. It is stopped first on shutdown.

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

createSessionRegistry({ store, clock?, idleMs?, finishedIdleMs?, onEvent? }): SessionRegistry
// { create(command, ctx), load(sessionId), get(sessionId), delete(sessionId),
//   evict(sessionId), evictIdle(), sessions(), shutdown() }

startSessionServer({ store, port, clock?, idleMs?, … }): Promise<Result<SessionServer, …>>
// SessionServer: { port, registry, socketCount(), shutdown() }

parseServerConfig(env): Result<ServerConfig, ServerConfigError>
parseLifecycleConfig(env): Result<LifecycleConfig, ServerConfigError>
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
- The room starts with no connections and a new host token. The old host token is refused.
- Every player is still in the game. Behind `startPersistentServer` no player token issued before
  works, so a player cannot resume. Behind a registry a player's token is the same in every room
  of their session, so they can: see [Reconnecting](#reconnecting).

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
  remembered. A loaded game always gets a new room and a new host token; its players keep their
  tokens.
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
- It has no timer. It evicts only when `evict` or `evictIdle` is called; see
  [Session lifecycle](#session-lifecycle-and-eviction).

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
  with a new host token. The old host token does not work there; a player's token does. If the
  session was still being saved, the new connection waits for that save.
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
a session id can connect to it, which also loads it if it is stored. It advances no time, saves
nothing on its own, and has no timer: sessions are evicted when something calls
`server.registry.evictIdle()`, as `npm run sessions:dev` does.

## Session lifecycle and eviction

```
created ──► active ◄──► idle ──► (saved) ──► evicted ──► loaded again ──► …
               │          ▲
               └► finished ┘        deleting is separate, and never automatic
```

A session in memory is in one of four states. `registry.sessions()` lists them.

| State      | Means                                                     |
| ---------- | --------------------------------------------------------- |
| `active`   | It has at least one connection                            |
| `idle`     | It has none                                               |
| `finished` | Its game is over, with connections or without             |
| `closing`  | It is being evicted or unloaded                           |
| (closed)   | Not listed: it is not in memory. It is still in the store |

`finished` is not a new idea of this package. It is the engine's own terminal status, `completed`
or `aborted`, read through `handle.isFinished()`. Finishing a game deletes nothing and unloads
nothing by itself.

**Evicting is not deleting.** Eviction releases what a session holds in memory: its
`GameSession`, room and handle. The stored snapshot is kept, and the session can be loaded again
at any time. `registry.delete` is the only thing that removes a stored game, and nothing calls it
for you.

### What counts as use

A session is in use while its room has a connection: any socket attached to it, joined or not,
player or host. Its idle time is counted from the last moment a connection arrived or went away,
or from when it was created or loaded if it never had one.

Nothing else moves that time. A message needs a connection, so messages are covered. A save, a
`tick`, and anything trusted code does directly to the session are not use: none of them can keep
a session in memory. Unsaved changes they leave are saved before eviction all the same.

### The policy

```ts
createSessionRegistry({ store, clock, idleMs, finishedIdleMs });
await registry.evictIdle(); // evict everything that is due, now
```

- A session is **due** when it has no connection and has had none for `idleMs`, or for
  `finishedIdleMs` if its game is over.
- `idleMs` defaults to 30 minutes and `finishedIdleMs` to 0, so a finished game goes at the next
  sweep after its last connection leaves. Both defaults are constants of the registry
  (`DEFAULT_SESSION_IDLE_MS`, `DEFAULT_FINISHED_IDLE_MS`) and are written nowhere else.
- The time comes from the registry's `clock`. The registry never sleeps and never schedules:
  `evictIdle()` looks once, when called. How often to call it is the application's choice.
- A session with a connection is never due, however old it is. Nothing here disconnects a player
  to make room.

### What an eviction does

`registry.evict(id)` and each eviction inside `evictIdle()` do the same thing:

```
no connection?  →  save if unsaved  →  still unused and unchanged?  →  close room, unload
      │                  │                        │
      └ SESSION_IN_USE   └ the save's error       └ SESSION_IN_USE
        nothing done       still loaded             still loaded
```

1. A session with a connection is refused with `SESSION_IN_USE`. Nothing is saved or closed.
2. If it has unsaved changes it is saved, through its own `save()`, so behind any save already
   under way. A session with nothing unsaved is not written.
3. **If that save fails, the session is not evicted.** The error is returned, and the session
   stays loaded, usable and marked unsaved. Nothing is discarded. It can be evicted again later;
   each `evictIdle()` sweep tries a due session once.
4. While the save was at the store the session was still loaded and reachable. If a connection
   arrived or the game changed in that time, the eviction stands down with `SESSION_IN_USE`. The
   returning player wins, and what changed is unsaved, not lost.
5. Otherwise, in the same turn as that check, the room is closed and the handle unloaded. From
   then on the old handle cannot save and the old room accepts nothing, as for any unloaded
   handle.

- Evicting a session that is not in memory succeeds: there is nothing to release.
- Calls that overlap share one eviction: one save, one unload.
- Sessions are evicted independently and at the same time. One session's failure or slow save
  does not hold up another, and a session that is not due is not touched.
- An eviction asked for while the session is being created or loaded waits, then evicts it.
- A forced eviction of a session that has connections is not offered. Trusted code that must
  unload one calls its handle's `shutdown()`, which tells and closes its connections first.

### Coming back

A connection to `/sessions/<sessionId>` after an eviction loads the session again: a new
`GameSession`, a new room, a new handle, and the same players with the same tokens, as
[Reconnecting](#reconnecting) describes. Nothing of the evicted room or handle is reused, and
neither can reach the new one.

### Being told

```ts
createSessionRegistry({ store, onEvent: (event) => { … } });
// { type, sessionId, at, code? }
```

| Event              | When                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| `created`          | A new session was saved and loaded                                               |
| `loaded`           | A stored session was loaded, for the first time or again                         |
| `idle`             | Its last connection went away                                                    |
| `eviction_started` | An eviction began                                                                |
| `evicted`          | It finished: the session is out of memory                                        |
| `eviction_failed`  | It did not: `code` is the save's error code, or `SESSION_IN_USE`                 |
| `unloaded`         | A handle was unloaded, by eviction, `close()`, `shutdown()` or registry shutdown |

An event carries the session id, the time and at most an error code. It never carries a token, a
player, or any part of a game. A listener that throws is ignored. There is no logging framework:
the development server prints these lines and nothing else does.

### Shutting down

`server.shutdown()` on the multi-session server:

```
new connections refused
  → no new create, load, delete or evict; those under way are waited for
  → every session: room closed (its connections told and closed), saved once if unsaved, unloaded
  → store closed
  → listener stopped
```

It attempts every session whatever happens to the others, closes the store last and once, and
reports each session that could not be saved. Unlike an eviction, shutdown does not keep a
session whose save failed: the process is stopping, so the failure is returned and the handle
still says it has unsaved changes.

### Limits

- **One process.** The registry knows only its own memory. It does not coordinate with another
  process, and nothing stops two processes loading the same session.
- **No timer in the library.** Nothing is evicted unless something calls `evictIdle()` or
  `evict()`. Only `npm run sessions:dev` does so on a schedule.
- **Connecting loads.** Any connection to a stored session's address loads it, and it then stays
  for at least the idle time. Nothing limits how many sessions are loaded at once.
- **An idle session's clock does not run.** Nothing advances game time for a session nobody is
  connected to, loaded or not.

## Reconnecting

A player who loses their connection comes back with the message that already existed for it:

```
connect to  ws://host/sessions/<sessionId>     the address chooses the session
send        { "type": "resume", "token": … }   the token chooses the player in it
receive     { "type": "joined", "playerId": …, "state": … }
```

**A dropped socket removes nothing from the game.** The room forgets the connection: it gets no
more broadcasts and can send nothing. The player, their role, their score and their place stay
exactly as they were, the game is not paused, and nobody is told. Only leaving in the lobby, or
being removed by the host, takes a player out; that is unchanged.

**It works across a reload.** A session can be unloaded and loaded again between the drop and the
return, and the player is the same player:

```
room 1  ──  player drops  ──  session unloaded, room 1 closed for good
                                   ▼
player connects again  ──  registry loads the session  ──  room 2, new
                                   ▼
resume  ──  the same player id, with the state that was stored
```

- **Identity comes from the stored game.** Room 2 knows nothing of room 1. It is built around the
  restored `GameSession`, and a returning player is whoever the stored game says has that id:
  the same name, role, readiness and score. Nothing in memory is carried from the old room, and
  nothing a returning client does can reach the old room or the old session object.
- **What was not saved is not there.** A player whose join was never saved (the session was
  unloaded with `close()`, or the process died) is not in the stored game, and their token is
  `INVALID_TOKEN`.
- **The host token is not kept.** A reloaded session has a new host token, given to whoever
  holds the handle.

**How a token survives without being stored.** A registry does not use random player tokens. It
works each one out from three things:

| Input          | Why                                                             |
| -------------- | --------------------------------------------------------------- |
| A key          | Held in memory by the registry. Without it no token can be made |
| The session id | A token is for one session and is refused in every other        |
| The player id  | A token is for one player and says nothing about another's      |

The same three always give the same token (an HMAC-SHA-256), so a new room for the same session
accepts the token a player was given in an earlier one. No token, and nothing derived from one, is
written to the game state, a snapshot or the database, and the stored document is unchanged.

- By default the key is random and made with the registry. Tokens then last as long as that
  registry: they survive any number of unloads and reloads, and die with the process.
- `createSessionRegistry({ store, tokenKey })` and `startSessionServer({ store, port, tokenKey })`
  take a key instead (at least 32 random bytes). A later process given the same key and the same
  store accepts the same tokens. Nothing here reads such a key from the environment or generates
  and keeps one for you; an application that wants reconnection across restarts must supply it,
  and must treat it as the credential it is.

**What a token can and cannot do.**

| Presented                                         | Result                                     |
| ------------------------------------------------- | ------------------------------------------ |
| A player's own token, at their session's address  | `joined` as that player                    |
| An unknown, altered or truncated token            | `INVALID_TOKEN`                            |
| A token from another session                      | `INVALID_TOKEN`                            |
| A player id, or the host token, as a player token | `INVALID_TOKEN`                            |
| The token of a player who left or was removed     | `INVALID_TOKEN`                            |
| Any token, from a connection already a player     | `ALREADY_JOINED`                           |
| Any token, at the address of a deleted session    | `SESSION_NOT_FOUND` at connect; never read |
| Any token, while the server is shutting down      | `SESSION_CLOSED` at connect; never read    |

A refused resume changes nothing in the game and binds nothing. A token is still a bearer
capability, not authentication: whoever holds it is that player.

**Taking over a live connection.** If the player's earlier socket is still attached when they
resume, the new connection replaces it. The old one is unbound, sent `CONNECTION_REPLACED` and
closed, so a player never has two sockets that can act. Two resumes for the same player are
handled in the order the server reads them; the later one is the player and the earlier one is
closed.

**Timing.** These follow from what was already there, not from any wait or timeout:

- A room handles one frame at a time, so a command and a disconnect, or two resumes, cannot
  interleave.
- Connections that arrive together for an unloaded session share one load and one room.
- A connection that arrives while its session is making its final save waits for that save and
  resumes into what it stored.
- A session unloaded just after a resume closes that connection with the rest.

**Limits.**

- One process. Nothing here lets two processes serve one session, and a token works on another
  process only if that process was given the same key.
- A token cannot be changed or revoked while its player is in the game. If one leaks, the only
  remedy is removing the player.
- `startPersistentServer` still uses random per-room tokens, so reconnecting after that server
  restarts is not possible.
- A client is told nothing it missed while away except the current state in the `joined` reply.
  There is no replay of the updates in between.

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
over the network, join-code routing, a limit on loaded sessions, forced eviction, authentication,
stored tokens,
token rotation, replaying missed updates to a returning client, several servers sharing a game,
Redis, and any adjustment of a running game's clock on load.

## Dependencies

`@touchgrass/game-session`, `@touchgrass/session-store`, `@touchgrass/session-persistence`,
`@touchgrass/realtime`, `@touchgrass/game-engine`, `@touchgrass/shared`, `zod`.
