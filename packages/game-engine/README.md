# @touchgrass/game-engine

The deterministic authority: the only thing that can change a game. Full documentation is in
[GAME_ENGINE.md](./GAME_ENGINE.md).

```
PlayerAction → validation → action processing → GameEvent(s) → event application
             → scoring → win evaluation → GameState
```

Tag and Hide & Seek are fully playable through the engine with no AI.

Phase 5A establishes the deterministic multiplayer command boundary. Transport is implemented later.

```
Client → intent + actor id → PlayerAction → deterministic engine → GameEvent → GameState
```

A client sends an intent that says what, never who. `submitPlayerAction(state, actorId, intent, ctx)`
attaches the actor the caller resolved, runs the same validation as every other action, and returns
the new state with the history entries that were added. AI proposals and player actions are two
separate inputs to the deterministic engine.

## Modules

| Module               | Contains                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- |
| `state.ts`           | `GameState`, `PlayerState`, history, timer, the lifecycle transition table            |
| `actions.ts`         | `PlayerAction` union and `parsePlayerAction`; `PlayerIntent`, what a client may send  |
| `events.ts`          | `GameEvent` union (thirteen kinds) and `parseGameEvent`                               |
| `modifiers.ts`       | `ActiveModifier` and `ActiveObjective`                                                |
| `validate.ts`        | `validatePlayerAction`, `validateGameEvent` — checks only, no state change            |
| `process-action.ts`  | Valid action → the events it causes; readiness and game start                         |
| `apply-event.ts`     | Event application: where scores, roles in play and status change                      |
| `scoring.ts`         | Points that follow from an event, from the game definition                            |
| `win-conditions.ts`  | `evaluateWinners`                                                                     |
| `time.ts`            | `advanceTime`: round expiry, next round, game end, expiry of modifiers                |
| `reduce.ts`          | Host commands: create, join, leave, phase, pause, resume, abort                       |
| `engine.ts`          | `step`, `replay`, `submitGameEvent`, `contextAt`                                      |
| `external-events.ts` | `validateExternalEvent`, `applyValidatedEvent`: the trust boundary for outside events |
| `submit-action.ts`   | `submitPlayerAction`: the command boundary for a client intent and its actor          |
| `roles.ts`           | Seeded role assignment at start                                                       |
| `errors.ts`          | `EngineError` and its codes                                                           |

## Using it

```ts
import { fixedClock } from '@touchgrass/shared';
import {
  contextAt,
  createSession,
  processPlayerAction,
  advanceTime,
} from '@touchgrass/game-engine';

const ctx = contextAt(fixedClock(1_700_000_000_000));
const created = createSession(
  { type: 'CREATE_SESSION', sessionId: 'g1', gameId: 'tag', joinCode: 'GRASS7', randomSeed: 7 },
  ctx,
);
```

Every entry point takes the state, an input, and a context carrying the time, and returns
`Result<GameState, EngineError>`. The engine never reads a clock; the caller says what time it is.

## Properties, each pinned by tests

- **Pure.** No `Date.now()`, no `Math.random()`, no timers, no I/O, and no import from
  `@touchgrass/ai`.
- **Replayable.** Replaying the same inputs produces an identical state.
- **Fails closed, as a value.** A refusal is an `EngineError` returned through `Result`, and the
  caller's state is untouched.
- **A client cannot name its own actor.** An intent has no `playerId`, and one that carries it is
  refused. The transport supplies actor identity; the client does not. `PlayerIntent` is untrusted
  input; `PlayerAction` is the recorded domain action, actor included.
- **Host commands are outside that boundary.** `reduce` names no actor; exposing commands to
  clients needs a separate authorised boundary that does not exist yet. Recognising a message
  delivered twice is likewise left to the future transport.
- **One state, one input at a time.** The engine never writes to the state it is given; the caller
  holds the authoritative state and feeds inputs in order.
- **Stopping is never blocked.** `ABORT_SESSION` is legal from every non-terminal status.
