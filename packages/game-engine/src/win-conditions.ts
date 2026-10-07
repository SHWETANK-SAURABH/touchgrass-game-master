import type { GameDefinition } from '@touchgrass/game-definitions';
import type { GameState, PlayerState } from './state';

/**
 * Win-condition evaluation.
 *
 * The engine decides who won, from the final state alone. A game's win
 * conditions are applied in order, each narrowing the field left by the one
 * before.
 *
 * Tie rule: players who are still level after every condition all win. The
 * result lists them in the order they joined, so it is the same on every host.
 * Players who left the game cannot win.
 */
export function evaluateWinners(definition: GameDefinition, state: GameState): string[] {
  let candidates: readonly PlayerState[] = state.players.filter(
    (player) => player.status !== 'left',
  );

  for (const condition of definition.winConditions) {
    if (candidates.length <= 1) break;
    switch (condition.type) {
      case 'HIGHEST_SCORE': {
        const best = Math.max(...candidates.map((player) => player.score));
        candidates = candidates.filter((player) => player.score === best);
        break;
      }
    }
  }

  return candidates.map((player) => player.id);
}
