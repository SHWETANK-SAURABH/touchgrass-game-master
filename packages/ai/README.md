# @touchgrass/ai

The model boundary. Nothing outside `src/provider/` names a runtime — see
[AI.md](../../AI.md) for the reasoning.

## The port

```ts
interface ModelProvider {
  id: string;
  model: string;
  baseUrl: string;
  health(options?): Promise<ProviderHealth>;
  generateText(request): Promise<GenerateTextResult>;
  generateJson(request): Promise<GenerateJsonResult>;
}
```

Small on purpose: no streaming, no embeddings, no tool calling, no chat-session abstraction. The Game
Master needs one JSON object per turn within a deadline. A port that promises only what is required is
one any open-weight runtime can satisfy.

## Two adapters

| Adapter             | Endpoint                    | Structured output                             | Role        |
| ------------------- | --------------------------- | --------------------------------------------- | ----------- |
| `ollama`            | `POST /api/chat`            | `format: <JSON Schema>`                       | Development |
| `openai-compatible` | `POST /v1/chat/completions` | `response_format: { type: 'json_schema', … }` | Production  |

Both ship in Phase 1 because an abstraction with one implementation is an untested guess. Writing the
second is what proved the port was provider-shaped rather than accidentally Ollama-shaped.

## `structured.ts` — grammar, then validation, then repair

1. **Grammar** — the Zod schema becomes JSON Schema and constrains decoding. This is the main reason a
   4B model is viable: malformed structure becomes largely unreachable rather than merely unlikely.
2. **Validation** — the result is re-parsed with the same Zod schema. Grammar guarantees shape, not
   meaning; a well-formed `durationSeconds: 300` can still break a rule.
3. **Repair** — on a schema failure, or a reply that is not JSON at all, the model is told what was
   wrong, shown its own rejected output, and asked once more. Bounded, default one extra attempt.
   Transport faults (unreachable host, timeout) are not repaired; they are thrown to the caller.

Nothing here decides whether output is _safe_. That is a separate deterministic pass over validated
data — see `@touchgrass/safety`.

## Testing without a GPU

The adapters are tested with `vi.stubGlobal('fetch')`; the repair loop uses a scripted test double
declared inside the test file. CI needs no model. There is **no fake provider in `src`** — a test
double is not a shipped integration.

## The Game Master

`@touchgrass/ai/game-master` — one Mastra agent with no tools. See [AI.md](../../AI.md).

```ts
import { createGameMasterFromEnv } from '@touchgrass/ai/game-master';

const gameMaster = createGameMasterFromEnv(getServerEnv());
const result = await gameMaster.propose({ state, definition, now });
// result.value.proposal → { rationale, event | null }
```

It returns a proposal and does nothing else: it has no access to the engine's entry points, and
nothing in this package applies a proposal. If the model runtime is unreachable or the model has not
been pulled, `propose` returns `MODEL_UNAVAILABLE`; it never falls back to another model.

The agent's model is `createProviderLanguageModel(provider)`, an adapter over `ModelProvider`, so
the runtime is still selected by `MODEL_PROVIDER`, `MODEL_NAME` and `MODEL_BASE_URL` alone.

`npm run ai:live` runs `game-master.live.ts`, a manual test that makes a real call to the configured
model. It is not part of `npm test`.

## The hand-off

`@touchgrass/ai/handoff` — the only module in this package that passes anything to the game engine.

```ts
import { runGameMasterTurn } from '@touchgrass/ai/handoff';

const result = await runGameMasterTurn({ gameMaster, state, ctx });
// ok:  { outcome: 'APPLIED' | 'NO_EVENT', state, proposal }
// err: { stage: 'PROPOSAL' | 'SCHEMA' | 'STATE' | 'SAFETY' | 'APPLICATION', ... }
```

It owns no game rules and no safety rules. A proposal is checked by the engine's
`validateExternalEvent`, then by `validateSafety` from `@touchgrass/safety`, and only then applied by
the engine's `applyValidatedEvent`. Schema-valid does not mean game-valid: a proposal that names a
player, role or power that does not exist is refused. Domain-valid does not mean safe: a legal event
that matches a safety rule is refused at the `SAFETY` stage with its verdict. In every refusal the
state is returned unchanged, the event is not rewritten, and the model is not asked again.

An optional `safety` argument (`{ supervisedByAdult, maxRuleDurationSeconds }`) is passed to the
policy. It can make a session stricter; it cannot switch a check off or cause an event to be applied.

## Tools

`createGameMaster({ provider, tools })` may be given read-only tools. The agent itself is still
built with no native tools: a tool call is a structured reply, `{"tool":{"name":…,"input":…}}`,
which this package checks and runs, and then asks the model again with the answer.

- `tools/tool.ts`: the `GameMasterTool` interface, `createToolSet` (the allowlist), and
  `runToolCall`, which turns every way a call can go wrong into a code.
- `tools/game-tools.ts`: the two tools that exist, `game_history` and `game_rules`, and
  `selectGameMasterTools(names)`.
- A turn makes at most `maxToolCalls` calls (default 2, never more than 4). After that only a
  proposal is accepted.
- With no tools, the model is asked exactly as before.

## Evaluation: `@touchgrass/ai/eval`

`runEvalCase(case)` runs one case through the real Game Master, schema, engine and safety
validator with a scripted model and returns `{ caseId, passed, expected, actual, stage, reason,
durationMs }`. `GOLDEN_CASES` is the fixed set of scenarios; `runEvaluation` adds up rates.
`eval/game-master.eval.live.ts` measures the real model and runs only with
`GAME_MASTER_LIVE_EVAL=1 npm run ai:live`.

## What is not in this package

Nothing in this package decides when to ask the Game Master, and nothing here calls
`runGameMasterTurn` on its own. For a live session that decision, and the path from an applied
event to the room and the store, are in `@touchgrass/server` (`game-master-turns.ts`).

Two things this package provides for that:

- `handOffProposalTo(target, proposal, ctx, safety)` is the same hand-off for something that holds
  a game, such as a live session. It validates against the target's state at the moment of the
  call and hands the target only what the safety package released. `handOffProposal` is this
  function for a plain state.
- The view shown to the model never contains the join code. The engine's first history summary
  names it, so it is replaced with `[join code]` when the view is built.
