/**
 * The hand-off entry point: `@touchgrass/ai/handoff`.
 *
 * Separate from `@touchgrass/ai/game-master` on purpose: the Game Master module
 * can only propose, and this module is the only place in the package that
 * passes anything to the game engine.
 */
export {
  type ValidatedProposal,
  type ProposalRejection,
  type HandoffOutcome,
  type HandoffFailure,
  type ProposalTarget,
  validateGameMasterProposal,
  handOffProposal,
  handOffProposalTo,
  runGameMasterTurn,
} from './handoff';
