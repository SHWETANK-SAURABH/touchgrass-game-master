# Architecture

> Phase 1 (foundation) is implemented. Sections describing later phases are marked **planned** and
> say what exists today. Nothing in this document describes code that is not in the repository
> unless it carries that marker.

---

## 1. Product concept

TouchGrass is a platform for playing **real outdoor games** — tag, hide & seek, ice & fire, treasure
hunts, nature challenges — in which an open-weight language model acts as **Game Master**.

A group opens the app in a park, picks a game, and the phone becomes the referee. It assigns roles,
walks them through agreeing a boundary, and then — while the round is running — issues twists:

> "Taggers may only move by hopping on one foot for the next sixty seconds."
>
> "The playable area is now everything between the bench and the gate. Anyone outside that line has
> sixty seconds to move inside it."
>
> "Your next landmark has four legs but never walks, and it has been sat on more than it has been
> noticed."

The design constraint that shapes everything else: **the game happens in the world, not on the
screen.** The phone's job is to referee, and a referee that takes eight seconds to make a call while
twelve people stand still is a bad referee. So latency, offline capability, and failure behaviour are
product requirements, not operational details.

### Why this needs a generative model

A fixed list of twists is stale on the second play. Three things genuinely require generation:

| Capability         | Why a static list cannot do it                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Situated riddles   | A treasure hunt must describe _this_ park — the bench with the missing slat, the third lamp post.   |
| Live rebalancing   | "Ice is winning, four players are frozen" needs a response fitted to that state, phrased for voice. |
| Pacing and variety | Twenty minutes of tag needs a dozen twists that do not repeat and escalate sensibly.                |

### Why it is not a game with a chatbot bolted on

A chatbot produces text beside the game. This Game Master produces **events that change the rules of
play** — which means its output must be structured, bounded, auditable, and refusable. Those four
requirements are what produce the architecture below.

---

## 2. Why open-weight AI is central

The model is not an optional enhancement; it is the component that makes the product possible, and it
being **open-weight and self-hosted** is a design decision with concrete consequences.

| Property                    | Consequence for this product                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted latency**     | A Game Master turn blocks real people in a field. We tune the deadline, quantisation, and keep-alive ourselves rather than metering a vendor's queue. |
| **Privacy by locality**     | Players are often children. Names, described locations, and chosen landmarks never leave hardware we control.                                         |
| **No per-token cost**       | The Game Master can fire on a timer every ninety seconds for an hour without anyone watching a bill.                                                  |
| **Offline capability**      | Parks have bad signal. A local runtime means the referee works on a laptop hotspot, or on none.                                                       |
| **Inspectable + swappable** | The safety argument rests on deterministic validation, not on trust in a model. That only holds if the model is a replaceable part.                   |

The default is **Gemma 3 4B** via Ollama in development. Small enough to run on a laptop, and good
enough at grammar-constrained JSON to drive the event contract — see [AI.md](./AI.md) for why size is
less important here than structured decoding.

---

## 3. High-level architecture

The central principle:

```
AI PROPOSES  →  VALIDATOR CHECKS  →  GAME ENGINE EXECUTES  →  REALTIME BROADCASTS  →  PLAYERS ACT
```

The LLM never mutates game state. It emits a structured _proposal_; deterministic code decides
whether that proposal becomes an event.

```mermaid
flowchart TD
    State["Game state<br/>(session + definition + log)"] --> Agent
    Agent["Game Master agent<br/><i>planned — Phase 2</i>"] --> Model
    Model["Gemma via ModelProvider<br/>grammar-constrained decoding"] --> Raw

    Raw["Raw JSON completion"] --> Zod
    Zod{"Zod validation<br/>gameEventProposalSchema"}
    Zod -- invalid --> Repair["Repair loop<br/>(bounded retries)"]
    Repair --> Model
    Zod -- valid --> Safety

    Safety{"Safety validation<br/><i>planned — Phase 2</i>"}
    Safety -- reject --> Audit["Logged, never shown"]
    Safety -- allow --> Engine

    Engine["Game engine<br/>pure reducer"] --> NewState["New session state<br/>+ append-only log"]
    NewState --> Broadcast["Realtime broadcast<br/><i>planned — Phase 3</i>"]
    Broadcast --> Players["Players act outdoors"]
```

Three properties hold at every arrow:

1. **One direction of trust.** Data flows from less trusted to more trusted through a validator.
   Nothing downstream of a validator ever re-accepts raw model output.
2. **Every refusal is a value, not an exception.** `Result<T, E>` is used throughout, so a rejected
   proposal or a refused command is a branch the compiler forces callers to handle.
3. **Every state change is logged with its provenance.** Each log entry records whether it came from
   the engine, a human, or the Game Master.

---

## 4. Agent architecture

> **Phase 1 status:** the contract and the generation machinery exist. The agent itself is Phase 2.

An "agent" in this project is narrow and deliberately unglamorous: a component that observes game
state, decides whether to act, and emits a structured proposal into a validation pipeline. It has no
tools, no memory store, and no autonomy over state.

```mermaid
flowchart LR
    subgraph Inputs
        S["Session state<br/>phase, roles, scores, log"]
        D["Game definition<br/>allowed kinds, themes, guidance"]
        P["Prohibitions<br/>gameMaster.avoid"]
    end

    Inputs --> Prompt["Prompt assembly"]
    Prompt --> GS["generateStructured()<br/><b>implemented</b>"]
    GS --> Schema["JSON Schema from Zod<br/>constrains decoding"]
    Schema --> Provider["ModelProvider<br/><b>implemented</b>"]
    Provider --> Turn["GameMasterTurn<br/>1–3 proposals"]
    Turn --> Out["→ safety → engine"]
```

What is already in place:

- **`gameMasterTurnSchema`** (`packages/game-engine/src/proposal.ts`) — the exact shape a turn must
  take: one to three proposals, each a member of a strict discriminated union of seven event kinds.
- **`generateStructured()`** (`packages/ai/src/structured.ts`) — Zod → JSON Schema → constrained
  generation → Zod validation → bounded repair loop.
- **Per-game guidance as data** — each definition carries a `gameMaster` block with a persona, an
  `encourage` list, an `avoid` list, and hand-written example twists for few-shot prompting.

Phase 2 adds the agent that assembles those inputs into a prompt and decides _when_ to fire.
[AI.md](./AI.md) covers the reasoning in depth.

### Why one agent, not several

A planner/critic/safety-reviewer trio would be the fashionable shape and the wrong one. The critic's
job is done better by Zod, and the safety reviewer's job must be done by deterministic code —
delegating a safety decision to a second model inherits the first model's failure modes and adds
latency to a turn that people are physically waiting on. One agent proposes; code judges.

---

## 5. Game engine architecture

The engine is the **only** thing that can change a session, and it is a pure function.

```ts
reduce(state: SessionState, command: SessionCommand, ctx: EngineContext): Result<SessionState, EngineError>
```

Three properties, each enforced by tests:

**It is pure.** No `Date.now()`, no `Math.random()`, no I/O, no import from `packages/ai`. Clock and
randomness arrive through `EngineContext` and a seeded RNG stored on the session. A test asserts that
`reduce` never mutates the state handed to it.

**It is replayable.** `replay()` re-runs a command list from scratch; a test asserts two replays of
the same script produce byte-identical state. This is what lets a future persistence layer store
commands rather than snapshots, and lets a disputed call be settled by re-running the log.

**It fails closed, as a value.** Illegal commands return a typed `EngineError` with one of nine
codes. Joining a running game, starting below the player minimum, advancing past the last phase, and
anything at all after a terminal status are all refusals — not exceptions, not silent no-ops.

```mermaid
stateDiagram-v2
    [*] --> lobby: CREATE_SESSION
    lobby --> lobby: ADD_PLAYER / REMOVE_PLAYER
    lobby --> active: START_SESSION<br/>(assigns roles deterministically)
    active --> active: ADVANCE_PHASE
    active --> paused: PAUSE_SESSION
    paused --> active: RESUME_SESSION
    active --> completed: COMPLETE_SESSION
    paused --> completed: COMPLETE_SESSION
    lobby --> aborted: ABORT_SESSION
    active --> aborted: ABORT_SESSION
    paused --> aborted: ABORT_SESSION
    completed --> [*]
    aborted --> [*]
```

`ABORT_SESSION` is legal from every non-terminal status, including the lobby. **Stopping a game must
never be blocked by a state check** — if someone is hurt, the host presses stop and the engine
complies.

### Role assignment is engine work, not model work

Who chases whom is a fairness decision with hard constraints (minimums, maximums, an overflow role),
not a creative one. `assignRoles` fills each role to its declared minimum from a seed-shuffled player
list, pushes any overflow past a role's maximum into the default role, and refuses outright if the
headcount cannot satisfy the definition. Same seed, same joining order, same teams — on any host.

### What Phase 2 adds

One command: `APPLY_GAME_MASTER_EVENT`, carrying a proposal that has already passed Zod _and_ safety.
Its handler is where `OBJECTIVE`, `MODIFIER`, `ZONE_RULE`, `TIMER`, `SCORE_ADJUST` and `ROLE_ASSIGN`
become state. The `modifiers` array and the `'game-master'` log provenance already exist on
`SessionState` waiting for it.

---

## 6. Safety architecture

Covered in full in [SAFETY.md](./SAFETY.md). The architectural commitments:

**The model is never the safety authority.** Not as a reviewer of its own output, not as a reviewer
of another model's output. Safety is a synchronous, deterministic function over validated data. The
`SafetyValidator` type is deliberately not `async` — a check that can await is a check that can hang,
time out, and get skipped under load.

**Safety is a separate pass from schema validation.** Zod answers "is this the right shape". Safety
answers "should a child in a field hear this". A perfectly well-formed `MODIFIER` saying _"cross the
road and touch the far pavement"_ passes Zod and must be rejected by safety.

**Policy is derived, never hand-assembled.** `policyFor(definition)` produces the policy from the
game's own declared contact limits, intensity ceiling, and separation expectations. A host can make a
session stricter; the schema refuses any policy that drops a critical hazard category, and
`maxRuleDurationSeconds` clamps downward only.

```mermaid
flowchart LR
    Proposal["Validated proposal"] --> Lex["Lexical pass<br/>hazard signals over<br/>every text fragment"]
    Proposal --> Struct["Structural pass<br/>contact policy, intensity,<br/>duration, role validity"]
    Lex --> Verdict
    Struct --> Verdict
    Policy["SafetyPolicy<br/>derived from definition"] --> Lex
    Policy --> Struct
    Verdict{"SafetyVerdict"}
    Verdict -- allow --> Engine["Engine"]
    Verdict -- revise --> Repair["One repair attempt"]
    Verdict -- reject --> Log["Audit log only"]
```

**Phase 1 ships the taxonomy and the contracts; Phase 2 ships the rules.** Fifteen hazard categories
with severity, rationale, and example signals; the three-way verdict type; policy derivation. The
matching engine is Phase 2 — deciding _what_ counts as a hazard was the hard part, and writing rules
against a fixed taxonomy is the mechanical part.

---

## 7. Realtime architecture

> **Planned — Phase 3.** Nothing realtime exists today, and there is no placeholder package.

The intended shape, and the constraint it has to respect:

```mermaid
flowchart TD
    Host["Host device<br/>authoritative UI"] -- commands --> WS["WebSocket server<br/>(Node, colocated with Next.js)"]
    P1["Player phone"] -- commands --> WS
    P2["Player phone"] -- commands --> WS
    WS --> Engine["Game engine<br/>pure reducer"]
    Engine --> Redis[("Redis<br/>hot session state<br/>+ pub/sub fan-out")]
    Redis --> WS
    WS -- state patches --> Host
    WS -- state patches --> P1
    WS -- state patches --> P2
```

Decisions already fixed by the Phase 1 design:

- **Clients send commands, never state.** The engine command union is the only vocabulary a client
  may use, and the server re-validates every command with Zod regardless of origin.
- **Redis holds hot state; it is not the system of record.** The command log is. A lost Redis key
  costs a replay, not a session.
- **Broadcast is the last step, not a side effect.** The engine returns new state; the transport
  publishes it. The engine has no idea a socket exists.
- **Phones are unreliable by assumption.** Players run, drop signal, and lock screens. State is
  reconciled on reconnect by replaying from the last known sequence number — which is why log
  entries carry a contiguous `sequence`.

---

## 8. Data architecture

> **Planned — Phase 3** for MongoDB and Redis. Today every piece of state is in-process.

```mermaid
flowchart LR
    subgraph Static["Static, versioned with the code"]
        Defs["Game definitions<br/>TypeScript data, Zod-validated at load"]
        Hazards["Hazard taxonomy<br/>+ policy derivation"]
    end

    subgraph Hot["Hot — Phase 3"]
        R[("Redis<br/>live SessionState<br/>join-code → session")]
    end

    subgraph Durable["Durable — Phase 3"]
        M[("MongoDB Atlas<br/>command log, completed sessions,<br/>safety verdict audit trail")]
    end

    Defs --> Engine["Engine"]
    Hazards --> Safety["Safety"]
    Engine <--> R
    Engine --> M
    Safety --> M
```

The division of labour:

| Store             | Holds                                                            | Why there                                                                  |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Code**          | Game definitions, hazard taxonomy                                | They are reviewed, tested, and versioned with the logic that reads them.   |
| **Redis**         | Live `SessionState`, join-code lookup, pub/sub                   | Sub-millisecond reads on the referee path; naturally ephemeral.            |
| **MongoDB Atlas** | Append-only command log, finished sessions, every safety verdict | Durable, queryable, and the basis of the audit trail SAFETY.md commits to. |

**Why the command log is the system of record.** Storing commands rather than snapshots means the
engine's replay property does real work: a session can be reconstructed, a disputed call re-run, and
a safety regression tested against real historical turns. Snapshots would throw that away.

**Why game definitions are not in a database.** A definition carries the prohibitions the Game Master
must obey. Those belong under code review and in the test suite, not in a collection anyone can
hot-edit.

---

## 9. Local development architecture

```mermaid
flowchart LR
    Browser["Browser<br/>localhost:3000"] --> Next["Next.js 16 dev server<br/>(Turbopack)"]
    Next --> Pkgs["Internal packages<br/>consumed as TS source"]
    Next --> Provider["ModelProvider<br/>(ollama adapter)"]
    Provider --> Ollama["Ollama<br/>localhost:11434<br/>docker compose"]
    Ollama --> Gemma["gemma3:4b<br/>named volume"]
```

**One command to a working model.** `npm run ai:up && npm run ai:pull` gives every contributor the
same weights behind the same HTTP contract the production GPU host will expose. The web app is
deliberately _not_ containerised for development — hot reload beats a rebuilt image.

**Internal packages are consumed as TypeScript source.** Each package's `exports` points at
`./src/index.ts`, and `next.config.ts` lists them in `transpilePackages`. There is no per-package
build step, no watch-mode orchestration, no `dist/` to go stale, and no Turborepo to configure. Next
already compiles app code; compiling five small packages alongside it costs nothing measurable.

One consequence worth knowing: relative imports inside packages are **extensionless**
(`from './errors'`, not `'./errors.js'`). Turbopack does not rewrite `.js` → `.ts` the way Vite does,
and `moduleResolution: "Bundler"` makes extensionless correct for both.

**Degraded mode is a first-class state.** With no model running, the app still serves every page —
game rules, roles, phases and safety profiles are local data. `/api/health` reports
`status: "degraded"` with HTTP 200 and a sentence naming the command to fix it. Only the Game Master
is unavailable.

---

## 10. Production architecture

> **Planned — Phase 4** for deployment. The build output and container already target it.

```mermaid
flowchart TD
    Users["Players' phones"] --> Render

    subgraph Render["Render — CPU-sized app"]
        Web["Next.js + Node<br/>WebSockets + Game Master agent"]
    end

    Render --> Redis[("Redis<br/>hot session state")]
    Render --> Mongo[("MongoDB Atlas<br/>command log + audit")]
    Render --> Sentry["Sentry<br/>errors + model telemetry"]

    Render -- "MODEL_BASE_URL<br/>OpenAI-compatible HTTP" --> GPU

    subgraph GPU["DigitalOcean GPU droplet"]
        Serve["vLLM / TGI / llama.cpp"] --> Weights["Gemma<br/>open weights"]
    end
```

**The app container and the model host scale separately** — the whole reason inference sits behind
`MODEL_BASE_URL` rather than inside the app image. Serving a page costs a CPU and a few MB; serving a
token costs a GPU. Coupling them would mean paying for GPUs to serve static game rules.

The `Dockerfile` builds Next.js standalone output as a non-root user, with a `HEALTHCHECK` that hits
`/api/health` — the same signal the application itself depends on.

The production path uses the **`openai-compatible`** provider, because every realistic way of serving
Gemma on a GPU host (vLLM, TGI, llama.cpp's server) exposes `/v1/chat/completions`. The model stays
open-weight and self-hosted; only the wire protocol differs, and it differs behind one file.

---

## 11. Model abstraction

Nothing outside `packages/ai/src/provider/` names a model runtime. The application holds a
`ModelProvider` and reads `MODEL_PROVIDER` from validated config.

```mermaid
flowchart TD
    App["Application code<br/>agent, API routes, health"] --> Port["ModelProvider (port)<br/>health · generateText · generateJson"]
    Port --> Reg["createModelProvider(id, config)"]
    Reg --> O["ollama adapter<br/>/api/chat + format: schema"]
    Reg --> C["openai-compatible adapter<br/>/v1/chat/completions<br/>+ response_format: json_schema"]
    O --> OD["Ollama daemon"]
    C --> VL["vLLM · TGI · llama.cpp"]
```

The port is deliberately small — `health`, `generateText`, `generateJson` — with no streaming, no
embeddings, no tool calling, and no session abstraction. The Game Master needs one JSON object per
turn within a deadline. A port that promises only what is required is a port any open-weight runtime
can satisfy.

**Two adapters ship in Phase 1 on purpose.** An abstraction with one implementation is an untested
guess; writing the second is what proves the port is provider-shaped rather than accidentally
Ollama-shaped. The registry is a `Record` keyed by provider id, so TypeScript fails the build if the
env schema gains a provider with no factory.

Swapping runtimes is a config change:

```bash
MODEL_PROVIDER=openai-compatible
MODEL_NAME=google/gemma-3-12b-it
MODEL_BASE_URL=https://gpu-host.example.com/v1
MODEL_API_KEY=...
```

---

## 12. Failure and fallback strategy

Failures are classified by cause, because the right response differs per cause. A dead daemon needs a
scripted fallback; malformed JSON needs a retry.

| Failure                            | Code                        | Response                                                                                    |
| ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| Runtime unreachable                | `PROVIDER_UNREACHABLE`      | Retried within budget, then **degraded mode**: the game continues without twists.           |
| Deadline exceeded                  | `PROVIDER_TIMEOUT`          | Retried within budget. The turn is skipped rather than delivered late.                      |
| Model not on the runtime           | `MODEL_NOT_AVAILABLE`       | Not retried. Health surfaces the exact pull command.                                        |
| 4xx from the runtime               | `PROVIDER_HTTP_ERROR`       | **Not retried** — the request was wrong, and repeating it only burns the deadline.          |
| 5xx from the runtime               | `PROVIDER_HTTP_ERROR`       | Retried within budget.                                                                      |
| Completion is not JSON             | `OUTPUT_NOT_JSON`           | Counts as an attempt; the raw text is logged verbatim for prompt debugging.                 |
| Valid JSON, fails Zod              | `OUTPUT_SCHEMA_INVALID`     | **Repair loop**: the model is told which fields were wrong, once. Then the turn is dropped. |
| Passes Zod, fails safety           | `revise` / `reject` verdict | `revise` → one repair attempt. `reject` → logged, never shown to players.                   |
| Illegal command reaches the engine | nine `EngineError` codes    | Refused as a `Result` value. State is untouched.                                            |
| Environment is invalid             | `CONFIGURATION_INVALID`     | **Fatal at startup**, naming the offending variable. Never a mid-game surprise.             |

Three rules behind that table:

**Degraded is a supported mode, not an outage.** Every bundled game is playable by humans without a
referee — people played tag for millennia. When the Game Master is unavailable the app says so
plainly and the round continues. Returning 503 and taking the deployment down would be a strictly
worse outcome.

**Fail closed on content, fail open on availability.** An unvalidated proposal is dropped, always. An
unavailable model degrades a feature, never blocks the app.

**Timeouts are short and tiered.** Health probes get 3s, because they render in a page. Generation
gets `MODEL_REQUEST_TIMEOUT_MS` (30s default), because it blocks a group of people standing in a
field. Both are bounded, and retries are capped at `MODEL_MAX_RETRIES`.

---

## 13. Roadmap

| Phase       | Scope                                                                                                     | Status       |
| ----------- | --------------------------------------------------------------------------------------------------------- | ------------ |
| **Phase 1** | Monorepo, contracts, model abstraction, engine core, game catalogue, hazard taxonomy, docs                | **Complete** |
| Phase 2     | Game Master agent (Mastra), deterministic safety validator, `APPLY_GAME_MASTER_EVENT`                     | Next         |
| Phase 3     | Realtime multiplayer (WebSockets + Redis), MongoDB persistence, `packages/realtime` + `packages/database` | Planned      |
| Phase 4     | Sentry observability, Render + DigitalOcean GPU deployment, production hardening                          | Planned      |

**Mastra is not installed yet.** It is the intended agent framework, and it arrives in Phase 2 with
the agent that uses it. Installing a framework ahead of the code that needs it produces a dead
dependency; the seam it plugs into — `gameMasterTurnSchema` and `generateStructured()` — already
exists and is tested.

The same reasoning explains the missing `realtime/` and `database/` packages. The suggested structure
listed them; creating empty directories to match a diagram would have made the architecture look
complete while being less honest than a documented gap.
