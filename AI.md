# AI Architecture

> **Status: Phase 3B — validated hand-off.** A Game Master exists: one Mastra agent, running Gemma
> through a local Ollama, that reads a game and returns a structured proposal. A proposal can now be
> handed to the game engine, which checks it against the current game and applies it only if it is
> legal. **There is still no safety validator**, and nothing in the app calls the Game Master during
> a game. The normal tests use a scripted stand-in for the model. The separate manual live test
> (`npm run ai:live`) has passed against the real local `gemma3:4b` model.

**AI proposes; deterministic validation decides; the game engine executes.**

**Schema-valid does not mean game-valid.** In the Phase 3A live run, real Gemma output that passed
the schema named players (`"123"`), roles (`"merchant"`) and powers (`"speedBoost"`) that did not
exist, and offered a shield to a player who already held one. The schema cannot know any of that;
only the engine, looking at the game, can.

---

## Who does what

| Role                 | What it is                                                                       | State           |
| -------------------- | -------------------------------------------------------------------------------- | --------------- |
| Claude / Codex       | Development assistants used to write this code. Not part of the running product. | —               |
| **Gemma**            | The runtime model, served locally by Ollama                                      | Integrated      |
| **Game Master**      | **Proposes** at most one game event, with a reason                               | Implemented     |
| **Hand-off**         | Passes a proposal to the engine's validator, then to the engine                  | Implemented     |
| **Game engine**      | **Decides** whether the event is legal now, and **executes** it                  | Implemented     |
| **Safety validator** | **Validates** a proposal against the hazard taxonomy                             | Not implemented |

---

## The pipeline

```
GameState + GameDefinition
    ↓
Game Master (Mastra agent)       packages/ai/src/game-master
    ↓
Gemma via Ollama                 ModelProvider + adapter
    ↓
raw proposal                     { rationale, event | null }
    ↓
schema validation                parseGameMasterProposal: shape, and the kinds this game allows
    ↓
state-aware validation           validateExternalEvent (engine): is it legal in this game, now?
    ↓
ValidatedGameEvent               can only be issued by the engine
    ↓
deterministic application        applyValidatedEvent (engine)
    ↓
new GameState

not built:  Safety validation, which belongs between schema validation and the engine.
```

Every arrow narrows what is possible. Nothing in this pipeline has judged a proposal **safe**: that
step does not exist yet, so an applied event has been checked for legality, not for hazards.

---

## 1. What "agent" means in this project

The word is used narrowly. A TouchGrass agent is:

> a component that observes game state, decides whether to act, and returns a **structured proposal**.

It explicitly is **not**:

- a thing with tools it can call
- a thing with autonomy over state
- a thing in a loop with itself
- a conversational partner

The Game Master has one capability: `propose(context)`. It looks at a game and returns at most one
event, or decides that nothing should happen. It cannot query a database, call an API, remember
anything between calls, or apply its own output.

### The Game Master, as built

```mermaid
flowchart LR
    subgraph Input["GameMasterContext (typed)"]
        A["GameState"]
        B["GameDefinition"]
        C["now"]
    end
    Input --> V["buildGameMasterView<br/>a read-only description"]
    V --> P["Prompt<br/>system prompt + game data + allowed shapes"]
    P --> AG["Mastra Agent<br/>no tools, one step"]
    AG --> AD["Model adapter"]
    AD --> MP["ModelProvider"]
    MP --> O["Ollama → Gemma"]
    AG --> PR["parseGameMasterProposal"]
    PR -- invalid --> RP["Repair prompt<br/>bounded"]
    RP --> AG
    PR -- valid --> OUT["Result: proposal, or a typed error"]
```

| File (`packages/ai/src/game-master/`) | Responsibility                                                |
| ------------------------------------- | ------------------------------------------------------------- |
| `game-master.ts`                      | `createGameMaster`, `propose`, the repair loop, typed errors  |
| `context.ts`                          | `GameMasterContext` and the read-only view shown to the model |
| `prompt.ts`                           | The system prompt and the message builders                    |
| `proposal.ts`                         | The proposal schema and its validation                        |
| `model-adapter.ts`                    | Presents a `ModelProvider` to Mastra as a language model      |

It is imported from `@touchgrass/ai/game-master`, a separate entry point, so code that only needs a
model provider does not load the agent framework.

**What the model is shown.** Not the state object: a description derived from it — the round and
seconds remaining, each present player's role, score and status, what is in force, the last ten
history entries, the event kinds, modifiers and powers this game allows, the validation limits, and
the game's `persona` and `avoid` list.

**What it returns.**

```ts
{ rationale: string, event: ExternalGameEvent | null }
```

`event` uses the engine's own schemas for events that may come from outside it
(`EXTERNAL_EVENT_SCHEMAS` in `packages/game-engine/src/events.ts`). There is no second event model.
`null` means "nothing should happen now".

**What it cannot express.** The engine has no external schema for `ROUND_START`, `ROUND_END`,
`GAME_END`, `PLAYER_OUT`, `POWER_ACTIVATED` or `OBJECTIVE_COMPLETED`, and the external `ROLE_CHANGE`
has no `cause` field. So the Game Master cannot start or end a round or the game, put a player out,
activate a power, complete an objective, or claim that a role change was a tag. No event sets a
score. For each game, the schema given to the model is further narrowed to the kinds that game
allows.

**Outcomes.** `propose` returns a `Result`:

| Outcome             | Meaning                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| ok                  | A valid proposal, the number of attempts, and the provider and model used                  |
| `GAME_NOT_ACTIVE`   | No round is running; the model is not called                                               |
| `INVALID_CONTEXT`   | The definition is not the game being played; the model is not called                       |
| `MODEL_UNAVAILABLE` | The runtime failed; `modelErrorCode` says how (unreachable, timeout, model not pulled, …)  |
| `INVALID_PROPOSAL`  | The model replied, but not validly, after every attempt; includes the issues and the reply |

If Ollama is down or the model has not been pulled, the caller gets `MODEL_UNAVAILABLE`. Nothing
falls back to another model.

**Why it cannot change a game.** The agent has no tools. The Game Master object has one method. The
module imports types and schemas from the engine and none of its entry points; a test reads the
source files and fails if that changes. Its only output is a returned value. A test passes it a
deeply frozen game and checks it is unchanged.

### The hand-off, as built

`@touchgrass/ai/handoff` (`packages/ai/src/handoff/handoff.ts`) is the only place in this package
that passes anything to the engine. It is a separate module from the Game Master, and it contains no
game rules.

| Function                     | What it does                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `validateGameMasterProposal` | Schema check, then the engine's state-aware check. Changes nothing.          |
| `handOffProposal`            | Validates, then has the engine apply the validated event. No model involved. |
| `runGameMasterTurn`          | Asks the Game Master for a proposal, then calls `handOffProposal`.           |

- **Raw proposal.** Treated as untrusted even when it came from `GameMaster.propose`; its shape is
  checked again.
- **Schema validation.** Rejects malformed proposals, engine-only event kinds, a `ROLE_CHANGE` with a
  `cause`, and kinds the game does not allow. Failure stage: `SCHEMA`.
- **State-aware validation.** Done by the engine (`validateExternalEvent`), with the same rules it
  applies to every event: the players, roles and powers named must exist; a player must not already
  hold the power; role limits must hold; the modifier must be allowed; a round must be running.
  Failure stage: `STATE`, carrying the engine's error.
- **Validated event.** A `ValidatedGameEvent` is issued only by the engine and is bound to the state
  it was checked against. An object that merely has the same shape is refused, and so is one
  validated on a different branch of the game or before the game moved on. "Validated" means legal
  in the game, not safe.
- **Game definition.** Never taken from the caller: the hand-off and the engine both look it up from
  the state's game id, so a modified definition cannot widen what is accepted.
- **Deterministic application.** `applyValidatedEvent` applies it. The engine validates again as it
  applies, as it does for every event. Failure stage: `APPLICATION`.
- **Null proposal.** `event: null` is a legitimate answer. The outcome is `NO_EVENT`, the same state
  object is returned, and nothing is recorded. The rationale is explanatory text from a model; it is
  kept for the record and never read as a fact about the game. (A real reply paired `event: null`
  with a rationale that was untrue.)
- **Failure.** A typed error, and the caller's state exactly as it was. Nothing is partly applied.
  Nothing is repaired or guessed: an unknown player is not mapped to a real one, a missing role or
  power is not created, and the model is not asked again after a state rejection.

In a live run of this path, real Gemma proposals produced each outcome: one applied
(`TIME_EXTENSION`), one refused by the engine (a shield for a player who already held one), and two
no-ops.

### Where Mastra fits

Mastra provides the agent: instructions, the model call, and structured output. The Game Master is a
single `Agent` with `tools: {}`, limited to one step. There are no workflows, no memory, no other
agents, and no Mastra server.

The agent's model is not a Mastra or AI-SDK provider for Ollama. It is `createProviderLanguageModel`,
a small adapter that implements the language-model interface Mastra expects on top of this project's
existing `ModelProvider`. So the runtime is still chosen in one place, and no OpenAI client library
is a dependency.

### What is not used yet

Each game definition also carries `encourage` and `exampleTwists`. They were written in Phase 1,
before the event vocabulary existed, and several describe things no event can express ("taggers may
only hop"). They are **not** put in the prompt, because the prompt tells the model not to invent
mechanics the game does not have.

### Why one agent and not a crew

A planner/critic/safety-reviewer trio is the fashionable architecture and the wrong one here:

- **The critic's job is done better by Zod.** "Is `durationSeconds` within range" is a schema
  question, answered in microseconds with a precise error message, not a second inference pass.
- **The safety reviewer's job must not be done by a model at all.** See §4 and
  [SAFETY.md](./SAFETY.md). A model reviewing a model inherits the first one's failure modes.
- **Every extra pass costs a player's patience.** Twelve people are standing in a field. Two
  inference calls where one suffices is a product regression.

Agents get added when a job genuinely needs a model's judgement and cannot be expressed as code. So
far, exactly one job qualifies: writing the twist.

---

## 2. Why an LLM alone is not the game engine

Imagine skipping the architecture and asking a model to run the game directly: feed it state, let it
return new state. It fails on five counts, and each one is a reason a specific piece of the codebase
exists.

**It is not deterministic.** Ask twice, get two answers. A referee that gives different rulings on
identical situations is not a referee. The engine is a pure function, and the test suite pins that:
two replays of the same recorded inputs produce byte-identical state.

**It cannot be audited.** When a parent asks why their child was told to do something, "the model
decided" is not an answer. Every state change in TouchGrass carries a provenance tag — `engine`,
`human`, or `game-master` — so the history shows which changes came from a model. (The event
schema has no field for a model's reasoning; whether to record one is a Phase 3 decision.)

**It cannot be trusted with arithmetic or invariants.** Scores drift. Role maximums get violated. A
game with eleven taggers and one runner is not a game. `assignRoles` enforces the definition's
minimums and maximums as code, and the schema refuses a definition whose roles demand more players
than `minPlayers` allows.

**It has no stable notion of refusal.** "Do not allow a player to join a running game" is a rule a
model will follow most of the time. Most of the time is not a rule. `reduce` returns a typed
`WRONG_STATUS` error, every time, and a test asserts that a terminal session accepts nothing at all.

**It confuses creativity with authority.** The model is genuinely good at the one hard thing — "this
chase has gone static, invent something that will make twelve people laugh and move differently."
That is a creative act. Deciding whether the result is safe, legal, fair, and applicable is a
judicial act. Conflating them is the mistake.

So the division is: **the model proposes, code judges, code executes.**

---

## 3. Why structured output is required

A Game Master turn has to become a state change. Free text cannot, without a parser — and a parser
over model prose is a guessing machine.

Structured output is enforced in two independent layers, and the distinction matters:

### Layer 1 — grammar-constrained decoding

The Zod schema is converted to JSON Schema and handed to the runtime, which constrains the sampler
during generation:

```ts
// The Game Master gives Mastra a Zod schema; Mastra passes it to the model as a JSON Schema
// response format; the adapter hands that to the provider:
// → Ollama:            { format: jsonSchema }
// → OpenAI-compatible: { response_format: { type: 'json_schema', json_schema: { strict: true, ... } } }
```

This is the single biggest reason a **4B** open-weight model is viable here. The question is not "is
the model clever enough to remember the JSON format" — the grammar makes malformed output largely
unreachable. The model only has to be good at the creative part.

### Layer 2 — Zod validation

Grammar guarantees _shape_, not _meaning_. A model can emit a structurally perfect
`durationSeconds: 300` in a game whose ceiling is 120, or a `delta: 50` when the cap is 10. Only the
schema catches that, so the output is re-validated after generation — always, with no fast path.

### The contract itself

`packages/game-engine/src/events.ts` is the narrow waist of the product. A strict discriminated
union — of which an outside source such as the Game Master may send seven kinds, through
`submitGameEvent` — and a set of deliberately conservative choices:

| Choice                           | Reason                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| No free-form `data` bag          | Every field is named and typed. A model cannot invent a new effect.  |
| `.strict()` on every branch      | An unexpected key is a rejection, not a shrug.                       |
| Length-bounded strings (3–240)   | A twist must be shoutable across a field and remembered.             |
| Bounded durations (5–600s)       | A model cannot impose a rule lasting an hour.                        |
| Bounded points (1–10)            | A model cannot hand out a thousand points, or take any away.         |
| Zones as text, never coordinates | The system has no map and must not claim spatial authority it lacks. |

The last one is worth dwelling on. `ZONE_CHANGE` takes `zone: "the bench with the missing slat"` —
never a latitude. The system does not know what is on the far side of a hedge, so it never pretends
to. Players own the boundary; the Game Master only references what they already named.

The event schema is the engine's contract, not an AI-specific one: it has no field for a model's
reasoning and no notion of a "turn". Whether the Game Master's output also carries a rationale for
the audit log, and how many events one turn may contain, are Phase 3 decisions that wrap this
schema without changing it.

### Why a discriminated union rather than a loose object

Error quality. Telling a 4B model _"durationSeconds: Too big: expected number to be <=600"_
produces a usable retry. Telling it _"invalid union"_ does not. The union's per-branch errors are what
make the repair loop in the next section actually work.

---

## 4. Why deterministic validation is required

Three validation passes, with a strict ordering and no shortcuts.

```mermaid
flowchart TD
    Raw["Raw completion"] --> J{"Parses as JSON?"}
    J -- no --> R
    J -- yes --> Z{"Satisfies Zod?"}
    Z -- no --> R["Repair loop<br/>field-level feedback,<br/>bounded attempts"]
    R --> Raw
    Z -- yes --> S{"Passes safety?"}
    S -- "revise" --> R
    S -- "reject" --> F2["Audit log only.<br/>Never shown to players."]
    S -- "allow" --> E["Engine applies it"]
```

Of this diagram, the JSON, schema and repair steps are implemented in the Game Master. The safety
step and "engine applies it" are not.

**The repair loop is bounded and informative.** On a validation failure, or a reply that is not JSON
at all, the model is told what was wrong, shown its own rejected output, and asked once more. If the
budget runs out the Game Master returns `INVALID_PROPOSAL` with the issues and the last reply. A model
that cannot be reached is not repaired; it is reported as `MODEL_UNAVAILABLE`. Small models repair well
when feedback names the field and the constraint. The budget defaults to one extra attempt — past
that, the turn is dropped, because a Game Master that goes quiet for a round is fine and one that
takes twenty seconds is not.

**Safety is deliberately synchronous.** The `SafetyValidator` type signature is not `async`:

```ts
export type SafetyValidator<TProposal, TContext> = (
  proposal: TProposal,
  context: TContext,
) => SafetyVerdict;
```

A check that can await is a check that can hang, time out, and get skipped under load. Forbidding I/O
in the type also forbids the thing we must never do: ask a model whether its own output was safe.

**There is no "unknown" verdict.** `SafetyDisposition` is `allow | revise | reject`. Anything the
validator cannot classify is a reject. A game that fails closed is boring for one round; a game that
fails open is dangerous.

---

## 5. Why open-weight AI is important here

Beyond ideology, four properties of this specific product make open weights the right call:

**Latency is a product feature.** A Game Master turn blocks real people mid-game. Self-hosting means
the deadline, quantisation, batching, and keep-alive are ours to tune. `OLLAMA_KEEP_ALIVE=30m` is set
in `docker-compose.yml` for exactly this reason — a cold model load would blow past the request
timeout between turns.

**The players are often children.** Session content includes names and described locations. With a
local runtime, none of it leaves hardware we control. That is a materially different privacy posture
from "we send it to a vendor and trust the retention policy."

**Cost cannot scale with play.** The Game Master fires every ninety seconds for an hour. Per-token
billing makes the product's core loop the thing you want to avoid doing.

**The safety argument depends on replaceability.** [SAFETY.md](./SAFETY.md) claims the model is never
the final authority. That claim is only credible if the model is a component we can swap, inspect, and
test around — which is what the provider port in §7 provides.

The default is **Gemma 3 4B**: small enough for a laptop, well-behaved under grammar constraints, and
openly licensed.

---

## 6. Why local inference is useful

Separate from the open-weight argument, running the model _locally during development_ changes how the
project can be built and contributed to.

- **A contributor clones and runs the real thing.** `npm run ai:up && npm run ai:pull`. No account,
  no key, no quota. For a Hacktoberfest project that is the difference between a contributor who tries
  the Game Master and one who reads about it.
- **Prompt iteration is free.** Tuning a persona means running a hundred generations. At zero
  marginal cost that is an afternoon; metered, it is a budget conversation.
- **Failure modes are reproducible.** A pinned local model fails the same way twice, so a prompt
  regression is a bug you can write a test around instead of a thing that happened once.
- **The dev contract matches production.** The container exposes the same HTTP interface the GPU host
  will. Development is a scaled-down production, not a different system.

The tests never require a running model. `packages/ai` uses a scripted stand-in provider, defined in
a test-support file, and `vi.stubGlobal('fetch')` for the HTTP adapters, so CI needs no GPU. No fake
model is used by production code. The one test that calls a real model, `game-master.live.ts`, is
excluded from `npm test` and `npm run verify` and is run by hand with `npm run ai:live`.

---

## 7. How the model becomes replaceable

One port, two adapters, one registry. Nothing outside `packages/ai/src/provider/` names a runtime.

```ts
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly baseUrl: string;
  health(options?): Promise<ProviderHealth>;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult>;
}
```

The port is small on purpose — no streaming, no embeddings, no tool calling, no chat-session
abstraction. The Game Master needs one JSON object per turn within a deadline. A port that promises
only what is required is a port any open-weight runtime can satisfy.

**Two adapters ship now because an abstraction with one implementation is an untested guess.**

| Adapter             | Endpoint                    | Structured output                             | Role        |
| ------------------- | --------------------------- | --------------------------------------------- | ----------- |
| `ollama`            | `POST /api/chat`            | `format: <JSON Schema>`                       | Development |
| `openai-compatible` | `POST /v1/chat/completions` | `response_format: { type: 'json_schema', … }` | Production  |

Writing the second one is what proved the port was provider-shaped rather than accidentally
Ollama-shaped. It is also the realistic production path: every way of serving Gemma on a GPU host —
vLLM, TGI, llama.cpp's server — speaks `/v1/chat/completions`. The weights stay open and self-hosted;
only the protocol changes, behind one file.

Swapping is a config change, not a code change:

```bash
MODEL_PROVIDER=openai-compatible
MODEL_NAME=google/gemma-3-12b-it
MODEL_BASE_URL=https://gpu-host.example.com/v1
MODEL_API_KEY=…
```

The registry is a `Record<ModelProviderId, Factory>` rather than a `switch`, so adding a runtime is
one file plus one entry — and TypeScript fails the build if the env schema gains a provider with no
factory.

### What is observable at the boundary

Every generation reports `latencyMs`, `attempts`, `model`, and token usage where the runtime provides
it. Validation failures log the field-level issues and the raw completion. This is the telemetry that
makes prompt work empirical rather than anecdotal, and it is why Sentry (a later phase) has something worth
collecting.

---

## 8. What comes next

Not built:

| Piece                                   | Notes                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety validation of a proposal         | Specified in [SAFETY.md](./SAFETY.md); taxonomy and contracts exist. Until it exists, the hand-off applies events that have been checked for legality only |
| When to ask the Game Master             | Nothing calls `runGameMasterTurn` yet; there is no trigger or schedule                                                                                     |
| Limits on how often events are proposed | The engine accepts any number of valid external events                                                                                                     |
| Prompt evaluation                       | Recorded real outputs, asserted against the schemas                                                                                                        |

`generateStructured()` in `structured.ts` predates the Game Master. It is still tested and exported,
but the Game Master does not use it; it has its own repair loop around the Mastra agent.
