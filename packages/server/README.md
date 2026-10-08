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

**This is a development-stage server.** One process serves one game. There is no authentication,
the socket is unencrypted, and it is not deployed anywhere.

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

A new game is saved once, when it is created. After that **nothing is saved unless you type `save`**
in the terminal. `quit` stops the server; stopping does not save.

The terminal is the only way to ask for a save. There is no network command for it, because nothing
authenticates who would be asking. Exposing save, load or delete to clients needs an authentication
decision first.

## API

```ts
createPersistentSessions(store): PersistentSessions
// { create(command, ctx), load(sessionId), save(session), delete(sessionId) }

hostSession(session): { session, room, hostToken }

startPersistentServer({ store, game, port, clock? }): Promise<Result<PersistentServer, …>>
// game: { create: command } | { load: sessionId }
// PersistentServer: { session, room, hostToken, port, save(), hasUnsavedChanges(), close() }

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

Errors are the persistence lifecycle's own: `INVALID_SESSION_ID`, `SESSION_NOT_FOUND`,
`STORAGE_ERROR`, `INVALID_SNAPSHOT`. No driver error reaches this layer.

## Persistence is explicit

Saving happens in two places only: once when a game is created, and when `save()` is called.

No join, action, host command, tick, leave, resume or disconnect saves anything. The room and the
session do not know a store exists. So the stored game is whatever it was at the last successful
save, and a running game is usually ahead of it. If the process stops, everything since the last
save is lost.

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
- `close()` stops the realtime server and then closes the store. A server that failed to start does
  not close the store it was given.

## No registry

There is no table of sessions, rooms or stores, and no module-level state. A caller is handed a
`GameSession` and holds it. Loading the same id twice gives two independent sessions; nothing stops
both being played and saved, and the last save wins.

## Tests

The tests use the in-memory store and need no database. One file runs the full flow against a real
MongoDB server, but only when asked:

```
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
```

Without `MONGODB_TEST_URI` it is skipped. With it, it uses a database with a random name and drops
it afterwards.

## Not here

Autosave, saving per action, retries, transactions, revision checks, locks, a session registry,
authentication, stored tokens, reconnecting old clients after a restore, several servers sharing a
game, Redis, and any adjustment of a running game's clock on load.

## Dependencies

`@touchgrass/game-session`, `@touchgrass/session-store`, `@touchgrass/session-persistence`,
`@touchgrass/realtime`, `@touchgrass/game-engine`, `@touchgrass/shared`, `zod`.
