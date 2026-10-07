# TouchGrass — AI Game Master

**The screen is the referee. The world is the game.**

TouchGrass runs real outdoor games — tag, hide & seek, ice & fire, treasure hunts, nature
challenges — with an **open-weight model acting as Game Master**. The model does not narrate from
the sidelines. It changes the rules of play while the round is running: tightening how bodies may
move, shrinking the boundary, rebalancing two forces that have drifted apart, writing a riddle about
the bench you are standing next to.

Everything it proposes is checked by deterministic code before a single player hears it.

```
AI proposes  →  Zod checks shape  →  Engine checks legality  →  Safety checks risk  →  Engine executes
```

The model never touches game state. That is the whole architecture in one line, and the reason the
pieces are split the way they are.

> **Status: Phase 4 — safety validator.** Tag and Hide & Seek are fully playable through the
> deterministic engine with no AI. A Game Master — a Mastra agent running Gemma through a local
> Ollama — reads a game and returns a structured event proposal. A proposal can be handed off: the
> engine checks that it is legal, a deterministic safety validator checks it against the game's
> safety policy, and the engine applies it only if both pass. The safety validator is a fixed set of
> rules, not a guarantee that play is safe — see [SAFETY.md](./SAFETY.md). **Not built yet:**
> anything in the app that calls the Game Master, realtime multiplayer, persistence, and a game UI.
> See [ARCHITECTURE.md § Roadmap](./ARCHITECTURE.md#13-roadmap).

---

## Why an open-weight model is the point

A closed API behind a per-token bill would make this product worse, not just more expensive:

- **A Game Master turn sits in a player's critical path.** Twelve people are standing in a field
  waiting for the next twist. Self-hosted inference means the latency budget is ours to tune, not a
  vendor's to meter.
- **The players are often children.** Session text — names, locations described aloud, the
  landmarks they chose — never leaves hardware we control.
- **A game night cannot depend on someone's billing status.** `ollama pull gemma3:4b` and the
  Game Master works offline, in a park, on a laptop hotspot.
- **The weights can be inspected and swapped.** The safety argument in [SAFETY.md](./SAFETY.md)
  rests on deterministic validation rather than on trust in a model, which only works if the model
  is a replaceable component.

[AI.md](./AI.md) goes into the agent design; [ARCHITECTURE.md § 11](./ARCHITECTURE.md#11-model-abstraction)
covers how the provider stays swappable.

---

## Quick start

**Requirements:** Node 24 (or ≥ 22), and either Docker or a local [Ollama](https://ollama.com)
install.

```bash
git clone https://github.com/SHWETANK-SAURABH/touchgrass_game_master.git
cd touchgrass_game_master

npm install
npm run setup        # copies .env.example to ./.env and apps/web/.env.local

npm run ai:up        # start the Ollama container
npm run ai:pull      # download gemma3:4b into it (a few GB, once)

npm run dev          # http://localhost:3000
```

The landing page shows live model-runtime status. If it reports _degraded_, the panel tells you
which command to run — the app itself still works, because game rules and the lobby are local data.

Already running Ollama on the host? Skip `ai:up` / `ai:pull` and just
`ollama pull gemma3:4b`; the default `MODEL_BASE_URL` already points at `localhost:11434`.

### Scripts

| Command                 | What it does                                              |
| ----------------------- | --------------------------------------------------------- |
| `npm run dev`           | Next.js dev server                                        |
| `npm run build`         | Production build (standalone output)                      |
| `npm run verify`        | Format check → lint → typecheck → tests. The CI gate.     |
| `npm test`              | Vitest, whole workspace                                   |
| `npm run typecheck`     | `tsc --noEmit` in every workspace                         |
| `npm run lint`          | ESLint with type-aware rules                              |
| `npm run format`        | Prettier, write mode                                      |
| `npm run ai:up / :down` | Start / stop the local model runtime                      |
| `npm run ai:pull`       | Pull `MODEL_NAME` into the runtime                        |
| `npm run ai:logs`       | Tail the model runtime logs                               |
| `npm run ai:live`       | Manual test: one real Game Master call to the local model |

GPU on the host? `docker compose --profile gpu up -d ollama-gpu`.

---

## Repository layout

```
apps/
  web/                    Next.js 16 App Router — UI, API routes
packages/
  shared/                 Result, seeded RNG, clock, ids, logger, env schema
  game-definitions/       GameDefinition schema + the five games, as data
  game-engine/            Deterministic engine: actions, events, time, scoring, winners
  safety/                 Hazard taxonomy, policy, and the deterministic safety validator
  ai/                     ModelProvider + adapters, and the Game Master (Mastra agent)
```

Imports between workspaces, as they are in the code today (no cycles):

| Workspace          | Imports                                               |
| ------------------ | ----------------------------------------------------- |
| `shared`           | nothing                                               |
| `game-definitions` | nothing                                               |
| `game-engine`      | `game-definitions`, `shared`                          |
| `safety`           | `game-definitions`, `game-engine`, `shared`           |
| `ai`               | `game-definitions`, `game-engine`, `safety`, `shared` |
| `apps/web`         | `ai`, `game-definitions`, `safety`, `shared`          |

The engine imports nothing from `ai` or `safety`, so it can be read, tested, and trusted without
opening a line of AI code. `safety` uses the engine's event types and one function that recognises
an engine-validated event; it calls nothing that changes a game. The game event schema a model's output must satisfy lives in the engine;
the AI package's tests validate generated output against it.

There is deliberately **no `realtime/` or `database/` package yet.** An empty package that exists to
make a diagram look complete is worse than an honest gap — those arrive in a later phase, with the
code that needs them.

---

## Documentation

| Document                                                | Covers                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                    | System design, every layer, local and production topology, roadmap           |
| [AI.md](./AI.md)                                        | What "agent" means here, structured output, why the LLM is not the engine    |
| [GAME_ENGINE.md](./packages/game-engine/GAME_ENGINE.md) | Actions, events, state, lifecycle, validation, determinism                   |
| [SAFETY.md](./SAFETY.md)                                | The hazard taxonomy, the validator design, what the AI is never trusted with |

Each package also has its own README describing its boundary.

---

## Adding a game

Game rules are **data**, not code. A new game is one validated file in
`packages/game-definitions/src/games/`:

```ts
export const captureTheFlag = defineGame({
  id: 'capture-the-flag',
  // ... roles, phases, allowedEventKinds, safety profile, Game Master guidance
});
```

`defineGame` parses it at module load, so a malformed definition breaks the test suite rather than a
live session. The schema enforces real invariants: exactly one overflow role, roles that cannot
demand more players than `minPlayers` allows, a safety ceiling that cannot sit below the game's own
intensity, and a non-empty list of things the Game Master must never propose.

Register it in `registry.ts`, run `npm run verify`, and the game appears in the UI with its rules,
roles, phases and safety profile rendered from the definition itself.

---

## Engineering principles

1. **Deterministic logic lives outside the model.** The engine is a pure function; all randomness
   and clock access is injected, so a session replays identically from its log.
2. **Raw model output is never trusted.** Grammar-constrained decoding, then Zod, then the engine's
   legality check, then a separate deterministic safety pass.
3. **The model is replaceable.** Nothing outside `packages/ai/src/provider/` names a runtime.
4. **No fake integrations.** If a dependency is not used yet, it is not installed yet.
5. **Fail closed, and say why.** Every refusal carries a machine-readable code and a sentence a
   human can act on.

---

## License

MIT — see [LICENSE](./LICENSE).

Built for the Hacktoberfest **Touch Grass** challenge.
