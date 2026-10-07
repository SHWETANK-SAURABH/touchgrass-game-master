export {
  GAME_STATUSES,
  TERMINAL_STATUSES,
  LIFECYCLE_TRANSITIONS,
  gameStatusSchema,
  type GameStatus,
  isTerminalStatus,
  canTransition,
  playerStatusSchema,
  type PlayerStatus,
  playerStateSchema,
  type PlayerState,
  historySourceSchema,
  type HistorySource,
  historyRecordSchema,
  type HistoryRecord,
  historyEntrySchema,
  type HistoryEntry,
  roundTimerSchema,
  type RoundTimer,
  gameStateSchema,
  type GameState,
  findPlayer,
} from './state';

export {
  playerActionSchema,
  playerReadyActionSchema,
  playerTaggedActionSchema,
  playerFoundActionSchema,
  playerActivatedPowerActionSchema,
  playerCompletedChallengeActionSchema,
  playerAcceptedEventActionSchema,
  type PlayerAction,
  type PlayerReadyAction,
  type PlayerTaggedAction,
  type PlayerFoundAction,
  type PlayerActivatedPowerAction,
  type PlayerCompletedChallengeAction,
  type PlayerAcceptedEventAction,
  parsePlayerAction,
} from './actions';

export {
  EVENT_LIMITS,
  gameEventSchema,
  roundStartEventSchema,
  roundEndEventSchema,
  zoneChangeEventSchema,
  challengeEventSchema,
  powerUpEventSchema,
  ruleModifierEventSchema,
  bonusObjectiveEventSchema,
  timeExtensionEventSchema,
  roleChangeEventSchema,
  gameEndEventSchema,
  playerOutEventSchema,
  powerActivatedEventSchema,
  objectiveCompletedEventSchema,
  type GameEvent,
  type RoundStartEvent,
  type RoundEndEvent,
  type ZoneChangeEvent,
  type ChallengeEvent,
  type PowerUpEvent,
  type RuleModifierEvent,
  type BonusObjectiveEvent,
  type TimeExtensionEvent,
  type RoleChangeEvent,
  type GameEndEvent,
  type PlayerOutEvent,
  type PowerActivatedEvent,
  type ObjectiveCompletedEvent,
  EXTERNAL_EVENT_SCHEMAS,
  externalGameEventSchema,
  externalRoleChangeEventSchema,
  type ExternalGameEvent,
  parseGameEvent,
} from './events';

export {
  activeModifierSchema,
  type ActiveModifier,
  activeObjectiveSchema,
  type ActiveObjective,
} from './modifiers';

export { validateGameEvent, validatePlayerAction, findRule, isImmune } from './validate';

export { SCORE_REASONS, scoreAwardSchema, type ScoreAward, pointsFor } from './scoring';

export { evaluateWinners } from './win-conditions';

// `applyEvent`, `awardsForEvent` and `applyAwards` are deliberately not exported.
// They apply an event or add points without the checks on where it came from, so
// the only way for a caller outside this package to change gameplay state is
// through `processPlayerAction`, `submitGameEvent`, `reduce` and `advanceTime`.
export type { EngineContext } from './apply-event';

export { eventsForAction, processPlayerAction } from './process-action';

export { advanceTime } from './time';

export {
  type ExternalEventSource,
  type ValidatedGameEvent,
  validateExternalEvent,
  applyValidatedEvent,
} from './external-events';

export {
  type EngineInput,
  type TimedInput,
  contextAt,
  sequentialEntryId,
  submitGameEvent,
  step,
  replay,
} from './engine';

export {
  engineCommandSchema,
  createSessionCommandSchema,
  addPlayerCommandSchema,
  removePlayerCommandSchema,
  advancePhaseCommandSchema,
  pauseSessionCommandSchema,
  resumeSessionCommandSchema,
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

export { createSession, reduce } from './reduce';
