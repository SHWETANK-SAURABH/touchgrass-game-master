# @touchgrass/game-session

The in-memory holder of one game's authoritative state.

The engine (`@touchgrass/game-engine`) is a set of pure functions and keeps nothing. This package
keeps the state between inputs and makes sure there is only one of it. It adds no rules: every
change is one call to one engine function.

```ts
import { createGameSession } from '@touchgrass/game-session';

const created = createGameSession(
  { type: 'CREATE_SESSION', sessionId: 'g1', gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
  ctx,
);
if (!created.ok) return created.error;
const session = created.value;

session.applyCommand({ type: 'ADD_PLAYER', playerId: 'p0', displayName: 'Ada' }, ctx);
session.submitAction('p0', { type: 'PLAYER_READY' }, ctx);
session.advanceTime(ctx);
session.getState();
```

## API

```ts
createGameSession(command, ctx): Result<GameSession, EngineError>
restoreGameSession(snapshot): Result<GameSession, EngineError>

interface GameSession {
  readonly id: string;
  getState(): GameState;
  snapshot(): GameSessionSnapshot;
  submitAction(actorId, intent, ctx): Result<PlayerActionOutcome, EngineError>;
  advanceTime(ctx): Result<SessionUpdate, EngineError>;
  applyCommand(command, ctx): Result<SessionUpdate, EngineError>;
}

interface SessionUpdate {
  state: GameState;
  entries: HistoryEntry[]; // what the operation added to the history, in order
}

interface GameSessionSnapshot {
  version: 1;
  sessionId: string; // always equal to state.id
  state: GameState; // the authoritative state, history included
}
```

| Method         | Engine function      | Input                                                       |
| -------------- | -------------------- | ----------------------------------------------------------- |
| `submitAction` | `submitPlayerAction` | The acting player's id from the caller; an untrusted intent |
| `advanceTime`  | `advanceTime`        | The time, supplied by the caller                            |
| `applyCommand` | `reduce`             | A host command, from a trusted caller                       |

## What it guarantees

- **One state, owned here.** A session's state is either created by the engine from the create
  command or rebuilt from a snapshot that passes validation. No method of a session accepts a state,
  so a caller cannot supply or select one once it exists.
- **Replace on success only.** If the engine refuses, the stored state is not replaced: it is the
  very same object as before.
- **Sequential by being synchronous.** Each operation reads the state, calls the engine and stores
  the result without yielding. Two operations on one session cannot interleave, so there is no
  queue or lock. Nothing in the API returns a promise.
- **Read-only state.** Each stored state is frozen all the way down. `getState()` can be read and
  passed on; writing to it throws and changes nothing.
- **The state object changes exactly when the game does.** Every accepted action, command or time
  advance that changes the game gives a new state object. A refused operation, a time advance when
  nothing is due, a read and a snapshot all leave `getState()` returning the very same object. So
  `before !== session.getState()` is an exact test for "the game changed", and code outside this
  package may rely on it; `@touchgrass/server` does, to know whether a game has unsaved changes. The
  session itself keeps no revision number and no changed flag.
- **Independent sessions.** Each session is its own closure. There is no module-level state.
- **The actor comes from the caller.** `submitAction` takes the actor id as its own argument. The
  intent is the client's message; it cannot name an actor and cannot express a host command.
- **Replay still works.** A game run through a session reaches exactly the state `replay()` reaches
  from the same recorded inputs. No state field, action field or event kind was added.

## Snapshot and restore

This is the boundary a future persistence layer uses. It saves and loads; it decides nothing about
the game.

```ts
const snapshot = session.snapshot(); // plain, frozen data
const text = JSON.stringify(snapshot); // store it anywhere

const restored = restoreGameSession(JSON.parse(text));
if (!restored.ok) return restored.error;
restored.value.submitAction(actorId, intent, ctx); // carries on where it was
```

**A snapshot is a labelled `GameState`.** It holds the layout version, the session id and the
state. Nothing else exists that would need saving: a session's only mutable thing is its one state.

**The authoritative history is `state.history`.** The engine appends an entry there for every
command, action and event it applies, numbered from 0 with no gaps. A snapshot does not keep a
second copy of it or any other log, and nothing else in this project keeps one either. Whatever a
store wants to know about what happened, it reads from the state.

**A snapshot is read-only.** It is frozen all the way down, like `getState()`. Writing to it throws
and changes nothing in the session. It survives `JSON.stringify` and `JSON.parse` unchanged, and the
same session always produces the same bytes.

**Restoring validates before it accepts.** `restoreGameSession` treats its input as untrusted and
refuses it, creating nothing, unless:

1. it has exactly the fields of a snapshot, at the version this code reads;
2. its state passes the engine's `gameStateSchema`, which also rejects a state that contradicts
   itself (gaps in the history numbering, duplicate ids, an end time on a game that has not ended,
   and so on);
3. the session id matches the state's id;
4. the engine has a definition for the game, and the state carries that definition's settings. This
   is checked by asking the engine to create a fresh session of the same game and comparing;
5. the history begins with the creation of the session and its times never go backwards;
6. the engine has nothing to do to the state at its own latest time: no round that had already run
   out and no modifier that had already expired.

A refusal is `INVALID_GAME_STATE`, or `INVALID_GAME_CONFIGURATION` when the game is unknown. It never
throws.

**A restored session holds its own copy** and shares nothing with what it was given. From that point
it behaves exactly as the original would have: the same inputs give the same states.

**What restoring cannot check.** The history does not record enough to replay a game from it (a join
entry has no display name, for instance), so restore cannot prove that the history and the rest of
the state agree. A snapshot whose shape is valid but whose score was edited is accepted. Snapshots
must be kept where only trusted code can write them.

**What is not in a snapshot.** Connections, player tokens, the host token and anything else the
realtime layer holds. None of it is in `GameState`, so none of it can be saved here. After a restore
every player is still in the game, but no token issued before it works: a new room starts with none.

**Where a snapshot goes.** `@touchgrass/session-store` defines the `SessionStore` interface for
saving and loading snapshots. This package does not depend on it, takes no store anywhere, and never
saves itself.

**The history is not bounded.** It grows by at least one entry per accepted input for as long as a
game runs, and a snapshot is always the whole of it. No retention or compaction rule exists, and none
was added, because dropping entries would change what the state says happened. For a 3-round game
this is small. It needs a decision before long-running games or frequent saves.

## Player actions and host commands are separate

`submitAction` is for players. `applyCommand` is a **trusted control-plane call**: joining, leaving,
phase changes, pause, resume and abort. A command names no actor and the game records no host, so
this package does not and cannot check who is asking. Nothing a player sends through `submitAction`
can become a command. Whoever exposes `applyCommand` to anything outside the server must decide who
is allowed to call it first; that authorisation does not exist yet.

## What it is not

- **Not a server.** No WebSocket, HTTP, connection, or broadcast. It returns the new state and the
  added history entries; sending them anywhere is someone else's job.
- **Not a clock.** There is no timer or background loop. A game moves forward in time only when a
  caller passes a time to `advanceTime` or to another operation. A game nobody advances stays where
  it is.
- **Not storage.** In memory only. It can produce a snapshot and be rebuilt from one, but it writes
  and reads nothing: no database, no file, no timer. Unless something else stores a snapshot, a
  restart loses every game.
- **Not a registry.** There is no lookup by id or join code. `id` identifies the object and nothing
  more.
- **No authentication.** It trusts the actor id it is given.
- **No duplicate detection.** The same message submitted twice is processed twice and judged by the
  rules each time.
- **Not connected to the Game Master.** Nothing here calls a model or the safety validator.
  `applyEvent(validated, ctx)` applies an external event the engine has already validated, through
  the engine's own `applyValidatedEvent`, which refuses anything it did not issue for this game as
  it stands. It is for trusted callers; a caller acting for a Game Master passes only what the
  safety package released.

## Dependencies

`@touchgrass/game-engine` and `@touchgrass/shared` only.
