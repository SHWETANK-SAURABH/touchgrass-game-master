export {
  sessionStatusSchema,
  type SessionStatus,
  playerSchema,
  type Player,
  eventSourceSchema,
  type EventSource,
  logEntrySchema,
  type LogEntry,
  activeModifierSchema,
  type ActiveModifier,
  sessionStateSchema,
  type SessionState,
  currentPhaseId,
  activePlayers,
  findPlayer,
  playersInRole,
} from './state';

export {
  PROPOSAL_LIMITS,
  proposalTargetSchema,
  type ProposalTarget,
  announceProposalSchema,
  objectiveProposalSchema,
  modifierProposalSchema,
  zoneRuleProposalSchema,
  timerProposalSchema,
  scoreAdjustProposalSchema,
  roleAssignProposalSchema,
  gameEventProposalSchema,
  gameMasterTurnSchema,
  type GameEventProposal,
  type AnnounceProposal,
  type ObjectiveProposal,
  type ModifierProposal,
  type ZoneRuleProposal,
  type TimerProposal,
  type ScoreAdjustProposal,
  type RoleAssignProposal,
  type GameMasterTurn,
  proposalTextFragments,
  proposalDurationSeconds,
} from './proposal';

export {
  engineCommandSchema,
  createSessionCommandSchema,
  addPlayerCommandSchema,
  removePlayerCommandSchema,
  startSessionCommandSchema,
  advancePhaseCommandSchema,
  pauseSessionCommandSchema,
  resumeSessionCommandSchema,
  completeSessionCommandSchema,
  abortSessionCommandSchema,
  type EngineCommand,
  type SessionCommand,
  type CreateSessionCommand,
  type AddPlayerCommand,
  type RemovePlayerCommand,
  type PauseSessionCommand,
  type AbortSessionCommand,
} from './commands';

export { ENGINE_ERROR_CODES, type EngineError, type EngineErrorCode, engineError } from './errors';

export { assignRoles } from './roles';

export { type EngineContext, createSession, reduce, replay } from './reduce';
