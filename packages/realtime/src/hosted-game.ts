import { type Result, ok } from '@touchgrass/shared';
import type { EngineContext, EngineError } from '@touchgrass/game-engine';
import { type GameSession, createGameSession } from '@touchgrass/game-session';
import { type Room, createRoom, createToken } from './room';

/**
 * Creating a game that can be hosted.
 *
 * One call makes the three things that belong together: the session that holds
 * the game, the room that connections attach to, and the host token that lets
 * one connection control it. Whoever calls this receives the token, and that is
 * the whole of "owning" a game: there are no accounts, and the game records no
 * host.
 *
 * Nothing is registered anywhere. The caller holds the returned object, and
 * when the caller lets go of it the game is gone. There is no table of games in
 * this package and no way to look one up.
 */

export interface HostedGame {
  readonly session: GameSession;
  readonly room: Room;
  /**
   * The bearer secret for the host role. It is returned here and nowhere else:
   * it is not in the game state and is never sent to a client by the room.
   * Anyone who has it can pause, resume or stop the game and remove players.
   */
  readonly hostToken: string;
}

export interface HostedGameOptions {
  /** Makes a new player id for a join. Defaults to a random one. */
  readonly createPlayerId?: () => string;
  /** Makes the host token and each player token. Defaults to 32 random bytes. */
  readonly createToken?: () => string;
  readonly maxMessageBytes?: number;
}

/**
 * Creates a new game, its room and its host token.
 *
 * `command` is a CREATE_SESSION command; the session validates it and builds the
 * initial state through the engine.
 */
export function createHostedGame(
  command: unknown,
  ctx: EngineContext,
  options: HostedGameOptions = {},
): Result<HostedGame, EngineError> {
  const session = createGameSession(command, ctx);
  if (!session.ok) return session;

  const hostToken = (options.createToken ?? createToken)();
  const room = createRoom({ session: session.value, hostToken, ...options });
  return ok({ session: session.value, room, hostToken });
}
