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
