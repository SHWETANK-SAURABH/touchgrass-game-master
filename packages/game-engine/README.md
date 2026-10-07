# @touchgrass/game-engine

The deterministic authority. The **only** thing that can change a session.

```ts
reduce(state: SessionState, command: SessionCommand, ctx: EngineContext): Result<SessionState, EngineError>
```

## Three properties, each pinned by tests

**Pure.** No `Date.now()`, no `Math.random()`, no I/O, and no import from `@touchgrass/ai`. The clock
arrives in `EngineContext`; randomness comes from a seed stored on the session. A test asserts
`reduce` never mutates the state it was given.

**Replayable.** `replay()` re-runs a command list from scratch, and a test asserts two replays produce
byte-identical state. This is what lets a future persistence layer store commands instead of
snapshots, and lets a disputed call be settled by re-running the log.

**Fails closed, as a value.** Illegal commands return a typed `EngineError` — one of nine codes —
rather than throwing or silently no-op'ing.

## `proposal.ts` — the AI → engine contract

The narrow waist of the whole product, and the reason the dependency direction runs this way: **the
engine owns the schema the AI package must satisfy**, so the engine can be read and trusted without
opening a line of AI code.

Seven event kinds in a strict discriminated union. No free-form data bag, no coordinate fields,
length-bounded strings, bounded durations and score deltas, a required `rationale`, and at most three
proposals per turn.

## Deliberate design notes

- `ABORT_SESSION` is legal from **every** non-terminal status, including the lobby. Stopping a game is
  never blocked by a state check.
- `REMOVE_PLAYER` marks a player inactive rather than deleting the record, so the log stays readable
  and a score other entries refer to is not erased.
- Role assignment lives here, not in the model: who chases whom is a fairness decision with hard
  constraints, not a creative one.

## Not implemented yet

`APPLY_GAME_MASTER_EVENT` — the command that carries a Zod-validated, safety-approved proposal into
state. Phase 2. The `modifiers` array and the `'game-master'` log provenance already exist waiting for
it.
