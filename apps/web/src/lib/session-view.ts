import type { GameDefinition } from '@touchgrass/game-definitions';
import type { GameState, PlayerState } from '@touchgrass/game-engine';

/**
 * What the play screen shows, worked out from the game the server sent.
 *
 * Everything here reads a state and returns something to display. Nothing here
 * decides a rule: who may tag whom, who scored and who won are the engine's
 * answers, and this only presents them. Where it offers a button, the engine
 * still checks the action when it is sent.
 */

/** Messages for the codes the server can send, in words a player can act on. */
const MESSAGES: Record<string, string> = {
  // Finding the game.
  SESSION_NOT_FOUND: 'We could not find that game. Check the link or ask the host for a new one.',
  INVALID_SESSION_PATH: 'That game link does not look right. Ask the host to share it again.',
  SESSION_UNAVAILABLE: 'The game could not be opened just now. Try again in a moment.',
  SESSION_CLOSED: 'This game was closed on the server.',
  CONNECTION_REPLACED: 'You opened this game somewhere else, so this window was disconnected.',
  // Joining.
  WRONG_JOIN_CODE: 'That join code is not right. Check it with the host and try again.',
  ALREADY_JOINED: 'You are already in this game.',
  INVALID_TOKEN: 'Your place in this game could not be restored. Join again with the join code.',
  PLAYER_LIMIT_EXCEEDED: 'This game is full.',
  GAME_ALREADY_STARTED: 'This game has already started, so new players cannot join.',
  GAME_ALREADY_COMPLETED: 'This game is over.',
  DUPLICATE_PLAYER: 'That player is already in the game.',
  // Playing.
  NOT_JOINED: 'Join the game first.',
  NOT_HOST: 'Only the host can do that.',
  HOST_ALREADY_CONNECTED: 'The host controls are open in another window.',
  CANNOT_LEAVE: 'You can only leave before the game starts.',
  NOT_ENOUGH_PLAYERS: 'More players are needed before the game can start.',
  INVALID_PLAYER: 'That player is not in this game.',
  INVALID_ROLE: 'Your role cannot do that right now.',
  INVALID_ACTION: 'That cannot be done right now.',
  INVALID_STATE_TRANSITION: 'That cannot be done at this point in the game.',
  BAD_MESSAGE: 'Something went wrong sending that. Please try again.',
};

/** A plain sentence for a code from the server. Never the server's own text. */
export function messageFor(code: string | undefined): string {
  return (code && MESSAGES[code]) || 'That did not work. Please try again.';
}

export function findPlayer(
  state: GameState,
  playerId: string | undefined,
): PlayerState | undefined {
  return playerId === undefined
    ? undefined
    : state.players.find((player) => player.id === playerId);
}

/** The players still in the game, in the order they joined. */
export function presentPlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.status !== 'left');
}

export function roleLabel(definition: GameDefinition | undefined, roleId: string | null): string {
  if (roleId === null) return 'No role yet';
  return definition?.roles.find((role) => role.id === roleId)?.label ?? roleId;
}

export function roleDescription(
  definition: GameDefinition | undefined,
  roleId: string | null,
): string | undefined {
  return definition?.roles.find((role) => role.id === roleId)?.description;
}

/** Seconds left in the running round, or null when no round is running. */
export function secondsLeft(state: GameState, now: number): number | null {
  if (state.timer.endsAt === null) return null;
  // While paused the clock is frozen at the moment of the pause.
  const from = state.timer.pausedAt ?? now;
  return Math.max(0, Math.ceil((state.timer.endsAt - from) / 1_000));
}

export function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What a player can report, as buttons. The engine decides whether each one counts. */
export interface ReportOption {
  readonly key: string;
  readonly label: string;
  readonly intent:
    | { readonly type: 'PLAYER_TAGGED'; readonly targetPlayerId: string }
    | { readonly type: 'PLAYER_FOUND'; readonly targetPlayerId: string }
    | { readonly type: 'PLAYER_ACTIVATED_POWER'; readonly powerId: string }
    | { readonly type: 'PLAYER_COMPLETED_CHALLENGE'; readonly challengeId: string };
}

export function reportOptions(
  state: GameState,
  definition: GameDefinition | undefined,
  playerId: string | undefined,
  now: number,
): ReportOption[] {
  const me = findPlayer(state, playerId);
  if (!me || state.status !== 'active' || me.status !== 'active') return [];
  const others = presentPlayers(state).filter((player) => player.id !== me.id);
  const options: ReportOption[] = [];

  if (state.gameId === 'tag' && me.roleId === 'tagger') {
    for (const player of others.filter((other) => other.roleId === 'runner')) {
      options.push({
        key: `tag-${player.id}`,
        label: `I tagged ${player.displayName}`,
        intent: { type: 'PLAYER_TAGGED', targetPlayerId: player.id },
      });
    }
  }
  if (state.gameId === 'hide-and-seek' && me.roleId === 'seeker') {
    for (const player of others.filter(
      (other) => other.roleId === 'hider' && other.status === 'active',
    )) {
      options.push({
        key: `found-${player.id}`,
        label: `I found ${player.displayName}`,
        intent: { type: 'PLAYER_FOUND', targetPlayerId: player.id },
      });
    }
  }
  for (const powerId of new Set(me.powers)) {
    const power = definition?.powers.find((candidate) => candidate.id === powerId);
    options.push({
      key: `power-${powerId}`,
      label: `Use ${power?.label ?? powerId}`,
      intent: { type: 'PLAYER_ACTIVATED_POWER', powerId },
    });
  }
  for (const objective of state.activeObjectives) {
    const open =
      objective.expiresAt > now &&
      !objective.completedByPlayerIds.includes(me.id) &&
      (objective.eligiblePlayerIds.length === 0 || objective.eligiblePlayerIds.includes(me.id));
    if (open) {
      options.push({
        key: `objective-${objective.id}`,
        label: `I did it: ${objective.description}`,
        intent: { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: objective.id },
      });
    }
  }
  return options;
}

/** What is in force right now, as short lines to read aloud. */
export function inForce(
  state: GameState,
  now: number,
): { key: string; text: string; seconds: number }[] {
  const lines: { key: string; text: string; seconds: number }[] = [];
  const nameOf = (id: string): string => findPlayer(state, id)?.displayName ?? 'A player';
  for (const modifier of state.activeModifiers) {
    if (modifier.expiresAt <= now) continue;
    const seconds = Math.ceil((modifier.expiresAt - now) / 1_000);
    const text =
      modifier.kind === 'SAFE_ZONE'
        ? `Safe zone: ${modifier.zone}`
        : modifier.kind === 'MOVING_ZONE'
          ? `The zone has moved: ${modifier.zone}`
          : modifier.kind === 'FREEZE_PERIOD'
            ? `Freeze! These roles must stand still: ${modifier.roleIds.join(', ')}`
            : `${nameOf(modifier.playerId)} is using ${modifier.powerId}`;
    lines.push({ key: modifier.id, text, seconds });
  }
  for (const objective of state.activeObjectives) {
    if (objective.expiresAt <= now) continue;
    lines.push({
      key: objective.id,
      text: `Bonus (${String(objective.points)} points): ${objective.description}`,
      seconds: Math.ceil((objective.expiresAt - now) / 1_000),
    });
  }
  return lines;
}

/** Players by score, highest first, with the engine's winners marked. */
export function scoreboard(state: GameState): { player: PlayerState; winner: boolean }[] {
  return presentPlayers(state)
    .map((player) => ({ player, winner: state.winnerIds.includes(player.id) }))
    .sort((a, b) => b.player.score - a.player.score);
}

/** The latest things that happened, newest first, without the join code. */
export function recentActivity(
  state: GameState,
  limit = 6,
): { key: string; text: string; fromGameMaster: boolean }[] {
  return state.history
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      key: entry.id,
      text: entry.summary.split(state.joinCode).join('…'),
      fromGameMaster: entry.source === 'game-master',
    }));
}

/** The session id in whatever a player pasted: a full link, a path, or the id itself. */
export function sessionIdFrom(input: string): { sessionId: string; code?: string } | null {
  const text = input.trim();
  if (text === '') return null;
  const path = /\/session\/([^/?#\s]+)/.exec(text);
  const code = /[?&]code=([^&#\s]+)/.exec(text)?.[1];
  let sessionId = path?.[1] ?? text;
  try {
    sessionId = decodeURIComponent(sessionId);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_.-]{3,200}$/.test(sessionId)) return null;
  return { sessionId, ...(code ? { code: decodeURIComponent(code) } : {}) };
}
