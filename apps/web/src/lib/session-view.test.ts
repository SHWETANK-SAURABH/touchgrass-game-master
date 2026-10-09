import { describe, expect, it } from 'vitest';
import { findGameDefinition } from '@touchgrass/game-definitions';
import type { GameState, PlayerState } from '@touchgrass/game-engine';
import {
  formatClock,
  inForce,
  messageFor,
  presentPlayers,
  recentActivity,
  reportOptions,
  roleLabel,
  scoreboard,
  secondsLeft,
  sessionIdFrom,
} from './session-view';

const NOW = 1_000_000;

const player = (id: string, over: Partial<PlayerState> = {}): PlayerState => ({
  id,
  displayName: id.toUpperCase(),
  roleId: null,
  score: 0,
  status: 'active',
  ready: true,
  powers: [],
  joinedAt: NOW,
  ...over,
});

const game = (over: Partial<GameState> = {}): GameState => ({
  id: 'session-1',
  gameId: 'tag',
  joinCode: 'ABCD',
  status: 'active',
  phaseIndex: 0,
  settings: { totalRounds: 3, roundDurationSeconds: 180 },
  currentRound: 1,
  timer: { endsAt: NOW + 90_000, pausedAt: null },
  players: [
    player('ann', { roleId: 'tagger' }),
    player('bo', { roleId: 'runner' }),
    player('cy', { roleId: 'runner' }),
  ],
  activeModifiers: [],
  activeObjectives: [],
  history: [],
  winnerIds: [],
  createdAt: NOW,
  startedAt: NOW,
  endedAt: null,
  randomSeed: 1,
  ...over,
});

describe('messageFor', () => {
  it('gives a plain sentence for a known code', () => {
    expect(messageFor('WRONG_JOIN_CODE')).toMatch(/join code/i);
  });

  it('falls back to a general sentence, never the code itself', () => {
    expect(messageFor('SOMETHING_NEW')).toBe('That did not work. Please try again.');
    expect(messageFor(undefined)).toBe('That did not work. Please try again.');
  });
});

describe('the clock', () => {
  it('counts down to the end of the round', () => {
    expect(secondsLeft(game(), NOW)).toBe(90);
    expect(secondsLeft(game(), NOW + 200_000)).toBe(0);
  });

  it('is frozen while the game is paused', () => {
    const paused = game({ timer: { endsAt: NOW + 90_000, pausedAt: NOW + 30_000 } });
    expect(secondsLeft(paused, NOW + 80_000)).toBe(60);
  });

  it('is absent when no round is running', () => {
    expect(secondsLeft(game({ timer: { endsAt: null, pausedAt: null } }), NOW)).toBeNull();
  });

  it('formats minutes and seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(180)).toBe('3:00');
  });
});

describe('reportOptions', () => {
  const tag = findGameDefinition('tag');
  const hideAndSeek = findGameDefinition('hide-and-seek');

  it('offers the tagger one button per runner', () => {
    const options = reportOptions(game(), tag, 'ann', NOW);
    expect(options.map((option) => option.intent)).toEqual([
      { type: 'PLAYER_TAGGED', targetPlayerId: 'bo' },
      { type: 'PLAYER_TAGGED', targetPlayerId: 'cy' },
    ]);
    expect(options[0]?.label).toBe('I tagged BO');
  });

  it('offers a runner nothing to report', () => {
    expect(reportOptions(game(), tag, 'bo', NOW)).toEqual([]);
  });

  it('offers the seeker only hiders who are still hidden', () => {
    const state = game({
      gameId: 'hide-and-seek',
      players: [
        player('ann', { roleId: 'seeker' }),
        player('bo', { roleId: 'hider' }),
        player('cy', { roleId: 'hider', status: 'out' }),
      ],
    });
    expect(reportOptions(state, hideAndSeek, 'ann', NOW).map((option) => option.intent)).toEqual([
      { type: 'PLAYER_FOUND', targetPlayerId: 'bo' },
    ]);
  });

  it('offers nothing outside a running round, or to someone who is not playing', () => {
    expect(reportOptions(game({ status: 'paused' }), tag, 'ann', NOW)).toEqual([]);
    expect(reportOptions(game({ status: 'lobby' }), tag, 'ann', NOW)).toEqual([]);
    expect(reportOptions(game(), tag, 'nobody', NOW)).toEqual([]);
    expect(reportOptions(game(), tag, undefined, NOW)).toEqual([]);
  });

  it('offers a power the player holds, once', () => {
    const state = game({
      players: [
        player('ann', { roleId: 'tagger' }),
        player('bo', { roleId: 'runner', powers: ['shield', 'shield'] }),
      ],
    });
    const options = reportOptions(state, tag, 'bo', NOW);
    expect(options).toHaveLength(1);
    expect(options[0]?.intent).toEqual({ type: 'PLAYER_ACTIVATED_POWER', powerId: 'shield' });
  });

  it('offers an open objective, and not one that has expired or is already done', () => {
    const objective = {
      id: 'obj-1',
      source: 'BONUS_OBJECTIVE' as const,
      description: 'Touch a tree',
      points: 1,
      eligiblePlayerIds: [],
      completedByPlayerIds: [],
      expiresAt: NOW + 10_000,
    };
    const open = game({ activeObjectives: [objective] });
    expect(reportOptions(open, tag, 'bo', NOW).map((option) => option.intent)).toEqual([
      { type: 'PLAYER_COMPLETED_CHALLENGE', challengeId: 'obj-1' },
    ]);
    expect(reportOptions(open, tag, 'bo', NOW + 20_000)).toEqual([]);
    const done = game({
      activeObjectives: [{ ...objective, completedByPlayerIds: ['bo'] }],
    });
    expect(reportOptions(done, tag, 'bo', NOW)).toEqual([]);
  });
});

describe('players and scores', () => {
  it('leaves out players who left', () => {
    const state = game({ players: [player('ann'), player('bo', { status: 'left' })] });
    expect(presentPlayers(state).map((entry) => entry.id)).toEqual(['ann']);
  });

  it('orders by score and marks the winners the engine named', () => {
    const state = game({
      players: [player('ann', { score: 1 }), player('bo', { score: 5 })],
      winnerIds: ['bo'],
    });
    expect(scoreboard(state).map((row) => [row.player.id, row.winner])).toEqual([
      ['bo', true],
      ['ann', false],
    ]);
  });

  it('names a role from the game definition', () => {
    const tag = findGameDefinition('tag');
    expect(roleLabel(tag, null)).toBe('No role yet');
    expect(roleLabel(tag, 'tagger')).toBe(tag?.roles.find((role) => role.id === 'tagger')?.label);
    expect(roleLabel(undefined, 'tagger')).toBe('tagger');
  });
});

describe('inForce', () => {
  it('lists a bonus that is still open and drops one that has run out', () => {
    const state = game({
      activeObjectives: [
        {
          id: 'obj-1',
          source: 'BONUS_OBJECTIVE' as const,
          description: 'Touch a tree',
          points: 2,
          eligiblePlayerIds: [],
          completedByPlayerIds: [],
          expiresAt: NOW + 10_000,
        },
      ],
    });
    expect(inForce(state, NOW)).toEqual([
      { key: 'obj-1', text: 'Bonus (2 points): Touch a tree', seconds: 10 },
    ]);
    expect(inForce(state, NOW + 10_000)).toEqual([]);
  });
});

describe('recentActivity', () => {
  it('shows the newest first and never shows the join code', () => {
    const entry = (sequence: number, summary: string, source = 'engine') => ({
      id: `h-${String(sequence)}`,
      sequence,
      at: NOW,
      source,
      summary,
      record: {},
    });
    const state = game({
      history: [
        entry(1, 'Session created with join code ABCD'),
        entry(2, 'ANN joined'),
        entry(3, 'A bonus appeared', 'game-master'),
      ],
    } as Partial<GameState>);
    const activity = recentActivity(state);
    expect(activity.map((line) => line.text)).toEqual([
      'A bonus appeared',
      'ANN joined',
      'Session created with join code …',
    ]);
    expect(activity[0]?.fromGameMaster).toBe(true);
    expect(recentActivity(state, 1)).toHaveLength(1);
  });
});

describe('sessionIdFrom', () => {
  it('reads a full link, with its join code', () => {
    expect(sessionIdFrom('http://localhost:3000/session/abc-123?code=WXYZ')).toEqual({
      sessionId: 'abc-123',
      code: 'WXYZ',
    });
  });

  it('reads a bare id or a path', () => {
    expect(sessionIdFrom('  abc-123 ')).toEqual({ sessionId: 'abc-123' });
    expect(sessionIdFrom('/session/abc-123')).toEqual({ sessionId: 'abc-123' });
  });

  it('refuses something that cannot be a game', () => {
    expect(sessionIdFrom('')).toBeNull();
    expect(sessionIdFrom('a b c')).toBeNull();
    expect(sessionIdFrom('/session/%E0%A4%A')).toBeNull();
    expect(sessionIdFrom('../../etc')).toBeNull();
  });
});
