# TouchGrass — AI Game Master

**The screen is the referee. The world is the game.**

TouchGrass runs real outdoor games, like tag and hide & seek, with an **open-weight model acting
as Game Master**. Players are outside, running. The server keeps the score, the roles and the
clock, and a locally hosted Gemma model proposes twists while a round is being played: a safe zone,
a bonus objective, a little more time.

**LLM proposes. Code validates. Engine executes.** The model never changes a game. Everything it
suggests is checked by deterministic code first, and anything unsafe, illegal or malformed is
dropped.

Built for the Hacktoberfest **Touch Grass** challenge.

---

## What a player does

1. A host creates a session and shares its address and join code.
2. Players connect from their phones and join. The server gives each one a player id and a token.
3. Everyone marks themselves ready. The engine hands out roles and starts the round.
4. People play outside. Players report what happened ("I tagged Bo"); the engine checks it and
   updates the score for everyone.
5. At the start of each round the Game Master may propose one event. If it passes every check, all
   players see it at once.
6. A player who loses signal reconnects and resumes as the same player.

**Multiplayer only.** Every game needs at least two players; there is no solo mode.

| Game             | Players | Playable today                               |
| ---------------- | ------- | -------------------------------------------- |
| Tag              | 2–4     | **Yes**                                      |
| Hide & Seek      | 2–4     | **Yes**                                      |
| Ice & Fire       | 4–16    | Not yet: the rules are defined, not playable |
| Treasure Hunt    | 2–24    | Not yet: the rules are defined, not playable |
| Nature Challenge | 2–30    | Not yet: the rules are defined, not playable |

Tag and Hide & Seek can be played **from the website**: create a game, share the link, and each
player joins on their own phone. The site is a client of the game server, so it needs one running
([Play from the website](#play-from-the-website)). Without one it still shows the games and their
rules, and says plainly that games cannot be started.

---

## How the Game Master works

```
Player
  ↓
Game Server                  one process: WebSocket rooms, sessions, the clock
  ↓
Game Master AI               Gemma via Ollama, called through a Mastra agent
  ↓
Structured Proposal          { rationale, event } as JSON, or "nothing this round"
  ↓
Schema Validation            is it exactly one well-formed event this game allows?
  ↓
Engine Legality              is it legal in this game, right now?
  ↓
Deterministic Safety         does it send anyone near a road, a roof, water…?
  ↓
Game Engine                  the only code that changes a game
  ↓
Realtime Broadcast           every player in that session is told
  ↓
Persistence                  the session is saved to MongoDB
```

### Why the AI cannot change the game directly

A language model can be confidently wrong. In testing, real model output named players and powers
that did not exist, and a model has no idea whether "the car park" is a safe place to send
children. So the model is only ever asked for a _value_:

- It is given a read-only view of the game and returns one proposed event, or none.
- It has no access to the session, the room, the database or the network. Its optional tools are
  read-only questions about its own game, run by the application.
- A proposal that is malformed, illegal, or matched by a safety rule changes nothing.
- If the model is slow, unreachable or switched off, the game is played exactly the same without it.

Players reach the same engine by their own route, with no model involved:

```
Client → PlayerAction → deterministic engine → GameEvent → GameState
```

More: [AI.md](./AI.md) for the pipeline, [SAFETY.md](./SAFETY.md) for the validator, and
[CONTRIBUTING.md](./CONTRIBUTING.md#the-safety-contract) for the short version every contributor
should read before touching AI code.

---

## Architecture at a glance

```
apps/web            Next.js: the website. Game catalogue, rules, and the game room players use
packages/
  shared            Result type, clock, ids, logger, environment schema
  game-definitions  The five games, as validated data
  game-engine       Pure, deterministic rules: actions, events, time, scoring
  game-session      One game's authoritative state, in memory
  realtime          WebSocket rooms, the wire protocol, session routing
  session-store     Where snapshots are kept: in memory, or MongoDB
  session-persistence  Explicit load / save / delete
  safety            Hazard taxonomy and the deterministic safety validator
  ai                Model providers, the Game Master agent, tools, evaluation
  server            Session registry, Game Master turns, observability, the production server
```

- The **engine** imports nothing from `ai` or `safety`. It can be read and trusted on its own.
- The **game server** is a single process that holds every loaded session in memory.

**Stack:** TypeScript, Node 24, npm workspaces, Next.js 16, Zod, `ws`, MongoDB, Mastra, Ollama with
Gemma, Vitest, Docker. Sentry is optional.

[ARCHITECTURE.md](./ARCHITECTURE.md) has every layer in detail.

---

## Quick start

**You need:** Node 22 or later (24 recommended) and npm. That is enough to run every test.

```bash
git clone https://github.com/SHWETANK-SAURABH/touchgrass_game_master.git
cd touchgrass_game_master
npm install
npm run verify       # format, lint, typecheck and the whole test suite
```

No database, no model and no Docker are needed for that. The tests use an in-memory store and a
scripted stand-in for the model.

### The web app

```bash
npm run setup        # copies .env.example to ./.env and apps/web/.env.local
npm run dev          # http://localhost:3000
```

On its own it lists the games, shows their rules and reports whether the AI model is running.
Starting a game needs the game server as well.

### Play from the website

Three things run: MongoDB, the game server, and the site. The site asks the game server to create
each game, so both are given the same `ADMIN_TOKEN` (any 32 or more characters; generate your own).

```bash
# 1. MongoDB (see below), then the game server, on port 3001:
npm run build:server
MONGODB_URI=mongodb://127.0.0.1:27017 ADMIN_TOKEN=<your-token> npm run start:server

# 2. In another terminal, the site:
GAME_SERVER_URL=http://127.0.0.1:3001 ADMIN_TOKEN=<your-token> npm run dev
```

Open <http://localhost:3000>, choose **Games**, pick Tag or Hide & Seek, and create a game. The
two site settings can also go in `apps/web/.env.local` instead of on the command line.

| Site setting         | What it is                                                                          |
| -------------------- | ----------------------------------------------------------------------------------- |
| `GAME_SERVER_URL`    | Where the site reaches the game server, e.g. `http://127.0.0.1:3001`                |
| `ADMIN_TOKEN`        | The game server's admin token. Used on the server side only                         |
| `GAME_SERVER_WS_URL` | Optional. The address browsers connect to, if it differs (`wss://…` behind a proxy) |

Phones on the same network need addresses they can reach: start the game server with
`SERVER_HOST=0.0.0.0` and set `GAME_SERVER_WS_URL=ws://<your-computer's-address>:3001`.

How it fits together: the browser never sees the admin token. `POST /api/sessions` on the site
calls the game server's `POST /admin/sessions` and hands the creator that one game's host token.
From then on the browser talks to the game server over the same WebSocket protocol as any other
client, and every action is checked by the engine. **Anyone who can open the site can create a
game**, so do not put it on the public internet without your own limits in front of it.

`vercel.json` describes a Vercel project with the website and the game server as two services.
It is untested there and has limits that matter for real games: see
[DEPLOYMENT.md](./DEPLOYMENT.md#vercel).

### MongoDB

The game server keeps sessions in MongoDB. Any local MongoDB works:

```bash
docker run -d --name touchgrass-mongo -p 27017:27017 mongo:8
```

### Ollama and Gemma (optional)

Only needed for the Game Master. Either use the bundled container:

```bash
npm run ai:up        # start Ollama in Docker
npm run ai:pull      # download gemma3:4b (about 3.3 GB, once)
```

or, with [Ollama](https://ollama.com) installed on your machine, `ollama pull gemma3:4b`. The
default `MODEL_BASE_URL` already points at `http://localhost:11434`.

### Configuration

Every variable is listed and explained in [.env.example](./.env.example). The game server reads its
environment directly and does not load a `.env` file, so set variables in your shell. Only
`MONGODB_URI` is required. Never commit real values.

---

## See it work

This is the shortest tested path from nothing to a played round. It needs MongoDB (above), and
Ollama only if you want to see the Game Master.

**Terminal 1: the game server**

```bash
npm run build:server

export MONGODB_URI=mongodb://127.0.0.1:27017
export ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
echo $ADMIN_TOKEN                 # copy this for terminal 2
export GAME_MASTER_ENABLED=true   # optional: needs Ollama with gemma3:4b
npm run start:server
```

**Terminal 2: the demo**

```bash
export ADMIN_TOKEN=<the value from terminal 1>
npm run demo:server
```

It creates a session, joins three players over WebSocket, starts a round, waits for the Game
Master's turn, makes a tag, shows an illegal action being refused, pauses and resumes as the host,
drops a player and resumes as the same player, and saves the game:

```
1. Session created: ws://127.0.0.1:3001/sessions/ses_…   join code ZG38KD
2. Three players joined: Ada, Bo, Cy
3. Round 1 started. Roles from the engine: Ada: runner, Bo: tagger, Cy: runner
4. Game Master event, checked and applied by the engine: "60s added to the round."
5. Bo tagged Ada. Scores: Ada 0, Bo 2, Cy 0
6. An illegal action is refused by the engine: INVALID_PLAYER
7. The host paused the game (paused) and resumed it (active)
8. Ada dropped and resumed as the same player: true
9. Saved to the database: true
```

Without `GAME_MASTER_ENABLED`, step 4 says there was no Game Master event and everything else is
the same. For an interactive server with terminal commands (`create`, `list`, `evict`, `gm`), use
`MONGODB_URI=… npm run sessions:dev`.

---

## Tests

```bash
npm run verify       # everything a pull request must pass
npm test             # the tests alone
npm run typecheck
npm run lint
npm run build        # the web app
npm run build:server # the game server
```

Three kinds of test are opt-in, because they need something running:

| What                         | How                                                   |
| ---------------------------- | ----------------------------------------------------- |
| Against a real MongoDB       | `MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test` |
| Against the real model       | `npm run ai:live`                                     |
| Model evaluation, with rates | `GAME_MASTER_LIVE_EVAL=1 npm run ai:live`             |

---

## Running in production

```bash
npm run build:server
MONGODB_URI=… ADMIN_TOKEN=… npm run start:server
```

or as a container, with a MongoDB beside it:

```bash
export ADMIN_TOKEN=<at least 32 characters>
docker compose -f docker-compose.prod.yml up --build -d
SMOKE_BASE_URL=http://127.0.0.1:3001 npm run smoke:server
docker compose -f docker-compose.prod.yml down
```

The server answers `GET /healthz` (alive) and `GET /readyz` (the database answers), stops
gracefully on `SIGTERM`, and creates sessions through an admin endpoint guarded by `ADMIN_TOKEN`.
Set `SESSION_TOKEN_KEY` and keep it the same across restarts if players should be able to resume
after one.

[DEPLOYMENT.md](./DEPLOYMENT.md) covers configuration, health, shutdown, the reverse proxy and what
happens when a dependency is away. It has been run in Docker on a developer machine. It has not
been deployed to a cloud provider.

---

## Known limitations

- **The website's game room is simple.** Players report what happened by tapping a button; nothing
  is detected by location or sensors. It has been run in desktop and phone-sized Chrome on one
  machine, not on a range of real phones.
- **Anyone who can reach the website can create a game.** There are no accounts and no rate limit.
- **Two playable games.** Tag and Hide & Seek. The other three are definitions only.
- **Single process.** One server holds every session in memory. There is no Redis and no horizontal
  scaling, and two instances must not share a database.
- **No player authentication.** A session id and join code are enough to join. Tokens are bearer
  capabilities. Use TLS at a reverse proxy.
- **No periodic save.** A session is saved when it is created, evicted, shut down gracefully, after
  a Game Master event, or on request. A killed process loses what happened since.
- **The clock is the production server's.** It tells every loaded game the time once a second
  (`SESSION_TICK_MS`), which is what ends rounds. The development servers (`sessions:dev`,
  `server:dev`) have no such clock: there a round ends when a message arrives after its end time.
- **The safety validator is a rule list, in English.** It refuses what it recognises. It does not
  know the place a game is played and does not make outdoor play safe. See [SAFETY.md](./SAFETY.md).
- **The Game Master is narrow.** In testing the local model almost always chose to extend the
  round.

---

## Contributing

New contributors are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) has the setup, the workflow and
what a pull request needs.

**Good first contributions**

- Documentation fixes and clearer explanations.
- More safety test cases: instructions that must be refused, and safe ones that must not be.
- More evaluation scenarios for the Game Master.
- Game content: clearer rule text, better Game Master guidance for an existing game.
- Accessibility and layout fixes in the web app.
- Tests for an edge case you found.

**Advanced contributions**

- Tests for the website's game room in a real browser, and trying it on real phones.
- Making Ice & Fire, Treasure Hunt or Nature Challenge playable in the engine.
- A new deterministic game event, end to end.
- A new read-only Game Master tool.
- Localisation, including safety rules for another language.
- Observability: a metrics endpoint format, a stored audit trail.

Anything that touches the AI must keep the model's output **proposal-only**, passing through the
existing schema, engine and safety checks. Please read
[the safety contract](./CONTRIBUTING.md#the-safety-contract) first, and do not loosen the safety
validator to make a feature work.

---

## Documentation

| Document                                                | Covers                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                    | Setup, workflow, testing, the safety contract, where to help       |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                    | Every layer, the roadmap, and why the pieces are split as they are |
| [AI.md](./AI.md)                                        | The Game Master, tools, the turn record, evaluation                |
| [SAFETY.md](./SAFETY.md)                                | The hazard taxonomy and the validator, and what it cannot do       |
| [DEPLOYMENT.md](./DEPLOYMENT.md)                        | Running the game server: configuration, health, shutdown, limits   |
| [GAME_ENGINE.md](./packages/game-engine/GAME_ENGINE.md) | Actions, events, state, lifecycle, determinism                     |

Each package has its own README describing its boundary.

---

## Why an open-weight model

- **A Game Master turn is in the players' critical path.** Self-hosted inference means the latency
  budget is ours to tune.
- **The players are often children.** Names and the places they describe never leave hardware you
  control.
- **A game night should not depend on a billing status.** `ollama pull gemma3:4b` and it works
  offline, in a park.
- **The weights can be swapped.** The safety argument rests on deterministic validation, not on
  trusting a model, and that only works if the model is a replaceable part. Nothing outside
  `packages/ai/src/provider/` names a runtime.

---

## License

MIT. See [LICENSE](./LICENSE).
