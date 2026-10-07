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

## Not implemented yet

The Game Master agent (`src/agent/`) and its Mastra integration. Phase 3.
