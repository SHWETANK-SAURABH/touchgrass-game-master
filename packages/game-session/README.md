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

interface GameSession {
  readonly id: string;
  getState(): GameState;
  submitAction(actorId, intent, ctx): Result<PlayerActionOutcome, EngineError>;
  advanceTime(ctx): Result<SessionUpdate, EngineError>;
  applyCommand(command, ctx): Result<SessionUpdate, EngineError>;
}

interface SessionUpdate {
  state: GameState;
  entries: HistoryEntry[]; // what the operation added to the history, in order
}
```

| Method         | Engine function      | Input                                                       |
| -------------- | -------------------- | ----------------------------------------------------------- |
| `submitAction` | `submitPlayerAction` | The acting player's id from the caller; an untrusted intent |
| `advanceTime`  | `advanceTime`        | The time, supplied by the caller                            |
| `applyCommand` | `reduce`             | A host command, from a trusted caller                       |

## What it guarantees

- **One state, owned here.** The initial state is created by the engine from the create command. No
  method accepts a state, so a caller cannot supply or select one.
- **Replace on success only.** If the engine refuses, the stored state is not replaced: it is the
  very same object as before.
- **Sequential by being synchronous.** Each operation reads the state, calls the engine and stores
  the result without yielding. Two operations on one session cannot interleave, so there is no
  queue or lock. Nothing in the API returns a promise.
- **Read-only state.** Each stored state is frozen all the way down. `getState()` can be read and
  passed on; writing to it throws and changes nothing.
- **Independent sessions.** Each session is its own closure. There is no module-level state.
- **The actor comes from the caller.** `submitAction` takes the actor id as its own argument. The
  intent is the client's message; it cannot name an actor and cannot express a host command.
- **Replay still works.** A game run through a session reaches exactly the state `replay()` reaches
  from the same recorded inputs. No state field, action field or event kind was added.

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
- **Not storage.** In memory only. A restart loses every game, and a session cannot be rebuilt from
  a saved state.
- **Not a registry.** There is no lookup by id or join code. `id` identifies the object and nothing
  more.
- **No authentication.** It trusts the actor id it is given.
- **No duplicate detection.** The same message submitted twice is processed twice and judged by the
  rules each time.
- **Not connected to the Game Master.** Nothing here calls a model or the safety validator.

## Dependencies

`@touchgrass/game-engine` and `@touchgrass/shared` only.
