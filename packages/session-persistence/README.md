# @touchgrass/session-persistence

The application-level lifecycle between a running game and a store: three explicit operations for
loading, saving and deleting a session.

```
loadSession    SessionStore.load → restoreGameSession → GameSession
saveSession    session.snapshot() → SessionStore.save
deleteSession  SessionStore.delete
```

A `GameSession` owns a running game and does not know stores exist. A `SessionStore` keeps snapshots
and does not know what a game is. This package is the code that calls both, and it does so only when
a caller asks.

**A saved session is exactly as durable as the store it was saved to.** `InMemorySessionStore` loses
everything when the process stops. `MongoSessionStore` keeps snapshots in MongoDB. These functions
work the same with either and cannot tell them apart. Nothing in the project creates a MongoDB store
or calls these functions yet.

```ts
import { InMemorySessionStore } from '@touchgrass/session-store';
import { deleteSession, loadSession, saveSession } from '@touchgrass/session-persistence';

const store = new InMemorySessionStore();

const saved = await saveSession(store, session);
if (!saved.ok) {
  // The session is unchanged and still usable. It was not saved.
}

const loaded = await loadSession(store, 'g1');
if (loaded.ok) {
  loaded.value.submitAction(actorId, intent, ctx); // a GameSession, carrying on
} else if (loaded.error.code === 'SESSION_NOT_FOUND') {
  // Nothing was created. Starting a new game is the caller's decision.
}

await deleteSession(store, 'g1');
```

## API

```ts
loadSession(store, sessionId): Promise<Result<GameSession, SessionPersistenceError>>
saveSession(store, session): Promise<Result<void, SessionPersistenceError>>
deleteSession(store, sessionId): Promise<Result<void, SessionPersistenceError>>

interface SessionPersistenceError {
  code: 'INVALID_SESSION_ID' | 'SESSION_NOT_FOUND' | 'STORAGE_ERROR' | 'INVALID_SNAPSHOT';
  message: string;
  cause?: { code: string; message: string }; // the error from the layer underneath
}
```

The store is an argument to every call. Nothing rejects: a failure is a value.

| Code                 | Meaning                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `INVALID_SESSION_ID` | The id is not one a session could have. The store was not asked                   |
| `SESSION_NOT_FOUND`  | The store has no snapshot for this session. Nothing was created                   |
| `STORAGE_ERROR`      | The store could not complete the operation, or failed without saying why          |
| `INVALID_SNAPSHOT`   | A stored snapshot was refused by `restoreGameSession`; `cause` carries the reason |

## Load

- A session that was never saved is `SESSION_NOT_FOUND`. It is not created.
- A snapshot that is found is given to `restoreGameSession`, which validates it. If it is refused,
  the result is `INVALID_SNAPSHOT` with the session boundary's reason in `cause`, and no session is
  returned.
- The store is only read. A snapshot that cannot be restored is left where it is.
- The result is a `GameSession`, not a state. Each load builds a new, independent session; nothing
  remembers the ones loaded before.

## Save

- `saveSession` takes a `GameSession`, not a state or a snapshot. It asks the session for its
  snapshot, so what is saved is what the session says it is.
- The store is called once. There is no retry, immediate or later.
- It saves the session as it is at that moment. Later changes are not saved until it is called
  again.

## Delete

- It removes the stored snapshot and touches nothing else. A session that is still running is not
  stopped or changed, and can be saved again.
- Deleting a session that was never saved succeeds, as it does in the store.

## Who is right about what

- **While a game runs, the `GameSession` is the authority.**
- **The store holds the latest snapshot that was successfully saved,** and nothing newer.

Changing a game and saving it are two separate steps. **There is no atomic "apply action and persist"
transaction.** If an action is accepted and the save that follows fails:

1. the live session keeps the change;
2. the store keeps the older snapshot;
3. the caller is told the save failed.

Nothing is rolled back and nothing pretends to have succeeded. The live state and the stored state
can therefore differ until a later save succeeds. That is the expected behaviour of this phase, not
a fault in it.

## Saving is explicit

Nothing saves on its own. There is no autosave, timer or background work. `submitAction`,
`advanceTime` and `applyCommand` do not save, and the realtime layer does not save on an action, a
host command, a tick, a join, a leave, a resume or a disconnect. When to call `saveSession` is the
caller's decision, and no caller in this project does so yet.

## What it does not keep

- **No session registry.** There is no table of sessions and no module-level state. The caller holds
  the `GameSession` it created or loaded.
- **Nothing of the transport.** Connections, player tokens and the host token are held by the
  realtime room and are not in a snapshot, so they are not saved and do not come back on a load.

## Not here

Redis, autosave, retries, transactions, version checks between saves, locks, expiry,
migrations, an event log, and restoring a session when a client connects. Those are later decisions.

## Dependencies

`@touchgrass/game-session`, `@touchgrass/session-store`, `@touchgrass/shared`. Nothing depends on
this package.
