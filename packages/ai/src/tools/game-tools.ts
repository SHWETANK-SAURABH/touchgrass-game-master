import { z } from 'zod';
import { EVENT_LIMITS } from '@touchgrass/game-engine';
import { type GameMasterTool, defineTool } from './tool';

/**
 * The tools that exist.
 *
 * There are two, and both only read the one game the Game Master is looking at.
 * What the Game Master is already shown with every request (the players, the
 * round, the time left, what is in force, the last ten history entries, and
 * what it may propose) has no tool: a tool that repeated it would add a model
 * call and no information.
 *
 *   game_history   the game's record further back than the last ten entries
 *   game_rules     how this game is scored and what makes it risky
 *
 * Neither takes a session id, reaches a store or the network, or returns a
 * token, a join code, a seed or anything about a connection.
 */

const secondsBetween = (from: number, to: number): number =>
  Math.max(0, Math.round((to - from) / 1000));

const historyInput = z
  .object({
    /** Return entries older than this sequence number. Left out: the newest entries. */
    before: z.int().min(0).max(1_000_000).optional(),
    /** How many entries, at most. */
    limit: z.int().min(1).max(20).default(10),
  })
  .strict();

const historyOutput = z
  .object({
    /** How many entries the game's record has in all. */
    total: z.int().min(0),
    entries: z
      .array(
        z
          .object({
            sequence: z.int().min(0),
            secondsAgo: z.int().min(0),
            source: z.string(),
            summary: z.string().max(200),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/** The game's record, a page at a time, oldest first within the page. */
export const gameHistoryTool = defineTool<
  z.infer<typeof historyInput>,
  z.infer<typeof historyOutput>
>({
  name: 'game_history',
  description:
    'Earlier entries of the record of this game, beyond the recent ones you were shown. Input example: {"limit": 10}. "limit" is a number from 1 to 20. To go further back, add "before" with a sequence number, for example {"before": 12, "limit": 10}.',
  inputSchema: historyInput,
  outputSchema: historyOutput,
  execute(input, scope) {
    const { history, joinCode } = scope.state;
    const end = Math.min(input.before ?? history.length, history.length);
    const page = history.slice(Math.max(0, end - input.limit), end);
    return {
      total: history.length,
      entries: page.map((entry) => ({
        sequence: entry.sequence,
        secondsAgo: secondsBetween(entry.at, scope.now),
        source: entry.source,
        // The engine's first entry names the join code. It is never shown.
        summary: entry.summary.split(joinCode).join('[join code]').slice(0, 200),
      })),
    };
  },
});

const rulesInput = z.object({}).strict();

const rulesOutput = z
  .object({
    game: z.object({ id: z.string(), name: z.string() }).strict(),
    rounds: z.object({ total: z.int(), durationSeconds: z.int() }).strict(),
    scoring: z.array(z.object({ trigger: z.string(), points: z.int() }).strict()).max(20),
    safety: z
      .object({
        contactPolicy: z.string(),
        maxIntensity: z.string(),
        requiresDaylight: z.boolean(),
        inherentRisks: z.array(z.string().max(300)).max(12),
      })
      .strict(),
    limits: z.record(z.string(), z.unknown()),
  })
  .strict();

/** How this game is scored, how long its rounds are, and what makes it risky. */
export const gameRulesTool = defineTool<z.infer<typeof rulesInput>, z.infer<typeof rulesOutput>>({
  name: 'game_rules',
  description:
    'How this game is scored, how long its rounds are, the limits on what you may propose, and the risks its designers listed. It takes no input: use {}.',
  inputSchema: rulesInput,
  outputSchema: rulesOutput,
  execute(_input, scope) {
    const { definition, state } = scope;
    return {
      game: { id: definition.id, name: definition.name },
      rounds: {
        total: state.settings.totalRounds,
        durationSeconds: state.settings.roundDurationSeconds,
      },
      scoring: definition.scoring.map((rule) => ({ trigger: rule.trigger, points: rule.points })),
      safety: {
        contactPolicy: definition.safety.contactPolicy,
        maxIntensity: definition.safety.maxIntensity,
        requiresDaylight: definition.safety.requiresDaylight,
        inherentRisks: definition.safety.inherentRisks.map((risk) => risk.slice(0, 300)),
      },
      limits: { ...EVENT_LIMITS },
    };
  },
});

/** Every tool that exists, by name. An application picks from these. */
export const GAME_MASTER_TOOL_NAMES = ['game_history', 'game_rules'] as const;
export type GameMasterToolName = (typeof GAME_MASTER_TOOL_NAMES)[number];

export const GAME_MASTER_TOOLS: Readonly<Record<GameMasterToolName, GameMasterTool>> = {
  game_history: gameHistoryTool,
  game_rules: gameRulesTool,
};

/** The tools with these names, in the order given. An unknown name is a configuration mistake. */
export function selectGameMasterTools(names: readonly string[]): GameMasterTool[] {
  return names.map((name) => {
    const known = (GAME_MASTER_TOOL_NAMES as readonly string[]).includes(name);
    if (!known) {
      throw new Error(
        `"${name}" is not a Game Master tool. Known tools: ${GAME_MASTER_TOOL_NAMES.join(', ')}.`,
      );
    }
    return GAME_MASTER_TOOLS[name as GameMasterToolName];
  });
}
