/**
 * The Game Master entry point: `@touchgrass/ai/game-master`.
 *
 * Kept separate from the package root so that code which only needs a model
 * provider (the health check, for instance) does not load the agent framework.
 */
export {
  type GameMaster,
  type GameMasterError,
  type GameMasterErrorCode,
  type GameMasterOptions,
  type GameMasterResult,
  GAME_MASTER_ERROR_CODES,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_CALLS_LIMIT,
  createGameMaster,
  createGameMasterFromEnv,
} from './game-master';

export { type GameMasterContext, type GameMasterView, buildGameMasterView } from './context';

export {
  type GameMasterProposal,
  gameMasterProposalSchema,
  proposalOutputSchemaFor,
  parseGameMasterProposal,
} from './proposal';

export { GAME_MASTER_SYSTEM_PROMPT } from './prompt';

export { createProviderLanguageModel } from './model-adapter';

export {
  type GameMasterTool,
  type ToolCallRecord,
  type ToolFailureCode,
  type ToolResult,
  type ToolRunOptions,
  type ToolScope,
  type ToolSet,
  TOOL_FAILURE_CODES,
  createToolSet,
  defineTool,
  runToolCall,
} from '../tools/tool';

export {
  type GameMasterToolName,
  GAME_MASTER_TOOLS,
  GAME_MASTER_TOOL_NAMES,
  gameHistoryTool,
  gameRulesTool,
  selectGameMasterTools,
} from '../tools/game-tools';
