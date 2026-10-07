# Game engine

> **Status: Phase 2B — deterministic execution.** Tag and Hide & Seek are fully playable through the
> engine with no AI: lifecycle, rounds, timer, actions, events, scoring and winners are implemented
> and tested. The other three games have valid definitions but no rules or scoring.

The engine is the only part of TouchGrass that can change a game. It has no dependency on a model,
a database, or a network, and it produces the same result on every machine.

---

## 1. The pipeline

```mermaid
flowchart TD
    PA["PlayerAction<br/>a player reports something"] --> AV["Action validation<br/>parsePlayerAction, validatePlayerAction"]
    AV --> AP["Action processing<br/>eventsForAction"]
    AP --> GE["GameEvent(s)"]

    EX["External event<br/>host, or a Game Master proposal"] --> EV["validateExternalEvent<br/>→ ValidatedGameEvent<br/>→ applyValidatedEvent"]
    EV --> GE

    T["Time<br/>advanceTime"] --> GE

    GE --> VE["Event validation<br/>validateGameEvent"]
    VE --> AE["Event application<br/>applyEvent"]
    AE --> SC["Scoring<br/>awardsForEvent"]
    SC --> WIN["Win evaluation<br/>evaluateWinners, on GAME_END"]
    WIN --> GS["GameState"]

    AV -. refused .-> X["EngineError<br/>a value, never thrown"]
    EV -. refused .-> X
    VE -. refused .-> X
```

| Step              | Module               | What it does                                                                              |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| Action validation | `validate.ts`        | Is this action allowed for this player, in this game, right now?                          |
| Action processing | `process-action.ts`  | Turns a valid action into the events the game's rules say it causes                       |
| Event validation  | `validate.ts`        | Is this event legal here? Applied to every event, whatever its origin                     |
| Event application | `apply-event.ts`     | Applies a validated event: the only place scores, roles in play, and player status change |
| Scoring           | `scoring.ts`         | Points that follow from the event, taken from the game definition                         |
| Win evaluation    | `win-conditions.ts`  | Decides the winners when the game ends                                                    |
| Time              | `time.ts`            | Ends rounds and the game when the supplied time says they are due                         |
| Host commands     | `reduce.ts`          | Join, leave, pause, resume, abort                                                         |
| External events   | `external-events.ts` | `validateExternalEvent`, `applyValidatedEvent`: the trust boundary for outside events     |
| Entry points      | `engine.ts`          | `step`, `replay`, `submitGameEvent`, `contextAt`                                          |

**An action is intent; an event is a fact.** No action schema has a score, role, or status field,
and every schema is strict, so a client has nowhere to put a state change.

Two actions are control actions and cause no event: `PLAYER_READY` sets the player's ready flag
(and starts the game once everyone is ready), and `PLAYER_ACCEPTED_EVENT` is recorded as an
acknowledgement and changes nothing else.

---

## 2. Game state

`GameState` is plain data and is enough to continue or replay the game on its own.

| Field                               | Meaning                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `id`, `joinCode`                    | Identity of this game                                                              |
| `gameId`                            | Which game definition is being played                                              |
| `status`                            | Lifecycle status (§3)                                                              |
| `phaseIndex`                        | Position in the definition's phase list                                            |
| `settings`                          | `totalRounds`, `roundDurationSeconds`, copied from the definition                  |
| `currentRound`                      | 0 before the first round                                                           |
| `timer`                             | `endsAt` and `pausedAt`, both epoch ms or null                                     |
| `players`                           | `PlayerState[]`: role, score, status (`active`, `out`, `left`), ready, held powers |
| `activeModifiers`                   | Zones, activated powers and freezes still in force, each with `expiresAt`          |
| `activeObjectives`                  | Challenges and bonus objectives that can still be completed                        |
| `history`                           | Every command, accepted action and applied event, in order                         |
| `winnerIds`                         | Set by the engine when the game completes                                          |
| `createdAt`, `startedAt`, `endedAt` | Epoch ms supplied by the caller                                                    |
| `randomSeed`                        | Seed for every random choice                                                       |

The schema also rejects inconsistent states: duplicate ids, a round beyond the total, gaps in
history, `endedAt` without a terminal status, a running round without an end time, `pausedAt`
without a pause, winners on a game that has not completed.

Each history entry records its `source` (`engine`, `human`, or `game-master`), what it was (a
command, an action, an event, or the role assignment), and the score awards it caused.

---

## 3. Lifecycle

```mermaid
stateDiagram-v2
    [*] --> lobby
    lobby --> starting: every present player is ready
    starting --> active: ROUND_START (round 1)
    active --> round_end: ROUND_END (timer ran out)
    round_end --> active: ROUND_START (next round)
    round_end --> completed: GAME_END (after the last round)
    active --> paused: PAUSE_SESSION
    paused --> active: RESUME_SESSION
    lobby --> aborted: ABORT_SESSION
    starting --> aborted: ABORT_SESSION
    active --> aborted: ABORT_SESSION
    round_end --> aborted: ABORT_SESSION
    paused --> aborted: ABORT_SESSION
    completed --> [*]
    aborted --> [*]
```

- **Starting needs no host.** When a `PLAYER_READY` makes every present player ready, and there are
  at least `minPlayers` of them, the engine assigns roles from the stored seed (`starting`) and
  applies `ROUND_START` for round 1 (`active`). Both happen in that same step.
- **Rounds end on time only.** When the timer runs out the engine applies `ROUND_END`, then either
  `ROUND_START` for the next round or, after the last round, `GAME_END`.
- **`starting` and `round_end` are passed through within one step.** They are never a resting state;
  they are visible in the history.
- **A paused game cannot complete.** It can only resume or be aborted. Time does not run while paused.
- **Abort is always possible** from any status that is not already terminal.
- **Nothing is accepted after `completed` or `aborted`.**

The table is `LIFECYCLE_TRANSITIONS` in `state.ts`. Status values are lower-case in code.

There is no start command and no complete command.

---

## 4. Deterministic time

The engine never reads a clock and has no timers. Every entry point takes an `EngineContext`:

```ts
interface EngineContext {
  now: number; // the engine's clock for this step, epoch ms
  nextEntryId: (sequence: number) => string;
}
```

`contextAt(clock)` builds one from a `Clock` in `@touchgrass/shared`; tests use `fixedClock`.

`advanceTime(state, ctx)` does everything that was due by `ctx.now`: it ends rounds whose `endsAt`
has passed, starts the next round or ends the game, and drops expired modifiers and objectives.
Commands, actions and external events all call it first, so nothing is processed against a round
that has already run out.

- **Events are stamped with the time they were due**, not the time the caller noticed. Advancing in
  one large step or many small ones gives an identical state; a test asserts this.
- **Several rounds can elapse in one advance.**
- **Time cannot go backwards**; that is refused.
- **Pause freezes the clock.** `PAUSE_SESSION` records `pausedAt`. `RESUME_SESSION` moves `endsAt` and
  every modifier and objective expiry forward by the length of the pause.
- **An expiry equal to `now` has expired.**

---

## 5. Player actions

| Action                       | Fields                       | Result                                         |
| ---------------------------- | ---------------------------- | ---------------------------------------------- |
| `PLAYER_READY`               | `playerId`                   | Ready flag set; may start the game. Lobby only |
| `PLAYER_TAGGED`              | `playerId`, `targetPlayerId` | `ROLE_CHANGE` with a `TAGGED` cause (Tag)      |
| `PLAYER_FOUND`               | `playerId`, `targetPlayerId` | `PLAYER_OUT` with reason `FOUND` (Hide & Seek) |
| `PLAYER_ACTIVATED_POWER`     | `playerId`, `powerId`        | `POWER_ACTIVATED`                              |
| `PLAYER_COMPLETED_CHALLENGE` | `playerId`, `challengeId`    | `OBJECTIVE_COMPLETED`                          |
| `PLAYER_ACCEPTED_EVENT`      | `playerId`, `eventId`        | Recorded only                                  |

Which event a tag or a find produces comes from the game's rule, not from the action name: a rule
with outcome `SWAP_ROLES` produces a `ROLE_CHANGE`, one with `TARGET_OUT` produces a `PLAYER_OUT`.

The engine cannot see the field. It does not check that a tag physically happened; it checks that
the report is one the rules allow from that player at that moment.

---

## 6. Game events

**The ten kinds of the project brief:**

| Event             | Fields                                                                 | Origin                             |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `ROUND_START`     | `round`, `durationSeconds`                                             | Engine only                        |
| `ROUND_END`       | `round`                                                                | Engine only                        |
| `GAME_END`        | `reason` (`ROUNDS_COMPLETE`)                                           | Engine only                        |
| `ZONE_CHANGE`     | `modifier` (`SAFE_ZONE` or `MOVING_ZONE`), `zone`, `durationSeconds`   | External                           |
| `CHALLENGE`       | `challengeId`, `description`, `playerIds`, `points`, `durationSeconds` | External                           |
| `POWER_UP`        | `playerId`, `powerId` — grants a power to hold                         | External                           |
| `RULE_MODIFIER`   | `modifier` (`FREEZE_PERIOD`), `roleIds`, `durationSeconds`             | External                           |
| `BONUS_OBJECTIVE` | `objectiveId`, `description`, `points`, `durationSeconds`              | External                           |
| `TIME_EXTENSION`  | `seconds`                                                              | External                           |
| `ROLE_CHANGE`     | `assignments`, optional `cause`                                        | External, or engine with a `cause` |

**Three engine-derived kinds, added in Phase 2B** because the ten cannot state these facts:

| Event                 | Fields                                   | Produced by                               |
| --------------------- | ---------------------------------------- | ----------------------------------------- |
| `PLAYER_OUT`          | `playerId`, `byPlayerId`, `reason`       | A find (or tag) under a `TARGET_OUT` rule |
| `POWER_ACTIVATED`     | `playerId`, `powerId`, `durationSeconds` | `PLAYER_ACTIVATED_POWER`                  |
| `OBJECTIVE_COMPLETED` | `playerId`, `objectiveId`, `points`      | `PLAYER_COMPLETED_CHALLENGE`              |

There is no event that sets a score or writes arbitrary state.

**What an external source may send.** Only the seven "External" kinds, and only those the game
definition lists. Lifecycle and derived kinds are refused, and so is a `ROLE_CHANGE` that carries a
`cause` — otherwise an outside event could claim to be a tag and collect its points.

**The trust boundary for external events** (`external-events.ts`). Schema-valid does not mean
game-valid: a well-formed event can name a player who is not in the game. So an outside event
reaches the reducer in two steps, and cannot skip the first:

```ts
validateExternalEvent(state, input, source, ctx): Result<ValidatedGameEvent, EngineError>
applyValidatedEvent(state, validated, ctx): Result<GameState, EngineError>
```

- `validateExternalEvent` takes untrusted input. It checks the schema, refuses engine-only kinds and
  causes, brings the game up to `ctx.now`, and then runs the same `validateGameEvent` rules used for
  every event: the players, roles and powers named must exist, a player must not already hold the
  power, role limits must hold, the modifier must be allowed, and a round must be running. It
  changes nothing.
- The game definition is always the registered one for the state's game id. A caller cannot pass
  its own, so a modified copy of a definition cannot widen what is accepted.
- A `ValidatedGameEvent` can only come from that function. It is bound to the state it was checked
  against. `applyValidatedEvent` refuses a look-alike object or a copy, an event validated for
  another game, one validated on a different branch of the same game, and one validated before the
  game moved on (including into the next round). A state reloaded from storage counts as a different
  state: validate again after loading.
- "Validated" means legal in the game. It does not mean safe; the engine has no safety check.
- `applyValidatedEvent` then applies it, validating once more as every application does.
- Nothing is repaired: an unknown player, role or power is a refusal, and the state is untouched.

`submitGameEvent` is those two calls in a row, for callers that do not need to see the validated
event.

**What each event does when applied:**

| Event                 | Effect                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `ROUND_START`         | Status `active`; sets the round and the timer; players who were out are back in |
| `ROUND_END`           | Status `round_end`; clears the timer; round scoring                             |
| `GAME_END`            | Status `completed`; sets `endedAt` and `winnerIds`                              |
| `ZONE_CHANGE`         | Adds a zone to `activeModifiers` until it expires                               |
| `RULE_MODIFIER`       | Adds a freeze to `activeModifiers` until it expires                             |
| `CHALLENGE`           | Adds an objective for the named players                                         |
| `BONUS_OBJECTIVE`     | Adds an objective open to everyone                                              |
| `OBJECTIVE_COMPLETED` | Marks the player as having completed it; awards its points                      |
| `POWER_UP`            | Adds the power to the player's held powers                                      |
| `POWER_ACTIVATED`     | Moves the power from held to `activeModifiers` with its expiry                  |
| `TIME_EXTENSION`      | Moves the round's end time later                                                |
| `ROLE_CHANGE`         | Sets the named players' roles; with a `TAGGED` cause, awards `TAG_MADE`         |
| `PLAYER_OUT`          | Sets the player's status to `out`; awards `FOUND_PLAYER`                        |

**Stored but not enforced.** A zone and a freeze period are recorded and expire, and nothing more.
The engine cannot see where players are, and no behaviour was approved for `FREEZE_PERIOD`, so it
does not block any action. A test pins this.

### Why events are deterministic

- **Complete.** Every value needed to apply an event is in the event, the game definition, or the
  state. Nothing is asked what was meant.
- **Closed.** Thirteen shapes, no free-form data field, strict schemas.
- **Bounded.** Durations 5–600 s, points 1–10, extension 5–300 s, 10 rounds, 4 role assignments.
  These are validation limits, not game rules.
- **No time or randomness of their own.** An event carries a duration; the expiry is computed from
  the time passed to the engine.
- **A zone is words, not a position.** There are no coordinate fields.

---

## 7. Tag

| Rule    | Value                                                               |
| ------- | ------------------------------------------------------------------- |
| Players | 2–4: exactly one tagger, everyone else a runner                     |
| Rounds  | 3 rounds of 180 seconds                                             |
| Tagging | The tagger reports tagging a runner; they swap roles (`SWAP_ROLES`) |
| Scoring | `TAG_MADE` +2 to the tagger; `ROUND_SURVIVED` +1 at round end       |
| Power   | `shield`: `TAG_IMMUNITY` for 20 seconds once activated              |
| Winner  | `HIGHEST_SCORE`                                                     |

- **`ROUND_SURVIVED`** goes to every player who is a runner when the round ends and was not tagged
  during that round. A player who started the round as tagger, tagged someone, and was not tagged
  back therefore earns it.
- **A shield** is granted by a `POWER_UP` event and held until its holder activates it. Holding one
  gives no protection. While active, a tag on its holder is refused. It protects only its holder and
  lapses exactly 20 seconds after activation. A player cannot be given a shield while holding or
  using one.
- **Roles carry over** from one round to the next: whoever is the tagger when a round ends is the
  tagger when the next begins.
- A runner cannot tag; nobody can tag themselves or a player who is not in the game.

---

## 8. Hide & Seek

| Rule    | Value                                                                               |
| ------- | ----------------------------------------------------------------------------------- |
| Players | 2–4: exactly one seeker, everyone else a hider                                      |
| Rounds  | 3 rounds of 300 seconds                                                             |
| Finding | The seeker reports finding a hider, who is out for the round (`TARGET_OUT`)         |
| Scoring | `FOUND_PLAYER` +2 to the seeker; `STAYED_HIDDEN` +3 and `ALL_FOUND` +2 at round end |
| Winner  | `HIGHEST_SCORE`                                                                     |

- **A found hider keeps the hider role** and has status `out` until the next round starts.
- **`STAYED_HIDDEN`** goes to each hider who is not out when the round ends.
- **`ALL_FOUND`** goes to the seeker at round end if every hider is out.
- **The round does not end early** when everyone has been found; rounds end on time only.
- **The seeker is the same player in every round.** Rotation was not specified and is not implemented.
- A hider cannot report a find; a hider who is out cannot be found again that round.

---

## 9. Scoring

Scoring is data in the game definition (`scoring: [{ trigger, points }]`). The engine adds points
when it applies the event that earns them, and writes each award — player, reason, points — onto
that event's history entry.

| Reason                | Awarded when                                               | To               |
| --------------------- | ---------------------------------------------------------- | ---------------- |
| `TAG_MADE`            | A `ROLE_CHANGE` with a `TAGGED` cause is applied           | The tagger       |
| `FOUND_PLAYER`        | A `PLAYER_OUT` with reason `FOUND` is applied              | The seeker       |
| `ROUND_SURVIVED`      | `ROUND_END`, per `SWAP_ROLES` rule                         | Untagged runners |
| `STAYED_HIDDEN`       | `ROUND_END`, per `TARGET_OUT` rule                         | Hiders still in  |
| `ALL_FOUND`           | `ROUND_END`, per `TARGET_OUT` rule, if all targets are out | The seeker       |
| `OBJECTIVE_COMPLETED` | An `OBJECTIVE_COMPLETED` is applied                        | That player      |

A trigger a definition does not list is worth nothing in that game. Awards are always positive, so
a score never goes down and never becomes negative. Nothing outside the engine can award points.

---

## 10. Win conditions

`HIGHEST_SCORE` is the only win condition. It is evaluated when `GAME_END` is applied, and the
result is stored in `winnerIds`.

**Ties:** every player level on the highest score wins. `winnerIds` lists them in the order they
joined. Players who left the game cannot win. An aborted game has no winners.

---

## 11. Validation and errors

**Schema validation (Zod)** answers "is it well formed": `parsePlayerAction`, `parseGameEvent`,
`gameStateSchema`, `gameDefinitionSchema`.

**Domain validation** answers "is it legal here and now": `validatePlayerAction` and
`validateGameEvent` read the definition and the state and change nothing.

A refusal is returned as `Result<T, EngineError>`; nothing is thrown, and the caller's state is
untouched.

| Code                         | Meaning                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `INVALID_GAME_CONFIGURATION` | Unknown game definition                                                                                          |
| `INVALID_STATE_TRANSITION`   | The status does not allow it; or time going backwards                                                            |
| `GAME_ALREADY_STARTED`       | Joining after the lobby                                                                                          |
| `GAME_ALREADY_COMPLETED`     | Anything after `completed` or `aborted`                                                                          |
| `INVALID_PLAYER`             | Player not in the game, or has left                                                                              |
| `DUPLICATE_PLAYER`           | Player already joined                                                                                            |
| `PLAYER_LIMIT_EXCEEDED`      | Game is full                                                                                                     |
| `NOT_ENOUGH_PLAYERS`         | Roles cannot be filled                                                                                           |
| `INVALID_ROLE`               | Unknown role; actor's role may not do this; role limits broken                                                   |
| `INVALID_PHASE`              | No further phase                                                                                                 |
| `INVALID_ACTION`             | Malformed action; not this game's action; player out; shielded target; power not held; objective not completable |
| `INVALID_EVENT`              | Malformed event; wrong round; unknown power; duplicate objective; forged cause                                   |
| `UNSUPPORTED_EVENT`          | Event kind not supported by this game, or not allowed from outside                                               |
| `INVALID_MODIFIER`           | Modifier not allowed in this game                                                                                |
| `INVALID_GAME_STATE`         | Declared; nothing returns it yet                                                                                 |

---

## 12. Why AI cannot change state directly

A model's output varies between runs, cannot be relied on to respect limits, and cannot be audited
after the fact. So no model writes to `GameState`, and the engine is built so that it could not:

- The only way in for a model is the external-event boundary: `validateExternalEvent` takes
  untrusted input and checks it against the event schema and then against the game, and only the
  `ValidatedGameEvent` it issues can be applied.
- It can send only the seven external event kinds, and only those the game supports.
- It cannot send a lifecycle event, so it cannot start or end a round or the game.
- It cannot send a derived event or a caused `ROLE_CHANGE`, so it cannot fake a tag, a find, or a
  completed objective.
- There is no event that sets a score, and winners are computed by the engine.
- Every applied event is recorded in history with its source, so "did a model cause this?" can be
  answered from the data.

The engine itself involves no AI. The Game Master's proposals reach it through this boundary, from
the hand-off module in `packages/ai` (see [AI.md](../../AI.md)).

---

## 13. Why the engine is deterministic

- Every entry point is a pure function of the state, the input, and the context.
- The clock value comes in through `EngineContext`; nothing calls `Date.now()`, and there are no
  timers or sleeps. A test replaces `Date.now` and `Math.random` with functions that throw and plays
  a full game.
- Randomness (role assignment) comes from `createRng(state.randomSeed)` in `@touchgrass/shared`.
- State holds absolute times only.
- The engine imports `@touchgrass/game-definitions`, `@touchgrass/shared` and `zod`, and nothing else.

Tests assert that replaying recorded inputs rebuilds an identical state, that a state serialised to
JSON mid-game continues identically, and that refused inputs leave the state unchanged. A seeded
randomised test feeds 400 valid and invalid inputs to each game and checks after every one that the
state is schema-valid, scores never fall, and role limits hold.

---

## 14. Known limits

1. **Tag-backs are allowed.** Two players can tag each other back and forth for +2 each time. No
   cooldown or "no tag-back" rule was specified, so none exists.
2. **A player leaving mid-game is not handled specially.** If the tagger or seeker is removed, the
   game continues without one.
3. **The seeker does not rotate** between rounds.
4. **Zones and freeze periods have no effect** beyond being recorded.
5. **Settings cannot be overridden** when a game is created; it always uses its definition's.
6. **Ice & Fire, Treasure Hunt and Nature Challenge** have no rules or scoring. A game of one runs
   its single round on the timer and every player ties on 0, or on objective points where the game
   allows objectives.
7. **`ADVANCE_PHASE`** still exists as a host command and is independent of rounds.
