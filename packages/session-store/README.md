# @touchgrass/session-store

The persistence boundary for game sessions: an interface for saving and loading session snapshots,
and two implementations of it.

| Implementation         | Keeps snapshots in        | For                                        |
| ---------------------- | ------------------------- | ------------------------------------------ |
| `InMemorySessionStore` | The memory of one process | Tests, local development, the reference    |
| `MongoSessionStore`    | A MongoDB collection      | Persistence, once something is wired to it |

**This package connects to nothing on its own.** A store is created by application code, which
passes in its configuration. In this project that is `@touchgrass/server`, whose development entry
point makes a `MongoSessionStore`. No MongoDB instance is provisioned, and nothing saves
automatically.

```
GameSession → snapshot() → SessionStore.save(snapshot)
SessionStore.load(sessionId) → restoreGameSession(snapshot) → GameSession
```

```ts
import { restoreGameSession } from '@touchgrass/game-session';
import { InMemorySessionStore } from '@touchgrass/session-store';

const store = new InMemorySessionStore();

await store.save(session.snapshot());

const loaded = await store.load(session.id);
if (loaded.ok && loaded.value) {
  const restored = restoreGameSession(loaded.value); // validated here, not by the store
}

await store.delete(session.id);
```

## The interface

```ts
interface SessionStore {
  save(snapshot: GameSessionSnapshot): Promise<Result<void, SessionStoreError>>;
  load(sessionId: string): Promise<Result<GameSessionSnapshot | null, SessionStoreError>>;
  delete(sessionId: string): Promise<Result<void, SessionStoreError>>;
}

interface SessionStoreError {
  code: 'INVALID_SESSION_ID' | 'STORAGE_ERROR';
  message: string;
}
```

- **`save`** stores a snapshot under its own `sessionId`, replacing any snapshot already stored for
  that id. There is one snapshot per session, not a list.
- **`load`** returns the stored snapshot, or `null` if there is none.
- **`delete`** removes it. Deleting a session that is not there succeeds and changes nothing.
- Every method is asynchronous, because a real store talks to something over a network, and none
  rejects: a failure is a value.

It names no database. An implementation turns whatever goes wrong underneath into one of the two
codes; no driver type or driver error crosses this interface.

| Error                | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `INVALID_SESSION_ID` | The id is not one a session could have. Nothing was read or written |
| `STORAGE_ERROR`      | The store could not complete the operation                          |

## What a store is responsible for

**Keeping snapshots, and nothing else.** A store never sees a live `GameSession`. The session
remains the source of truth for a running game; a store holds a picture of one moment of it.

**Its key.** A session id is a non-empty string. That is the rule the engine already applies when a
game is created and to the id in a game state, not a new format. `parseSessionId` is that check, for
other implementations to reuse.

**Not the game.** A store applies no game rule and does not judge whether a snapshot is a valid
game. It keeps what it is given and gives it back. `restoreGameSession` validates a snapshot when it
is turned back into a session, so a damaged snapshot is refused there.

**Copies.** A store keeps its own copy of a snapshot: changing the object that was saved does not
change what is stored. Every load returns a separate copy.

## What is and is not stored

A snapshot is `{ version, sessionId, state }`, where `state` is the game's `GameState` including its
history. That is all a store holds.

Not stored, because none of it is in a snapshot: player tokens, the host token, connections, and
anything else the realtime layer keeps. Bearer capabilities therefore do not survive a restore.
After one, every player is still in the game and none of their tokens work.

## Nothing saves automatically

No package calls a store. The session does not know stores exist and has no store parameter, hook or
callback. The realtime layer does not save on an action, a host command, a tick, a join, a leave, a
resume or a disconnect. `@touchgrass/session-persistence` provides the explicit operations that
take a session's snapshot to a store and back; when to call them is the caller's decision, and
nothing calls them yet.

## InMemorySessionStore

For tests, for local development, and as the reference for how a store behaves.

- All state is inside the instance. Two stores share nothing, and there is no module-level state.
- Each snapshot is kept as its JSON text and parsed afresh on every load, which is what gives the
  copy behaviour above. A snapshot that cannot be serialised is refused with `STORAGE_ERROR`.
- A loaded snapshot is frozen all the way down, like the one a session hands out.
- No timer, no background work, no file, no network.

**It is not production persistence.** Everything in it is gone when the process stops.

## MongoSessionStore

An adapter that keeps snapshots in MongoDB, using the official `mongodb` driver. It implements the
same `SessionStore` interface and passes the same contract tests as the in-memory store, so code
that uses a store cannot tell which one it has.

It is imported from its own entry point, so nothing else loads the driver:

```ts
import { createMongoSessionStore } from '@touchgrass/session-store/mongodb';

const store = createMongoSessionStore({
  uri: 'mongodb://localhost:27017', // from configuration; never hard-coded or logged
  databaseName: 'touchgrass',
  collectionName: 'sessions', // optional; this is the default
});

await saveSession(store, session); // the same lifecycle functions as with any store
await store.close();
```

**It is persistence only.** It stores a snapshot, returns one and deletes one. It does not create or
restore a `GameSession`; `@touchgrass/session-persistence` does that, by passing a loaded snapshot to
`restoreGameSession`. It does not validate the game either: a malformed but storable snapshot is
kept, and refused later on restore.

**One session is one document.**

```
{ _id: <session id>, version: <snapshot version>, state: <GameState> }
```

- The session id is the document's `_id`. MongoDB already keeps `_id` unique and indexed, so no
  other index is created and the id is not stored twice.
- `_id` never appears in a loaded snapshot, which has `sessionId` again.
- The document holds the snapshot and nothing else. Player tokens, the host token and connections
  are not in a snapshot and are not stored. Fields that are not part of a snapshot are dropped.
- There is one collection. There is no collection for events, players, tokens or rooms.

**Operations.**

- `save` replaces the document with that id, or inserts it if there is none: a single upsert. The
  last successful save wins. There is no revision check, lock or transaction.
- `load` finds the document by id and returns a new, frozen, plain snapshot, or `null`.
- `delete` removes the document by id. Deleting one that is not there succeeds.
- Each operation is attempted once. The driver's own automatic retry of reads and writes is switched
  off, and the adapter never retries.

**Errors.** Whatever the driver throws becomes `STORAGE_ERROR` with a fixed message. The driver's
error, with its name, stack, host and connection string, does not leave the adapter.

**Connection.**

- Creating a store does nothing: no client is made and no connection is opened, so importing the
  module or constructing a store reaches no network and cannot fail.
- The first operation creates one client, which the store keeps and reuses for every operation.
- Each store owns its own client. Nothing is shared between stores or kept at module level.
- `close()` lets go of the connection. Afterwards every operation returns `STORAGE_ERROR`; a closed
  store does not reconnect. Closing twice, or without ever having connected, does nothing.

**Limits.**

- A MongoDB document cannot exceed 16 MB. A snapshot holds a game's whole history, which is not
  bounded, so a long enough game would fail to save.
- The driver waits up to its own default (30 seconds) for a server that cannot be reached before an
  operation fails. No shorter limit is configured here; it can be set in the connection string.
- The connection string is used as given. Encryption and credentials are whatever it specifies.
- Ids are arbitrary strings, and player ids appear as object keys in a game's history. Keys that
  contain a dot or start with a dollar sign are stored exactly as they are and come back unchanged.
  The adapter never renames or escapes a key. This relies on the server accepting such field names,
  which MongoDB has done since version 5.0 and which is tested against 8.0. A server that refuses
  them fails the save with `STORAGE_ERROR`, and nothing is stored in an altered form.

### Tests

The adapter's tests run without a database: they use a stand-in collection that keeps documents as
BSON bytes, encoded and decoded with the driver's own BSON library.

The same contract suite also runs against a real server, but only when asked:

```
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
```

Without `MONGODB_TEST_URI` those tests are skipped, so `npm run verify` needs no MongoDB. With it,
they use a database with a random name and drop it afterwards.

## Not here

Redis, files, retries, locking, revision checks, expiry, migrations, autosave, a session registry,
and any record of events beyond the history already inside the game state. Those are later
decisions.

## Dependencies

`@touchgrass/game-session` (for the snapshot type), `@touchgrass/shared`, and `mongodb`, which only
the adapter imports.
