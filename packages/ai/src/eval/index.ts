/**
 * The evaluation entry point: `@touchgrass/ai/eval`.
 *
 * Separate from the package root so that code which only needs a provider or
 * the Game Master does not load the evaluation cases.
 */
export {
  EVAL_T0,
  type EvalCase,
  type EvalExpectation,
  type EvalObservation,
  type EvalOutcome,
  type EvalStage,
  type EvaluationResult,
  type EvaluationSummary,
  runEvalCase,
  runEvaluation,
  scriptedModelProvider,
  standardGame,
  summarizeEvaluation,
} from './harness';

export { GOLDEN_CASES } from './golden';
