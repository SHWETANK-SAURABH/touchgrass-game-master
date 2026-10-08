import { describe, expect, it } from 'vitest';
import { findGameDefinition } from '@touchgrass/game-definitions';
import { buildGameMasterView } from './context';
import { buildGameMasterMessages } from './prompt';
import { T0, lobbyState, runningState } from './test-support';

const tag = findGameDefinition('tag');
if (!tag) throw new Error('fixture failed');

describe('what the Game Master is shown of a game', () => {
  it('never includes the join code, though the first history entry of the engine names it', () => {
    const state = runningState('tag');
    // The engine's own record of the session being opened does carry the code.
    expect(state.history[0]?.summary).toContain(state.joinCode);

    const view = buildGameMasterView({ state, definition: tag, now: T0 + 61_000 });
    expect(JSON.stringify(view)).not.toContain(state.joinCode);
    expect(view.recentHistory[0]?.summary).toContain('[join code]');
    expect(JSON.stringify(buildGameMasterMessages(view))).not.toContain(state.joinCode);
  });

  it('carries no seed, no session id and no field of the state it was not built to show', () => {
    const state = lobbyState('tag');
    const view = buildGameMasterView({ state, definition: tag, now: T0 });
    const shown = JSON.stringify(view);
    expect(shown).not.toMatch(/randomSeed|joinCode|createdAt/);
    expect(Object.keys(view).sort()).toEqual([
      'allowed',
      'game',
      'guidance',
      'inForce',
      'limits',
      'players',
      'recentHistory',
      'roles',
      'round',
    ]);
  });
});
