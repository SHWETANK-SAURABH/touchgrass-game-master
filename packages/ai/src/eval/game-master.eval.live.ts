import { describe, expect, it } from 'vitest';
import { parseServerEnv } from '@touchgrass/shared';
import { createModelProviderFromEnv } from '../provider/registry';
import { gameHistoryTool, gameRulesTool } from '../tools/game-tools';
import { type EvalCase, runEvaluation, standardGame } from './harness';

/**
 * A live evaluation of the Game Master against the real model runtime.
 *
 * Opt-in twice over: it is only picked up by `npm run ai:live`, and even then
 * it runs only with GAME_MASTER_LIVE_EVAL=1. Nothing in `npm run verify` needs
 * a model.
 *
 *   GAME_MASTER_LIVE_EVAL=1 npm run ai:live
 *
 * It asks the real model for a proposal in a fixed set of games, with and
 * without tools, and puts every answer through the real pipeline. It then
 * prints what was measured:
 *
 *   valid structured output rate, schema rejection rate, safety rejection rate,
 *   engine acceptance rate, timeout rate, tool-call success rate, latency
 *
 * These are measurements, not thresholds: a model is free to propose nothing,
 * and how often it proposes something safe and legal is what is being found
 * out. What is asserted is only what must hold whatever the model says: every
 * turn ended in a known way, and no turn broke an invariant of the pipeline.
 */

const RUNS_PER_SETUP = Number(process.env.GAME_MASTER_LIVE_EVAL_RUNS ?? '3');

const setups: Omit<EvalCase, 'id' | 'replies' | 'expected'>[] = [
  { description: 'Tag, a minute into round 1, no tools.' },
  { description: 'Tag, late in round 1, no tools.', atMs: 170_000 },
  {
    description: 'Hide and Seek, a minute in, no tools.',
    state: () => standardGame('hide-and-seek'),
  },
  { description: 'Tag, a minute in, with both tools.', tools: [gameHistoryTool, gameRulesTool] },
  {
    description: 'Hide and Seek, a minute in, with both tools.',
    state: () => standardGame('hide-and-seek'),
    tools: [gameHistoryTool, gameRulesTool],
  },
];

describe.skipIf(!process.env.GAME_MASTER_LIVE_EVAL)('live evaluation of the Game Master', () => {
  it(
    'measures the real model through the real pipeline',
    async () => {
      const env = parseServerEnv(process.env);
      const provider = createModelProviderFromEnv(env);
      const cases: EvalCase[] = setups.flatMap((setup, index) =>
        Array.from({ length: RUNS_PER_SETUP }, (_unused, run) => ({
          ...setup,
          id: `live-${String(index + 1)}-${String(run + 1)}`,
          replies: [],
          // An expectation is needed by the harness and is not what is measured.
          expected: { outcome: 'APPLIED' as const },
        })),
      );

      const { results, summary } = await runEvaluation(cases, { provider });

      console.log(
        JSON.stringify(
          {
            provider: provider.id,
            model: provider.model,
            turns: summary.total,
            outcomes: summary.outcomes,
            validStructuredOutputRate: summary.validStructuredOutputRate,
            schemaRejectionRate: summary.schemaRejectionRate,
            safetyRejectionRate: summary.safetyRejectionRate,
            engineAcceptanceRate: summary.engineAcceptanceRate,
            timeoutRate: summary.timeoutRate,
            toolCallSuccessRate: summary.toolCallSuccessRate,
            latencyMs: summary.latencyMs,
            turnsDetail: results.map((result) => ({
              id: result.caseId,
              outcome: result.actual.outcome,
              stage: result.actual.stage,
              code: result.actual.code,
              eventType: result.actual.eventType,
              toolCalls: result.actual.toolCalls,
              attempts: result.actual.attempts,
              durationMs: result.durationMs,
            })),
          },
          null,
          2,
        ),
      );

      expect(results).toHaveLength(cases.length);
      for (const result of results) {
        expect(['APPLIED', 'NO_EVENT', 'REJECTED', 'FAILED']).toContain(result.actual.outcome);
        // Whatever the model said, the pipeline's own guarantees held.
        expect(result.reason ?? '', result.caseId).not.toMatch(/^INVARIANT/);
        if (result.actual.outcome !== 'APPLIED') expect(result.actual.stateChanged).toBe(false);
      }
    },
    15 * 60_000,
  );
});
