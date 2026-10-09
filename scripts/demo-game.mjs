// A scripted game against a running game server: `npm run demo:server`.
//
//   SERVER_URL    where the server is (default http://127.0.0.1:3001)
//   ADMIN_TOKEN   the server's admin token (required: it creates the session)
//
// It plays the part of an operator, a host and three players, and prints what
// happens: a session is created, three players join over WebSocket, the round
// starts, the Game Master takes its turn if the server has one, a tag is made,
// the host pauses and resumes, a player drops and comes back as the same
// player, and the game is saved.
//
// It needs nothing but Node 22 or later. It leaves one session behind in the
// database and changes nothing else.

const base = (process.env.SERVER_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN ?? '';
const wsBase = base.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line) => console.log(line);

/** A socket that remembers the latest state it was sent. */
function connect(path, label) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${path}`);
    const client = { label, inbox: [], state: undefined, closed: false };
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      client.inbox.push(message);
      if (message.state) client.state = message.state;
    });
    socket.addEventListener('close', () => {
      client.closed = true;
    });
    socket.addEventListener('open', () =>
      resolve({
        ...client,
        get state() {
          return client.state;
        },
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => socket.close(),
        async next(type) {
          for (let tries = 0; tries < 400; tries += 1) {
            const index = client.inbox.findIndex((message) => message.type === type);
            if (index !== -1) return client.inbox.splice(index, 1)[0];
            await sleep(25);
          }
          throw new Error(`${label}: no "${type}" message arrived`);
        },
      }),
    );
    socket.addEventListener('error', () => reject(new Error(`${label} could not connect`)));
  });
}

const scores = (state) =>
  state.players.map((player) => `${player.displayName} ${String(player.score)}`).join(', ');

try {
  if (adminToken === '') throw new Error('ADMIN_TOKEN is not set');
  const admin = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

  const ready = await fetch(`${base}/readyz`);
  if (ready.status !== 200)
    throw new Error(`the server is not ready (GET /readyz ${String(ready.status)})`);

  // An operator creates a game of Tag.
  const created = await fetch(`${base}/admin/sessions`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ gameId: 'tag' }),
  });
  if (created.status !== 201)
    throw new Error(`could not create a session (${String(created.status)})`);
  const session = await created.json();
  say(`1. Session created: ${wsBase}${session.path}   join code ${session.joinCode}`);

  // Three players join over WebSocket.
  const players = [];
  for (const name of ['Ada', 'Bo', 'Cy']) {
    const client = await connect(session.path, name);
    client.send({ type: 'join', joinCode: session.joinCode, displayName: name });
    const joined = await client.next('joined');
    players.push({ client, name, playerId: joined.playerId, token: joined.token });
  }
  say(`2. Three players joined: ${players.map((player) => player.name).join(', ')}`);

  // The host connects with the token the operator was given.
  const host = await connect(session.path, 'host');
  host.send({ type: 'host_auth', token: session.hostToken });
  await host.next('host_authorized');

  // Everyone is ready: the engine hands out roles and starts round 1.
  for (const player of players)
    player.client.send({ type: 'action', intent: { type: 'PLAYER_READY' } });
  for (let tries = 0; tries < 200 && host.state?.status !== 'active'; tries += 1) await sleep(25);
  const roles = host.state.players
    .map((player) => `${player.displayName}: ${player.roleId}`)
    .join(', ');
  say(`3. Round ${String(host.state.currentRound)} started. Roles from the engine: ${roles}`);

  // If the server has a Game Master, it is asked once now, and a turn takes a
  // few seconds. Wait until the counters show a turn has ended, or 20 seconds.
  let proposed;
  for (let tries = 0; tries < 40; tries += 1) {
    const counters = (await (await fetch(`${base}/admin/metrics`, { headers: admin })).json())
      .counters;
    proposed = host.state.history.find((entry) => entry.source === 'game-master');
    if (proposed || counters.game_master_invocations > 0) break;
    await sleep(500);
  }
  await sleep(200);
  proposed = host.state.history.find((entry) => entry.source === 'game-master');
  say(
    proposed
      ? `4. Game Master event, checked and applied by the engine: "${proposed.summary}"`
      : '4. No Game Master event (it is off, proposed nothing, or its proposal was refused). The game goes on.',
  );

  // The tagger tags a runner. The engine scores it and swaps the roles.
  const tagger = host.state.players.find((player) => player.roleId === 'tagger');
  const runner = host.state.players.find((player) => player.roleId === 'runner');
  const taggerClient = players.find((player) => player.playerId === tagger.id).client;
  taggerClient.inbox.length = 0;
  taggerClient.send({
    type: 'action',
    intent: { type: 'PLAYER_TAGGED', targetPlayerId: runner.id },
  });
  await taggerClient.next('update');
  await sleep(100);
  say(`5. ${tagger.displayName} tagged ${runner.displayName}. Scores: ${scores(host.state)}`);

  // A player cannot do what only the engine may: the refusal names a code.
  taggerClient.send({
    type: 'action',
    intent: { type: 'PLAYER_TAGGED', targetPlayerId: 'nobody' },
  });
  const refusal = await taggerClient.next('rejected');
  say(`6. An illegal action is refused by the engine: ${refusal.error.code}`);

  // The host pauses and resumes.
  host.send({ type: 'host_command', command: { type: 'PAUSE_SESSION', reason: 'water break' } });
  for (let tries = 0; tries < 100 && host.state.status !== 'paused'; tries += 1) await sleep(25);
  const paused = host.state.status;
  host.send({ type: 'host_command', command: { type: 'RESUME_SESSION' } });
  for (let tries = 0; tries < 100 && host.state.status !== 'active'; tries += 1) await sleep(25);
  say(`7. The host paused the game (${paused}) and resumed it (${host.state.status})`);

  // A player drops and comes back as the same player.
  const dropped = players[0];
  dropped.client.close();
  await sleep(200);
  const back = await connect(session.path, dropped.name);
  back.send({ type: 'resume', token: dropped.token });
  const resumed = await back.next('joined');
  say(
    `8. ${dropped.name} dropped and resumed as the same player: ${String(resumed.playerId === dropped.playerId)}`,
  );

  // The operator saves the game.
  const saved = await fetch(`${base}/admin/sessions/${session.sessionId}/save`, {
    method: 'POST',
    headers: admin,
  });
  say(`9. Saved to the database: ${String(saved.status === 200)}`);

  const metrics = await (await fetch(`${base}/admin/metrics`, { headers: admin })).json();
  say(
    `   Counters: ${String(metrics.counters.websocket_connections_opened)} connections, ${String(metrics.counters.game_master_invocations)} Game Master turn(s), ${String(metrics.counters.game_master_successes)} successful.`,
  );

  for (const client of [host, back, ...players.slice(1).map((player) => player.client)])
    client.close();
  process.exit(0);
} catch (error) {
  console.error(`The demo stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
