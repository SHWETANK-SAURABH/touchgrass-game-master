import { fixedClock } from '@touchgrass/shared';
import { findGameDefinition } from '@touchgrass/game-definitions';
import {
  type GameState,
  contextAt,
  createSession,
  processPlayerAction,
  reduce,
} from '@touchgrass/game-engine';
import type { PolicyOptions } from '@touchgrass/safety';
import { createGameMaster } from '../game-master/game-master';
import { handOffProposal } from '../handoff/handoff';
import { parseJsonOutput } from '../provider/http';
import type { ModelProvider } from '../provider/types';
import type { GameMasterTool } from '../tools/tool';

/**
 * An evaluation harness for the Game Master pipeline.
 *
 *   a game  +  what the model says  →  the real pipeline  →  what happened
 *
 * A case names a game state, the replies a model gives, and what should happen.
 * The harness runs the real Game Master agent, the real schema, the real engine
 * validator, the real safety validator and the real engine over them, and
 * reports whether what happened is what the case expected.
 *
 * The model is the only thing that is replaced. By default it is a script, so
 * an evaluation is exact and needs no model runtime. Given a real provider
 * instead, the same cases measure a real model; then only the invariants are
 * certain, and the expectations become measurements.
 *
 * Every case is also held to the invariants, whatever it expects:
 *
 *   - a turn that did not apply an event left the game exactly as it was;
 *   - an applied event is recorded as the Game Master's, by the engine;
 *   - nothing sent to the model contained the join code;
 *   - the model was never offered a native tool.
 *
 * The harness reads and returns values. It keeps nothing and writes nothing.
 */

export const EVAL_T0 = 1_700_000_000_000;

/** A three-player game with round 1 running since one second after it was created. */
export function standardGame(gameId: 'tag' | 'hide-and-seek' = 'tag'): GameState {
  const at = (ms: number) => contextAt(fixedClock(EVAL_T0 + ms));
  const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
    if (!result.ok) throw new Error('The evaluation fixture could not be built.');
    return result.value;
  };
  let state = must(
    createSession(
      { type: 'CREATE_SESSION', sessionId: 'eval', gameId, joinCode: 'EVALJC', randomSeed: 7 },
      at(0),
    ),
  );
  for (const index of [0, 1, 2]) {
    state = must(
      reduce(
        state,
        { type: 'ADD_PLAYER', playerId: `p${index}`, displayName: `Player ${index}` },
        at(0),
      ),
    );
  }
  for (const player of state.players) {
    state = must(
      processPlayerAction(state, { type: 'PLAYER_READY', playerId: player.id }, at(1_000)),
    );
  }
  return state;
}

/** A model runtime that replies with what it is given, in order, and records every request. */
export function scriptedModelProvider(
  replies: readonly (object | string | Error)[],
): ModelProvider & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  let index = 0;
  const next = (): string => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  const health = {
    ok: true,
    provider: 'scripted',
    model: 'scripted-model',
    baseUrl: 'memory://scripted',
    reachable: true,
    modelAvailable: true,
    latencyMs: 0,
  };
  return {
    id: 'scripted',
    model: 'scripted-model',
    baseUrl: 'memory://scripted',
    requests,
    health: () => Promise.resolve(health),
    generateText: (request) =>
      new Promise((resolve) => {
        requests.push(request);
        resolve({ text: next(), model: 'scripted-model', latencyMs: 0 });
      }),
    generateJson: (request) =>
      new Promise((resolve) => {
        requests.push(request);
        const raw = next();
        resolve({
          data: parseJsonOutput(raw, 'scripted'),
          raw,
          model: 'scripted-model',
          latencyMs: 0,
        });
      }),
  };
}

export type EvalOutcome = 'APPLIED' | 'NO_EVENT' | 'REJECTED' | 'FAILED';
export type EvalStage = 'PROPOSAL' | 'SCHEMA' | 'STATE' | 'SAFETY' | 'APPLICATION';

/** What a case says should happen. Only the fields given are compared. */
export interface EvalExpectation {
  readonly outcome: EvalOutcome;
  readonly stage?: EvalStage;
  /** A stable code: a Game Master error code, a model error code, or a safety rejection kind. */
  readonly code?: string;
  readonly eventType?: string;
  /** The tool calls, in order: which tool and how each ended. */
  readonly toolCalls?: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code?: string;
  }[];
}

/** What did happen. */
export interface EvalObservation {
  readonly outcome: EvalOutcome;
  readonly stage?: EvalStage;
  readonly code?: string;
  readonly eventType?: string;
  readonly toolCalls: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly code?: string;
  }[];
  readonly attempts?: number;
  /** How many times the model was asked. */
  readonly modelCalls: number;
  /** Whether the game after the turn is a different state from the game before it. */
  readonly stateChanged: boolean;
}

export interface EvalCase {
  readonly id: string;
  readonly description: string;
  /** The game the turn is taken in. Defaults to a running game of Tag. */
  readonly state?: () => GameState;
  /** Milliseconds after the fixture's start at which the turn is taken. Default 61 seconds. */
  readonly atMs?: number;
  /** What the scripted model replies, in order. The last one repeats. */
  readonly replies: readonly (object | string | Error)[];
  /** The tools the Game Master is given. Default none. */
  readonly tools?: readonly GameMasterTool[];
  readonly maxToolCalls?: number;
  readonly toolTimeoutMs?: number;
  readonly maxToolOutputBytes?: number;
  readonly safety?: PolicyOptions;
  readonly expected: EvalExpectation;
}

export interface EvaluationResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly expected: EvalExpectation;
  readonly actual: EvalObservation;
  /** Where the turn ended, when it did not end in an applied event or a decision to do nothing. */
  readonly stage?: EvalStage;
  /** Why the case did not pass. Absent when it passed. */
  readonly reason?: string;
  readonly durationMs: number;
}

const sameToolCalls = (
  expected: NonNullable<EvalExpectation['toolCalls']>,
  actual: EvalObservation['toolCalls'],
): boolean =>
  expected.length === actual.length &&
  expected.every(
    (call, index) =>
      call.name === actual[index]?.name &&
      call.ok === actual[index].ok &&
      call.code === actual[index].code,
  );

/**
 * Runs one case through the real pipeline.
 *
 * `provider` replaces the script with a real model runtime. The case's replies
 * are then ignored.
 */
export async function runEvalCase(
  evalCase: EvalCase,
  options: { readonly provider?: ModelProvider; readonly elapsed?: () => number } = {},
): Promise<EvaluationResult> {
  const elapsed = options.elapsed ?? (() => performance.now());
  const startedAt = elapsed();
  const scripted = scriptedModelProvider(evalCase.replies);
  const provider = options.provider ?? scripted;
  const state = (evalCase.state ?? standardGame)();
  const now = EVAL_T0 + (evalCase.atMs ?? 61_000);
  const ctx = contextAt(fixedClock(now));
  const definition = findGameDefinition(state.gameId);

  const gameMaster = createGameMaster({
    provider,
    ...(evalCase.tools ? { tools: evalCase.tools } : {}),
    ...(evalCase.maxToolCalls === undefined ? {} : { maxToolCalls: evalCase.maxToolCalls }),
    ...(evalCase.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: evalCase.toolTimeoutMs }),
    ...(evalCase.maxToolOutputBytes === undefined
      ? {}
      : { maxToolOutputBytes: evalCase.maxToolOutputBytes }),
  });

  let after = state;
  let actual: Omit<EvalObservation, 'modelCalls' | 'stateChanged'>;
  if (!definition) {
    actual = { outcome: 'FAILED', stage: 'SCHEMA', code: 'UNKNOWN_GAME', toolCalls: [] };
  } else {
    const proposed = await gameMaster.propose({ state, definition, now });
    if (!proposed.ok) {
      actual = {
        outcome: 'FAILED',
        stage: 'PROPOSAL',
        code: proposed.error.modelErrorCode ?? proposed.error.code,
        toolCalls: proposed.error.toolCalls ?? [],
        ...(proposed.error.attempts === undefined ? {} : { attempts: proposed.error.attempts }),
      };
    } else {
      const toolCalls = proposed.value.toolCalls ?? [];
      const attempts = proposed.value.attempts;
      const handed = handOffProposal(proposed.value.proposal, state, ctx, evalCase.safety);
      if (handed.ok) {
        after = handed.value.state;
        const eventType = handed.value.proposal.event?.type;
        actual = {
          outcome: handed.value.outcome,
          toolCalls,
          attempts,
          ...(eventType ? { eventType } : {}),
        };
      } else {
        const failure = handed.error;
        const eventType = 'proposal' in failure ? failure.proposal.event?.type : undefined;
        actual = {
          outcome: 'REJECTED',
          stage: failure.stage,
          code:
            failure.stage === 'SCHEMA'
              ? 'INVALID_PROPOSAL'
              : failure.stage === 'SAFETY'
                ? failure.rejection.kind
                : failure.error.code,
          toolCalls,
          attempts,
          ...(eventType ? { eventType } : {}),
        };
      }
    }
  }

  const observation: EvalObservation = {
    ...actual,
    toolCalls: actual.toolCalls.map((call) => ({
      name: call.name,
      ok: call.ok,
      ...(call.code ? { code: call.code } : {}),
    })),
    modelCalls: options.provider ? 0 : scripted.requests.length,
    stateChanged: after !== state,
  };

  // The invariants come first: a case that breaks one has failed whatever it expected.
  const sent = JSON.stringify(scripted.requests);
  const { expected } = evalCase;
  const reason =
    observation.outcome !== 'APPLIED' && observation.stateChanged
      ? 'INVARIANT: the game changed although no event was applied'
      : observation.outcome === 'APPLIED' && after.history.at(-1)?.source !== 'game-master'
        ? 'INVARIANT: an applied event is not recorded as the Game Master’s'
        : sent.includes(state.joinCode)
          ? 'INVARIANT: the join code was sent to the model'
          : /"tools"|"tool_choice"/.test(sent)
            ? 'INVARIANT: the model was offered a native tool'
            : expected.outcome !== observation.outcome
              ? `outcome: expected ${expected.outcome}, got ${observation.outcome}`
              : expected.stage !== undefined && expected.stage !== observation.stage
                ? `stage: expected ${expected.stage}, got ${String(observation.stage)}`
                : expected.code !== undefined && expected.code !== observation.code
                  ? `code: expected ${expected.code}, got ${String(observation.code)}`
                  : expected.eventType !== undefined && expected.eventType !== observation.eventType
                    ? `event: expected ${expected.eventType}, got ${String(observation.eventType)}`
                    : expected.toolCalls !== undefined &&
                        !sameToolCalls(expected.toolCalls, observation.toolCalls)
                      ? `tool calls: expected ${JSON.stringify(expected.toolCalls)}, got ${JSON.stringify(observation.toolCalls)}`
                      : undefined;

  return {
    caseId: evalCase.id,
    passed: reason === undefined,
    expected,
    actual: observation,
    ...(observation.stage ? { stage: observation.stage } : {}),
    ...(reason ? { reason } : {}),
    durationMs: Math.max(0, Math.round(elapsed() - startedAt)),
  };
}

/** What a set of results adds up to. Rates are between 0 and 1; a rate with nothing to count is null. */
export interface EvaluationSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly outcomes: Readonly<Record<EvalOutcome, number>>;
  /** Turns in which the model produced a well-formed proposal. */
  readonly validStructuredOutputRate: number | null;
  /** Proposals refused by the schema, of all turns. */
  readonly schemaRejectionRate: number | null;
  /** Proposed events refused by the safety validator. */
  readonly safetyRejectionRate: number | null;
  /** Proposed events the engine applied. */
  readonly engineAcceptanceRate: number | null;
  /** Turns that ended because the model did not answer in time. */
  readonly timeoutRate: number | null;
  /** Tool calls that returned an answer, of all tool calls. */
  readonly toolCallSuccessRate: number | null;
  readonly latencyMs: { readonly median: number; readonly max: number } | null;
}

const rate = (count: number, of: number): number | null => (of === 0 ? null : count / of);

export function summarizeEvaluation(results: readonly EvaluationResult[]): EvaluationSummary {
  const outcomes: Record<EvalOutcome, number> = { APPLIED: 0, NO_EVENT: 0, REJECTED: 0, FAILED: 0 };
  for (const result of results) outcomes[result.actual.outcome] += 1;
  const total = results.length;
  const at = (stage: EvalStage) => results.filter((result) => result.actual.stage === stage).length;
  const timedOut = results.filter((result) =>
    ['PROVIDER_TIMEOUT', 'TIMED_OUT', 'CANCELLED'].includes(result.actual.code ?? ''),
  ).length;
  const invalid = results.filter((result) => result.actual.code === 'INVALID_PROPOSAL').length;
  const proposedEvents = outcomes.APPLIED + at('STATE') + at('SAFETY') + at('APPLICATION');
  const toolCalls = results.flatMap((result) => result.actual.toolCalls);
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);

  return {
    total,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    outcomes,
    validStructuredOutputRate: rate(total - at('PROPOSAL') - at('SCHEMA'), total),
    schemaRejectionRate: rate(invalid, total),
    safetyRejectionRate: rate(at('SAFETY'), proposedEvents),
    engineAcceptanceRate: rate(outcomes.APPLIED, proposedEvents),
    timeoutRate: rate(timedOut, total),
    toolCallSuccessRate: rate(toolCalls.filter((call) => call.ok).length, toolCalls.length),
    latencyMs:
      durations.length === 0
        ? null
        : {
            median: durations[Math.floor((durations.length - 1) / 2)] ?? 0,
            max: durations.at(-1) ?? 0,
          },
  };
}

/** Runs the cases one after another and adds them up. */
export async function runEvaluation(
  cases: readonly EvalCase[],
  options: { readonly provider?: ModelProvider; readonly elapsed?: () => number } = {},
): Promise<{ readonly results: readonly EvaluationResult[]; readonly summary: EvaluationSummary }> {
  const results: EvaluationResult[] = [];
  for (const evalCase of cases) results.push(await runEvalCase(evalCase, options));
  return { results, summary: summarizeEvaluation(results) };
}
