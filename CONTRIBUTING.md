# Contributing to TouchGrass

Thank you for looking. This guide gets you from a fresh clone to a pull request, and tells you the
one rule that matters most before you touch anything to do with the AI.

Every command below exists in this repository and was run while writing this guide.

---

## Setup

**You need**

- **Node 22 or later.** The repository pins 24 in `.nvmrc`.
- **npm**, which comes with Node. This is an npm workspaces monorepo; do not use yarn or pnpm.
- Nothing else for most contributions. MongoDB, Ollama and Docker are needed only for the optional
  parts described below.

```bash
git clone https://github.com/<your-fork>/touchgrass_game_master.git
cd touchgrass_game_master
npm install
npm run verify
```

If `npm run verify` passes, your setup is complete. It runs the format check, the linter, the
typechecker and the whole test suite, and it needs no database, no model and no network.

For the web app, also run `npm run setup` once (it copies `.env.example` to `./.env` and
`apps/web/.env.local`) and then `npm run dev` for http://localhost:3000.

### The commands you will use

| Command                | What it does                                                      |
| ---------------------- | ----------------------------------------------------------------- |
| `npm run verify`       | Format check, lint, typecheck, tests. A pull request must pass it |
| `npm test`             | The tests alone                                                   |
| `npm run test:watch`   | The tests, re-run as you edit                                     |
| `npm run typecheck`    | `tsc --noEmit` in every workspace                                 |
| `npm run lint`         | ESLint. `npm run lint:fix` fixes what it can                      |
| `npm run format`       | Prettier, writing changes. Run it before you commit               |
| `npm run build`        | Builds the web app                                                |
| `npm run build:server` | Bundles the game server into `dist/server`                        |
| `npm run dev`          | The web app, with hot reload                                      |

To run one test file: `npx vitest run packages/game-engine/src/tag.test.ts`.

---

## Workflow

1. **Fork** the repository and clone your fork.
2. **Branch** from `main`: `git checkout -b fix/short-description`.
3. **Change one thing.** A small pull request that does one thing is reviewed quickly.
4. **Add or update tests** for what you changed.
5. **Run `npm run format` and then `npm run verify`.**
6. **Commit** and **open a pull request** against `main`.

### Commits

Use a short conventional subject line, as the history does:

```
feat(engine): add a freeze modifier
fix(realtime): close the room before the listener
docs: explain the join code
test(safety): add riverbank cases
```

The type is one of `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. The scope is the package you
changed, when there is one.

### Pull requests

A pull request should say what changed and why, and how you tested it. Before you open one:

- `npm run verify` passes.
- New behaviour has a test. A bug fix has a test that fails without the fix.
- Documentation that describes what you changed is updated.
- No secret, token or connection string is in the diff.
- The change does not weaken or delete an existing test to make something pass. If a test is
  wrong, say so in the pull request.

---

## How the code is organised

```
packages/shared              small utilities used everywhere
packages/game-definitions    the five games, as data
packages/game-engine         the rules. Pure and deterministic
packages/game-session        one game's state, in memory
packages/realtime            WebSocket rooms and the wire protocol
packages/session-store       where snapshots are kept
packages/session-persistence load, save, delete
packages/safety              the deterministic safety validator
packages/ai                  model providers, the Game Master, tools, evaluation
packages/server              the session registry and the game server
apps/web                     the Next.js site
```

Three habits of this codebase are worth knowing:

- **Expected failures are values.** Functions return `Result<T, E>` (`ok(...)` or `err(...)`) from
  `@touchgrass/shared` instead of throwing. An error has a stable `code`.
- **Time and randomness are passed in.** The engine never reads a clock. Tests use a fixed clock,
  which is why they are exact.
- **Anything from outside is validated with Zod**: client messages, model output, environment
  variables.

Each package has a README that says what it owns and what it must not do. Many packages also have
tests that read the source and fail if a boundary is crossed, for example if the engine starts
importing the AI package. If one of those fails, you have probably put code in the wrong package.

---

## The safety contract

**Read this before changing anything in `packages/ai`, `packages/safety`, or how a Game Master
event reaches a game.**

The model is never trusted. It proposes; code decides.

```
1. The model proposes one event.          a JSON value, nothing more
2. The proposal is schema validated.      is it exactly one well-formed event this game allows?
3. The engine checks legality.            is it legal in this game, right now?
4. The safety layer checks policy.        deterministic rules: roads, heights, water, duration…
5. Only then does the engine apply it.    the engine is the only code that changes a game
6. The result is broadcast and saved.     like any other change
```

What this guarantees, and what your change must keep true:

- **Malformed model output is rejected.** Prose, broken JSON, an unknown event type, an extra
  field or a list of events is not a proposal. Nothing is repaired or guessed.
- **A refusal at any step changes nothing.** Nothing is applied, broadcast or saved.
- **Unknown tools are rejected.** The Game Master can use only the tools the application lists.
- **Tool inputs and outputs are bounded.** Input is checked against the tool's schema; a tool has a
  time limit and an output size limit; a turn makes at most a few tool calls.
- **Tools cannot change a game.** A tool is handed one game's frozen state and nothing else. If a
  future tool should cause a change, it must return a proposal that goes through steps 2 to 5.
- **AI failure does not corrupt the game.** A model that is slow, unreachable or wrong ends its
  own turn. Players are unaffected.

So, for any AI-related contribution:

- **AI output stays proposal-only.** Never give model-facing code a session, a room, the store, or
  a function that mutates state.
- **Do not add a second way into the engine** for AI events.
- **Do not loosen the safety validator to make a feature work.** If a safe instruction is being
  refused, add it to the "must be allowed" tests and fix the rule that is too broad.
- **The safety validator stays deterministic.** No model calls, no network, no randomness.
- **Add tests on both sides.** For a safety rule: something that must be refused, and something
  similar that must be allowed.

`packages/safety/src/regression.test.ts` and the golden scenarios in `packages/ai/src/eval/golden.ts`
exist to catch a change that breaks this. If they fail, the change is wrong, not the tests.

The longer explanations are in [AI.md](./AI.md) and [SAFETY.md](./SAFETY.md).

---

## Testing your change

### AI features, without a model

You do not need Ollama. Every test of the Game Master replaces the model with a script:

```ts
import { runEvalCase } from '@touchgrass/ai/eval';

const result = await runEvalCase({
  id: 'my-case',
  description: 'A zone in a car park is refused.',
  replies: [{ rationale: 'A quick change of scene.', event: { type: 'ZONE_CHANGE', … } }],
  expected: { outcome: 'REJECTED', stage: 'SAFETY' },
});
```

The real agent, schema, engine and safety validator run; only the model's replies are scripted. To
add a scenario, add a case to `packages/ai/src/eval/golden.ts`. To test a safety rule on its own,
add to the tables in `packages/safety/src/regression.test.ts`.

### Multiplayer features

Most multiplayer tests drive a room directly with fake connections, which is fast and exact; see
`packages/realtime/src/room.test.ts`. Tests that need real sockets start a server on a free port
inside the test; see `packages/server/src/session-server.test.ts` and its helpers in
`socket-test-support.ts`. Neither needs a database: they use the in-memory store.

Tests must not depend on timing. Use the test clock, and hold a store call open rather than
sleeping; the helpers show how.

To try it by hand you need a MongoDB:

```bash
docker run -d --name touchgrass-mongo -p 27017:27017 mongo:8
MONGODB_URI=mongodb://127.0.0.1:27017 npm run sessions:dev
```

That starts a server with a terminal: type `create` to make a game and it prints the address, the
join code and the host token. `npm run demo:server` plays a whole scripted round against a running
production server; the [README](./README.md#see-it-work) shows how.

On Windows PowerShell, set a variable with `$env:MONGODB_URI = 'mongodb://127.0.0.1:27017'` on its
own line before the command.

### Optional tests

These are skipped unless you ask for them, and a pull request does not need them:

| What                         | How                                                   | Needs                                  |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------- |
| Store and server on MongoDB  | `MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test` | A MongoDB. It uses throwaway databases |
| The Game Master on a model   | `npm run ai:live`                                     | Ollama with `gemma3:4b`                |
| Model evaluation, with rates | `GAME_MASTER_LIVE_EVAL=1 npm run ai:live`             | The same                               |
| A running production server  | `ADMIN_TOKEN=… npm run smoke:server`                  | The server, started first              |

For the model: `npm run ai:up` and `npm run ai:pull` start Ollama in Docker and download the model,
or install [Ollama](https://ollama.com) and run `ollama pull gemma3:4b`.

---

## Where to help

### Good first contributions

- **Documentation.** Anything that confused you while setting up is worth a fix.
- **Safety test cases.** Add an instruction that must be refused, or a safe one that is wrongly
  refused, to `packages/safety/src/regression.test.ts`.
- **Evaluation scenarios.** Add a case to `packages/ai/src/eval/golden.ts`.
- **Game content.** Improve the rule text or the Game Master guidance of a game in
  `packages/game-definitions/src/games/`.
- **Web app polish.** Accessibility, mobile layout, clearer wording in `apps/web`.
- **Tests** for an edge case that has none.

### Advanced contributions

Please open an issue to discuss these first, so nobody builds something that cannot be merged.

- **A browser game client.** There is none. It would speak the protocol in
  `packages/realtime/src/protocol.ts`.
- **Making a third game playable.** Ice & Fire, Treasure Hunt and Nature Challenge are defined but
  the engine does not run them yet.
- **A new deterministic game event**, with its engine rule, its safety cases and its tests.
- **A new read-only Game Master tool**, following `packages/ai/src/tools/game-tools.ts`.
- **Localisation.** The safety rules are English only; another language needs its own rules and
  its own tests, not a translation of the prompts.
- **Observability.** A metrics endpoint format, or a stored audit trail.
- **Gameplay balancing**, with a reason and tests for the numbers.

Out of scope for now: Redis, multiple server instances, an authentication system, and anything
that gives the model a way to act.

### Adding a game

Game rules are data. A game is one validated file in `packages/game-definitions/src/games/`, built
with `defineGame`, and registered in `registry.ts`. The schema is checked when the module loads, so
a malformed definition fails the tests. A new definition appears in the web app's catalogue at once.
Making it _playable_ is engine work and belongs under advanced contributions.

---

## Reporting a problem

Open an issue with what you did, what you expected and what happened. For a suspected security
problem, please do not include working exploit details in a public issue; describe the area and
the impact, and a maintainer will follow up. This project has no private reporting address yet.

## License

By contributing you agree that your contribution is licensed under the project's
[MIT license](./LICENSE).
