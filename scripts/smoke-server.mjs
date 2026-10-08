// A smoke test for a running game server: `npm run smoke:server`.
//
//   SMOKE_BASE_URL   where the server is (default http://127.0.0.1:3001)
//   ADMIN_TOKEN      the server's admin token (required: it creates a session)
//
// It talks to the server the way a load balancer, an operator and two players
// would, and checks each step. It needs nothing but Node 22 or later: no
// dependency, no database access, no model. It creates one session and leaves
// it behind; it changes nothing else.
//
// Exit status 0 means every step passed. It does not start or stop the server:
// do that around it, and check the server's own exit status for a clean stop.

const base = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN ?? '';
const wsBase = base.replace(/^http/, 'ws');

const steps = [];
const step = (name, pass, detail = '') => {
  steps.push(pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket that keeps what it receives, so a step can wait for a message. */
function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${path}`);
    const inbox = [];
    let closed = false;
    socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data))));
    socket.addEventListener('close', () => {
      closed = true;
    });
    socket.addEventListener('open', () =>
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
        isClosed: () => closed,
        async next(type) {
          for (let tries = 0; tries < 200; tries += 1) {
            const index = inbox.findIndex((message) => message.type === type);
            if (index !== -1) return inbox.splice(index, 1)[0];
            await sleep(25);
          }
          throw new Error(`no "${type}" message arrived`);
        },
      }),
    );
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${path}`)));
  });
}

try {
  if (adminToken === '') throw new Error('ADMIN_TOKEN is not set');
  const admin = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

  // 1 and 2. The server is up, and becomes ready.
  let ready;
  for (let tries = 0; tries < 60; tries += 1) {
    try {
      ready = await fetch(`${base}/readyz`);
      if (ready.status === 200) break;
    } catch {
      // Not listening yet.
    }
    await sleep(1_000);
  }
  step('the server becomes ready', ready?.status === 200, `GET /readyz ${String(ready?.status)}`);
  if (ready?.status !== 200) throw new Error('the server never became ready');
  const alive = await fetch(`${base}/healthz`);
  step('it says it is alive', alive.status === 200 && (await alive.json()).status === 'ok');

  // The admin endpoints need the token.
  const refused = await fetch(`${base}/admin/sessions`, { method: 'POST' });
  step('creating a session without the token is refused', refused.status === 401);

  // 4. A session is created.
  const created = await fetch(`${base}/admin/sessions`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ gameId: 'tag' }),
  });
  const session = await created.json();
  step('a session is created', created.status === 201 && typeof session.sessionId === 'string');

  // 3 and 5. A client connects and a player joins.
  const first = await connect(session.path);
  first.send({ type: 'join', joinCode: session.joinCode, displayName: 'Smoke One' });
  const joined = await first.next('joined');
  step(
    'a player connects and joins',
    typeof joined.playerId === 'string' && joined.state.id === session.sessionId,
  );

  // 6. A second player joins, and the first is told.
  const second = await connect(session.path);
  second.send({ type: 'join', joinCode: session.joinCode, displayName: 'Smoke Two' });
  await second.next('joined');
  const update = await first.next('update');
  step('the game state is broadcast', update.state.players.length === 2);

  // The host role works with the token the admin was given.
  const host = await connect(session.path);
  host.send({ type: 'host_auth', token: session.hostToken });
  step(
    'the host is authorised',
    (await host.next('host_authorized')).state.id === session.sessionId,
  );

  // 7. The session can be saved.
  const saved = await fetch(`${base}/admin/sessions/${session.sessionId}/save`, {
    method: 'POST',
    headers: admin,
  });
  step('the session is saved', saved.status === 200 && (await saved.json()).saved === true);

  // 8. A player drops and resumes as the same player.
  first.close();
  await sleep(200);
  const back = await connect(session.path);
  back.send({ type: 'resume', token: joined.token });
  const resumed = await back.next('joined');
  step(
    'a player reconnects and resumes',
    resumed.playerId === joined.playerId && resumed.token === undefined,
  );

  // A bad token and an unknown session are refused cleanly.
  const stranger = await connect(session.path);
  stranger.send({ type: 'resume', token: 'not-a-token' });
  step('a wrong token is refused', (await stranger.next('error')).code === 'INVALID_TOKEN');
  const lost = await connect('/sessions/no-such-session');
  step('an unknown session is refused', (await lost.next('error')).code === 'SESSION_NOT_FOUND');

  // The counters saw it.
  const metrics = await (await fetch(`${base}/admin/metrics`, { headers: admin })).json();
  step(
    'the counters record it',
    metrics.counters.session_creates >= 1 && metrics.counters.websocket_connections_opened >= 5,
  );

  for (const client of [second, host, back, stranger]) client.close();
} catch (error) {
  step(`stopped early: ${error instanceof Error ? error.message : 'unknown error'}`, false);
}

const failed = steps.filter((pass) => !pass).length;
console.log(
  failed === 0
    ? `\nAll ${String(steps.length)} steps passed.`
    : `\n${String(failed)} step(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
