import { describe, expect, it } from 'vitest';
import { GOLDEN_CASES } from './golden';
import {
  type EvalCase,
  type EvaluationResult,
  runEvalCase,
  runEvaluation,
  scriptedModelProvider,
  standardGame,
  summarizeEvaluation,
} from './harness';

const RATIONALE = 'The round has gone quiet and needs one small change.';
const zone = { type: 'ZONE_CHANGE', modifier: 'SAFE_ZONE', zone: 'the bench', durationSeconds: 60 };

describe('the golden scenarios', () => {
  it.each(GOLDEN_CASES.map((evalCase) => [evalCase.id, evalCase] as const))(
    '%s',
    async (_id, evalCase) => {
      const result = await runEvalCase(evalCase);
      expect(result.reason, evalCase.description).toBeUndefined();
      expect(result.passed).toBe(true);
      expect(result.caseId).toBe(evalCase.id);
    },
  );

  it('have ids that are unique and say what they are', () => {
    const ids = GOLDEN_CASES.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const evalCase of GOLDEN_CASES) {
      expect(evalCase.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(evalCase.description.length).toBeGreaterThan(20);
    }
  });

  it('cover every way a turn can end, and every way a tool call can fail', () => {
    const ends = new Set(
      GOLDEN_CASES.map(
        (evalCase) => `${evalCase.expected.outcome}/${evalCase.expected.stage ?? '-'}`,
      ),
    );
    for (const end of [
      'APPLIED/-',
      'NO_EVENT/-',
      'REJECTED/SAFETY',
      'REJECTED/STATE',
      'FAILED/PROPOSAL',
    ]) {
      expect(ends, end).toContain(end);
    }
    const toolCodes = new Set(
      GOLDEN_CASES.flatMap((evalCase) => evalCase.expected.toolCalls ?? []).map(
        (call) => call.code ?? 'ok',
      ),
    );
    for (const code of [
      'ok',
      'UNKNOWN_TOOL',
      'INVALID_ARGUMENTS',
      'TOOL_TIMEOUT',
      'TOOL_FAILED',
      'INVALID_OUTPUT',
      'OUTPUT_TOO_LARGE',
    ]) {
      expect(toolCodes, code).toContain(code);
    }
  });

  it('add up to a summary with every rate in it', async () => {
    const { results, summary } = await runEvaluation(GOLDEN_CASES);
    expect(summary.total).toBe(GOLDEN_CASES.length);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(GOLDEN_CASES.length);
    expect(Object.values(summary.outcomes).reduce((a, b) => a + b, 0)).toBe(results.length);
    for (const key of [
      'validStructuredOutputRate',
      'schemaRejectionRate',
      'safetyRejectionRate',
      'engineAcceptanceRate',
      'timeoutRate',
      'toolCallSuccessRate',
    ] as const) {
      const value = summary[key];
      expect(value, key).not.toBeNull();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(summary.latencyMs?.max).toBeGreaterThanOrEqual(summary.latencyMs?.median ?? 0);
  });
});

describe('the evaluation harness', () => {
  const applied: EvalCase = {
    id: 'applied',
    description: 'A legal, safe zone change.',
    replies: [{ rationale: RATIONALE, event: zone }],
    expected: { outcome: 'APPLIED', eventType: 'ZONE_CHANGE' },
  };

  it('reports a structured result for a case that passes', async () => {
    const result = await runEvalCase(applied, { elapsed: () => 0 });
    expect(result).toEqual({
      caseId: 'applied',
      passed: true,
      expected: { outcome: 'APPLIED', eventType: 'ZONE_CHANGE' },
      actual: {
        outcome: 'APPLIED',
        eventType: 'ZONE_CHANGE',
        toolCalls: [],
        attempts: 1,
        modelCalls: 1,
        stateChanged: true,
      },
      durationMs: 0,
    });
  });

  it.each([
    ['the outcome', { outcome: 'NO_EVENT' }, /^outcome: expected NO_EVENT, got APPLIED$/],
    ['the stage', { outcome: 'APPLIED', stage: 'SAFETY' }, /^stage: expected SAFETY/],
    ['the code', { outcome: 'APPLIED', code: 'UNSAFE' }, /^code: expected UNSAFE/],
    ['the event', { outcome: 'APPLIED', eventType: 'POWER_UP' }, /^event: expected POWER_UP/],
    [
      'the tool calls',
      { outcome: 'APPLIED', toolCalls: [{ name: 'game_rules', ok: true }] },
      /^tool calls: expected/,
    ],
  ] as const)('says why a case did not pass when %s differs', async (_what, expected, reason) => {
    const result = await runEvalCase({ ...applied, expected });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(reason);
    // What happened is reported as it was, whatever was expected.
    expect(result.actual.outcome).toBe('APPLIED');
  });

  it('reports the stage at which a refused turn ended', async () => {
    const result = await runEvalCase({
      ...applied,
      replies: [{ rationale: RATIONALE, event: { ...zone, zone: 'the car park' } }],
      expected: { outcome: 'REJECTED' },
    });
    expect(result).toMatchObject({ passed: true, stage: 'SAFETY' });
    expect(result.actual).toMatchObject({ stage: 'SAFETY', code: 'UNSAFE', stateChanged: false });
  });

  it('never changes the game it was given', async () => {
    const state = standardGame();
    const before = JSON.stringify(state);
    for (const evalCase of GOLDEN_CASES.slice(0, 8)) {
      await runEvalCase({ ...evalCase, state: () => state });
    }
    expect(JSON.stringify(state)).toBe(before);
  });

  it('is the same every time for the same case', async () => {
    const strip = ({ durationMs: _durationMs, ...rest }: EvaluationResult) => rest;
    for (const evalCase of GOLDEN_CASES.filter((candidate) => !candidate.toolTimeoutMs)) {
      const [first, second] = await Promise.all([runEvalCase(evalCase), runEvalCase(evalCase)]);
      expect(strip(first), evalCase.id).toEqual(strip(second));
    }
  });

  it('builds the same fixture every time, and a script that repeats its last reply', async () => {
    expect(standardGame()).toEqual(standardGame());
    expect(standardGame().status).toBe('active');
    expect(standardGame('hide-and-seek').gameId).toBe('hide-and-seek');
    const provider = scriptedModelProvider(['one', 'two']);
    const ask = async () => (await provider.generateText({ messages: [] })).text;
    expect([await ask(), await ask(), await ask()]).toEqual(['one', 'two', 'two']);
    expect(provider.requests).toHaveLength(3);
  });

  it('summarizes nothing as nothing, with no rate invented', () => {
    expect(summarizeEvaluation([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      outcomes: { APPLIED: 0, NO_EVENT: 0, REJECTED: 0, FAILED: 0 },
      validStructuredOutputRate: null,
      schemaRejectionRate: null,
      safetyRejectionRate: null,
      engineAcceptanceRate: null,
      timeoutRate: null,
      toolCallSuccessRate: null,
      latencyMs: null,
    });
  });

  it('counts the rates from what happened', async () => {
    const { summary } = await runEvaluation(
      GOLDEN_CASES.filter((evalCase) =>
        [
          'safe-event',
          'unsafe-zone',
          'no-event',
          'prose',
          'model-timeout',
          'tool-success',
          'tool-invented',
        ].includes(evalCase.id),
      ),
    );
    expect(summary.total).toBe(7);
    expect(summary.outcomes).toEqual({ APPLIED: 2, NO_EVENT: 2, REJECTED: 1, FAILED: 2 });
    // Two of seven turns produced no well-formed proposal.
    expect(summary.validStructuredOutputRate).toBeCloseTo(5 / 7);
    expect(summary.schemaRejectionRate).toBeCloseTo(1 / 7);
    // Three events were proposed: two applied, one refused for safety.
    expect(summary.engineAcceptanceRate).toBeCloseTo(2 / 3);
    expect(summary.safetyRejectionRate).toBeCloseTo(1 / 3);
    expect(summary.timeoutRate).toBeCloseTo(1 / 7);
    expect(summary.toolCallSuccessRate).toBeCloseTo(1 / 2);
  });
});
