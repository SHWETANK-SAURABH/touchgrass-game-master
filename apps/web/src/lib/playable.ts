/**
 * Which games can actually be played.
 *
 * A game is listed here only if the engine runs it from the first player
 * joining to a winner being named. Tag and Hide & Seek do: the engine has their
 * rules, and its tests play both to the end. The other three games are valid
 * definitions that the engine does not run yet, so the site shows their rules
 * and does not offer to start them.
 *
 * This is the one place the site decides that. Nothing is shown as playable
 * because of how its definition looks.
 */
export const PLAYABLE_GAME_IDS = ['tag', 'hide-and-seek'] as const;
export type PlayableGameId = (typeof PLAYABLE_GAME_IDS)[number];

export function isPlayable(gameId: string): gameId is PlayableGameId {
  return (PLAYABLE_GAME_IDS as readonly string[]).includes(gameId);
}

/** Playable games first, in catalogue order otherwise. */
export function playableFirst<T extends { readonly id: string }>(games: readonly T[]): T[] {
  return [...games].sort((a, b) => Number(isPlayable(b.id)) - Number(isPlayable(a.id)));
}
