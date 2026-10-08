# @touchgrass/session-store

The persistence boundary for game sessions: an interface for saving and loading session snapshots,
and an in-memory implementation of it.

**No database is connected.** The only implementation keeps snapshots in the memory of one process.
It is not durable. A MongoDB store is deliberately deferred to a later phase.

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
resume or a disconnect. Application code that takes a snapshot and gives it to a store is still to
be written, and when to save is that code's decision.

## InMemorySessionStore

For tests, for local development, and as the reference for how a store behaves.

- All state is inside the instance. Two stores share nothing, and there is no module-level state.
- Each snapshot is kept as its JSON text and parsed afresh on every load, which is what gives the
  copy behaviour above. A snapshot that cannot be serialised is refused with `STORAGE_ERROR`.
- A loaded snapshot is frozen all the way down, like the one a session hands out.
- No timer, no background work, no file, no network.

**It is not production persistence.** Everything in it is gone when the process stops.

## Not here

MongoDB, Redis, files, retries, locking, expiry, migrations, autosave, a session registry, and any
record of events beyond the history already inside the game state. Those are later decisions.

## Dependencies

`@touchgrass/game-session` (for the snapshot type) and `@touchgrass/shared`.
