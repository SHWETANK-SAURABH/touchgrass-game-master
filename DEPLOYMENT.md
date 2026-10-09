# Deploying the game server

This is how to run the TouchGrass game server outside a developer's terminal: what to deploy, what
it needs, how it reports its health, how it stops, and what it does not yet do.

It describes a single process on a single machine. It has been run as a container on a developer
machine with Docker. It has not been deployed to any cloud provider.

---

## 1. Architecture

```
players' devices ── wss ──► reverse proxy / load balancer      TLS ends here
                                  │  http + websocket upgrade
                                  ▼
                        ┌──────────────────────┐
                        │   game server        │  one Node process, one port
                        │   WebSocket listener │
                        │   session registry   │
                        │   Game Master turns  │
                        │   /healthz /readyz   │
                        └───┬──────────┬───────┘
              snapshots     │          │  proposals (optional)
                            ▼          ▼
                        MongoDB     Ollama ──► Gemma weights
                        required    optional, somewhere else
                                         │
                        Sentry ◄─────────┘  optional, errors only (from the game server)
```

The rule the whole system is built on is unchanged by deployment:

**AI proposes → schema validation → engine legality → deterministic safety → engine mutation →
realtime broadcast → persistence.** The model never changes a game.

### What is deployed

| Piece                 | Entry point                     | Image               |
| --------------------- | ------------------------------- | ------------------- |
| **Game server**       | `packages/server/src/main.ts`   | `Dockerfile.server` |
| Website (games, play) | `apps/web` (Next.js standalone) | `Dockerfile`        |

The game server is the production path. It is the only entry point that has multiplayer, the Game
Master, tools, persistence and observability together: it wraps `startSessionServer`, which the
development command `npm run sessions:dev` also uses. `npm run server:dev` and
`npm run realtime:dev` are single-game development servers and are not for deployment.

The website is a separate, optional process. Given `GAME_SERVER_URL` and the game server's
`ADMIN_TOKEN`, it lets people create and play games: its server side calls `POST /admin/sessions`,
and browsers then connect to the game server's WebSocket address directly (`GAME_SERVER_WS_URL` if
that differs from `GAME_SERVER_URL`, for example `wss://…` behind a TLS proxy). The admin token
stays on the site's server. Anyone who can open the site can create a game, so limit who can reach
it or put a rate limit in front of it. This pairing has been run on a developer machine only.

### Vercel

`vercel.json` at the repository root describes one Vercel project with two
[services](https://vercel.com/docs/services):

| Service | What it is                                      | Public paths    |
| ------- | ----------------------------------------------- | --------------- |
| `web`   | The website, `apps/web`, built as Next.js       | Everything else |
| `game`  | The game server, built from `Dockerfile.vercel` | `/sessions/…`   |

`web` reaches `game` over a service binding: Vercel sets `GAME_SERVER_URL` for it, so do not set
that variable yourself. Only the WebSocket path is public. `/admin/…`, `/healthz` and `/readyz` are
reachable through the binding and not from the internet.

This configuration has **not** been deployed to Vercel or tested there. Locally, the site builds
with `next build`, the image builds from `Dockerfile.server`, and the code paths are unit-tested.

Set these in the project's environment variables:

| Variable             | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `GAME_SERVER_WS_URL` | `same-origin`: browsers connect to the site's own address             |
| `ADMIN_TOKEN`        | 32 or more characters of your own. Mark it sensitive                  |
| `MONGODB_URI`        | A MongoDB the game server can reach, for example MongoDB Atlas        |
| `SESSION_TOKEN_KEY`  | Base64 of 32 or more random bytes, so player tokens outlive a restart |
| `PORT`               | `3001`, the port the game server's image listens on                   |

**Read this before relying on it for real games.** Vercel runs a container service as Vercel
Functions, and the game server was written as one long-running process. Three things follow, all
from Vercel's own documentation:

- **Players of one game can land on different instances.** A new connection can reach any
  instance, and each instance keeps its own copy of a game in memory. Two instances that both load
  the same game do not see each other's players or actions, and each saves over the other. The
  game server has no shared store for live games (no Redis), so it is correct only while exactly
  one instance is running. Under light use that is the usual case; it is not guaranteed.
- **A connection is closed when the function reaches its maximum duration**: 300 seconds on
  Hobby, up to 800 seconds on Pro. A round of Hide & Seek is 300 seconds and a game is three
  rounds. The site reconnects by itself, but the new connection may reach another instance.
- **An instance with no traffic is stopped** after five minutes in production. The game server
  saves its games when it is asked to stop, and loads a game again when someone reconnects.

For games that must not break, run the game server as a single long-running container on a host
built for that, keep only the website on Vercel, and set `GAME_SERVER_URL` to its `https://`
address yourself (remove the `game` service, its rewrite and the binding from `vercel.json`).

Also true on Vercel:

- **The site is public, so anyone can create a game.** There are no accounts and no rate limit.
  Use Vercel's deployment protection or firewall rules if that matters.
- **The Game Master status box** reports whether the site can reach `MODEL_BASE_URL`. On Vercel
  that is not your local Ollama, so it reads as not running unless you point it at a reachable
  runtime.

The game server process owns every WebSocket connection, is the only process that connects to
MongoDB, and is the only process that calls the model runtime.

---

## 2. Required services

| Service        | Required | Notes                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------ |
| MongoDB        | yes      | Any MongoDB the official driver supports. Tested with 8.0                |
| Ollama + Gemma | no       | Only with `GAME_MASTER_ENABLED=true`. Runs elsewhere; never in the image |
| Sentry         | no       | Only with `SENTRY_ENABLED=true`                                          |
| Reverse proxy  | for TLS  | The server speaks plain HTTP and WebSocket                               |

Node 22 or later (the image uses Node 24).

---

## 3. Environment variables

All configuration is read once at start-up by `parseProductionConfig`. If anything is wrong the
server prints the names of the variables that are wrong, never their values, and exits with
status 1 without starting.

**Required**

| Variable      | Meaning                   |
| ------------- | ------------------------- |
| `MONGODB_URI` | MongoDB connection string |

**Important**

| Variable            | Meaning                                                                                                              | Default                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `ADMIN_TOKEN`       | Bearer value for the admin endpoints, 32–256 characters. Without it they do not exist, and no session can be created | none                                   |
| `SESSION_TOKEN_KEY` | Base64 of at least 32 random bytes. With it, players can resume after a restart                                      | none                                   |
| `SERVER_HOST`       | Address to listen on                                                                                                 | `127.0.0.1` (the image sets `0.0.0.0`) |
| `SERVER_PORT`       | Port for HTTP and WebSocket                                                                                          | `3001`                                 |
| `MONGODB_DATABASE`  | Database name                                                                                                        | `touchgrass`                           |

Generate the two values, and keep them out of version control:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # ADMIN_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # SESSION_TOKEN_KEY
```

**Optional**

| Variable                   | Meaning                                              | Default                  |
| -------------------------- | ---------------------------------------------------- | ------------------------ |
| `MONGODB_COLLECTION`       | Collection name                                      | `sessions`               |
| `MONGODB_TIMEOUT_MS`       | How long a store operation may look for a server     | `5000`                   |
| `SESSION_IDLE_MS`          | Evict a session with no connection for this long     | 30 minutes               |
| `SESSION_FINISHED_IDLE_MS` | The same, once its game is over                      | `0`                      |
| `SESSION_SWEEP_MS`         | How often to look for sessions to evict              | 1 minute                 |
| `WS_HEARTBEAT_MS`          | Ping interval for attached sockets; `0` turns it off | `30000`                  |
| `SHUTDOWN_TIMEOUT_MS`      | A shutdown not finished by then is abandoned         | `25000`                  |
| `SESSION_TICK_MS`          | How often games are told the time; `0` turns it off  | `1000`                   |
| `GAME_MASTER_ENABLED`      | Give the games a Game Master                         | `false`                  |
| `GAME_MASTER_TIMEOUT_MS`   | How long one turn may wait for the model             | `20000`                  |
| `GAME_MASTER_TOOLS`        | Read-only tools, e.g. `game_history,game_rules`      | none                     |
| `MODEL_PROVIDER`           | `ollama` or `openai-compatible`                      | `ollama`                 |
| `MODEL_NAME`               | The model tag                                        | `gemma3:4b`              |
| `MODEL_BASE_URL`           | Where the model runtime listens                      | `http://localhost:11434` |
| `MODEL_API_KEY`            | Only for a gateway that needs one                    | none                     |
| `MODEL_REQUEST_TIMEOUT_MS` | One request to the runtime                           | `30000`                  |
| `MODEL_MAX_RETRIES`        | Transport retries                                    | `2`                      |
| `MODEL_TEMPERATURE`        | Sampling temperature                                 | `0.8`                    |
| `SENTRY_ENABLED`           | Report unexpected errors                             | `false`                  |
| `SENTRY_DSN`               | Required when reporting is on                        | none                     |
| `SENTRY_ENVIRONMENT`       | Environment name in reports                          | `development`            |
| `LOG_LEVEL`, `NODE_ENV`    | As for the web app                                   |                          |

The `MODEL_*` settings are read only when the Game Master is on. `.env.example` lists every
variable. The server does not load a `.env` file: give it its environment.

---

## 4. Local production-like startup

Docker with Compose is enough. This builds the image and runs it with a MongoDB:

```
export ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
docker compose -f docker-compose.prod.yml up --build -d
SMOKE_BASE_URL=http://127.0.0.1:3001 npm run smoke:server
npm run demo:server                                  # optional: plays a scripted round
docker compose -f docker-compose.prod.yml down        # add -v to delete the data too
```

`docker-compose.prod.yml` is for trying the shape of a deployment. It is not one: there is no TLS,
the database has no authentication and is a single node, and nothing is backed up.

Without Docker:

```
npm ci
npm run build:server
MONGODB_URI=mongodb://127.0.0.1:27017 ADMIN_TOKEN=… npm run start:server
```

---

## 5. MongoDB

- One collection, one document per session: `{ _id: sessionId, version, state }`. There is no
  schema to create and no migration.
- **No index needs creating.** Every query reads, replaces or deletes one document by `_id`, which
  MongoDB always indexes.
- The client connects the first time it is used and is closed on shutdown. Retries are off in the
  driver; a failed operation is reported once, as `STORAGE_ERROR`, with no driver detail.
- **A session's first snapshot is saved when it is created.** After that it is saved when it is
  evicted, when the server shuts down gracefully, after an applied Game Master event, and when an
  operator asks (`POST /admin/sessions/<id>/save`). There is no periodic save. **If the process is
  killed, everything since a session's last save is lost.** A session that always has someone
  connected is never evicted, so for it that can be the whole game.
- A save that fails changes nothing in memory. The session stays loaded, playable and marked
  unsaved, and is not evicted until a save succeeds.

---

## 6. Ollama and Gemma

The model runtime is a separate service. It is not in the server image, and the server downloads
nothing when it starts.

```
game server ── MODEL_BASE_URL ──► Ollama ──► gemma3:4b
```

- **Install the model** on the runtime's host, once: `ollama pull gemma3:4b`. With the bundled
  Compose runtime: `npm run ai:up && npm run ai:pull`.
- **Select it** with `MODEL_NAME`, and the runtime with `MODEL_PROVIDER` and `MODEL_BASE_URL`. An
  OpenAI-compatible server (vLLM, llama.cpp, TGI) works with `MODEL_PROVIDER=openai-compatible`.
- **The address must be reachable from the server.** A natively installed Ollama listens on
  `127.0.0.1` by default, which a container cannot reach: start it with `OLLAMA_HOST=0.0.0.0`, or
  run the server outside a container, or use the Compose runtime on the same network.
- **Resources, roughly.** `gemma3:4b` is about 3.3 GB of weights and wants a few GB of memory on
  top; it runs on a CPU and is much faster on a GPU. On this project's development machine a turn
  took about 2 to 4 seconds once the model was loaded, and the first call after an idle period took
  about 15. The game server itself needs neither a GPU nor much memory.
- **When the model is away** (unreachable, slow, or answering nonsense) the Game Master's turn
  ends with nothing applied, nothing broadcast and nothing saved, and the game carries on. The
  failure is logged and counted. Readiness does not depend on the model.
- **Timeouts.** One request to the runtime may take `MODEL_REQUEST_TIMEOUT_MS`; a whole turn may
  take `GAME_MASTER_TIMEOUT_MS`, after which it is abandoned.

---

## 7. Sentry

Off by default. Set `SENTRY_ENABLED=true`, `SENTRY_DSN` and, usually, `SENTRY_ENVIRONMENT`. The
Sentry SDK is loaded only then.

What is sent: unexpected errors (a Game Master turn, a tool, the listener, an admin request, an
uncaught error), and persistence failures with a stable code. Each carries tags from a fixed list
(`area`, `stage`, `code`, `provider`, `model`, `tool`) and error text scrubbed of addresses and
token-like strings. No session id, player, token, prompt, reply or game data is sent.

If Sentry cannot be reached, reports are dropped and nothing else changes. This integration has
been tested with the real SDK and a fake transport. It has not been run against a real Sentry
project.

---

## 8. WebSocket and the reverse proxy

Clients connect to `/sessions/<sessionId>` on the same port as the health endpoints. The server
speaks plain `ws`. Put a reverse proxy or load balancer in front of it to end TLS, so that clients
use `wss://`.

The proxy must:

- **forward the upgrade**: HTTP/1.1 to the server with the `Upgrade` and `Connection` headers;
- **leave the path alone**: `/sessions/<sessionId>` selects the session;
- **allow long-lived connections**: an idle read timeout longer than `WS_HEARTBEAT_MS` (the server
  pings every 30 seconds by default, which keeps a quiet connection open through most proxies);
- **send every connection to the one server process**: there is exactly one.

For nginx, the essentials are:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

This configuration is given as a guide and was not run as part of this work. Keep `/admin/` off the
public internet if you can: restrict it at the proxy.

The heartbeat also closes a socket whose peer vanished without closing, so it stops counting as a
connection and its session can become idle. A player whose socket was closed reconnects and sends
`resume` with their token.

---

## 9. Health and readiness

| Endpoint       | Answers                                                       | Use it for                      |
| -------------- | ------------------------------------------------------------- | ------------------------------- |
| `GET /healthz` | `200 {"status":"ok"}` while the process is alive              | Liveness: restart if it fails   |
| `GET /readyz`  | `200 {"status":"ready","checks":{"store":"ok"}}`              | Readiness: route traffic or not |
|                | `503 {"status":"not_ready","checks":{"store":"unavailable"}}` |                                 |
|                | `503 {"status":"shutting_down"}`                              |                                 |

- Readiness asks the database one cheap question (read one document by id), with a 2 second limit,
  at most once every 5 seconds however often it is polled.
- Readiness does **not** ask the model runtime or Sentry: the server serves games without either.
- Liveness stays `200` while the database is away and while shutting down: restarting the process
  would not help in either case.
- No health answer contains configuration, an address, an error message or a stack.

The image's `HEALTHCHECK` uses `/healthz`.

### Admin endpoints

They exist only when `ADMIN_TOKEN` is set, and need `Authorization: Bearer <ADMIN_TOKEN>`.

| Endpoint                         | Does                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /admin/sessions`           | Creates a session. Body `{"gameId":"tag"}`. Returns `sessionId`, `joinCode`, `hostToken`, `path` |
| `POST /admin/sessions/<id>/save` | Saves a loaded session now                                                                       |
| `GET /admin/metrics`             | The process's counters and timers, as JSON                                                       |

A session cannot be created any other way: the WebSocket protocol has no message for it. The host
token in the reply is shown once and is not stored or logged.

---

## 10. Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. readiness turns to `shutting_down`, so traffic stops being sent;
2. the eviction sweep stops;
3. new connections, new admin requests and new Game Master turns are refused;
4. every room is closed: its connections are sent `SESSION_CLOSED` and closed;
5. every session with unsaved changes is saved once, after any save already under way;
6. the MongoDB client is closed;
7. the listener stops;
8. Sentry is flushed (up to 2 seconds);
9. the process exits: **0** if every session was saved, **1** if one could not be or time ran out.

- The whole of it is abandoned after `SHUTDOWN_TIMEOUT_MS` (25 seconds), and the process exits 1.
  Give the container a stop grace period longer than that (the Compose file uses 30 seconds).
- A Game Master turn still waiting for the model is not waited for: its answer is dropped.
- A second signal exits at once with 1.
- An uncaught error is reported, then the same shutdown runs and the process exits 1.

---

## 11. Build and start commands

```
npm ci                    # deterministic install from the lockfile
npm run verify            # format, lint, typecheck, tests
npm run build:server      # dist/server/*.mjs
npm run start:server      # node dist/server/main.mjs
npm run smoke:server      # against a running server; needs ADMIN_TOKEN
npm run demo:server       # plays a scripted round against a running server

docker build -f Dockerfile.server -t touchgrass-server .
```

The image is multi-stage: it bundles the server and the workspace packages, installs only the
server's production dependencies from the lockfile, and runs as the non-root `node` user. It holds
no `.env` file, no credential and no model.

---

## 12. When a dependency is unavailable

| Unavailable       | At start-up                               | While running                                                                                                                                          |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MongoDB           | Starts; `/readyz` is 503 until it answers | `/readyz` 503. Loaded games play on in memory and stay marked unsaved. Sessions cannot be created or loaded. Evictions fail and are retried each sweep |
| Ollama / Gemma    | Starts normally                           | Game Master turns fail and change nothing. Games are unaffected                                                                                        |
| Sentry            | Starts normally                           | Reports are dropped                                                                                                                                    |
| Bad configuration | Exits 1, naming the variables             | —                                                                                                                                                      |
| Port in use       | Exits 1                                   | —                                                                                                                                                      |

---

## 13. Security limitations

Read these before putting it on the internet.

- **There is no authentication of players.** Anyone who can reach the server and knows a session
  id and its join code can join. A player's token and the host token are bearer capabilities:
  whoever holds one is that player or the host.
- **The admin token is one shared value**, with no users, roles, rotation or rate limit. Treat it
  like a root credential, send it only over TLS, and restrict `/admin/` at the proxy.
- **No TLS in the server.** Without a TLS-terminating proxy, tokens cross the network in the clear.
- **No rate limiting and no `Origin` check** on connections, messages or admin requests.
- **Connecting to a stored session's address loads it into memory.** Nothing limits how many
  sessions are loaded.
- **The full game state is broadcast** to every connection of a session, including the join code.
- **Player tokens cannot be rotated or revoked** except by removing the player.
- **Error-text scrubbing for Sentry is pattern-based.** It is blunt and is not a proof.
- Logs name sessions and outcomes. They do not contain tokens, the admin token, connection strings,
  prompts, model replies or tool inputs and outputs.

---

## 14. Scaling limitations

**The multiplayer architecture is single-process.**

- One process holds every loaded session in memory. There is no Redis, no shared session state and
  no coordination between processes.
- **Do not run two instances against the same database.** Two processes can load the same session
  and overwrite each other's saves; nothing detects it. Horizontal scaling is not supported.
- A restart closes every connection. Players reconnect and resume, if `SESSION_TOKEN_KEY` is set
  and their session was saved.
- Capacity is bounded by one process's memory and one event loop. It has not been load-tested.
- Metrics are in memory and are read from `/admin/metrics`. There is no tracing.
