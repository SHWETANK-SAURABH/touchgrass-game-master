import { shuffle, ok, err, type Rng, type Result } from '@touchgrass/shared';
import { type GameDefinition, defaultRoleOf } from '@touchgrass/game-definitions';
import { type EngineError, engineError } from './errors';

/**
 * Deterministic role assignment.
 *
 * Fills each non-default role up to its declared minimum, in declaration order,
 * drawing from a shuffled player list; everyone left over takes the default role.
 * Shuffling uses the session's seeded Rng, so the same seed and the same joining
 * order always produce the same teams. That is what makes a session replayable
 * from its log — and it is also why role assignment lives here rather than in the
 * model: who chases whom is a fairness decision, not a creative one.
 */
export function assignRoles(
  definition: GameDefinition,
  playerIds: readonly string[],
  rng: Rng,
): Result<Map<string, string>, EngineError> {
  const requiredBodies = definition.roles.reduce((sum, role) => sum + role.min, 0);
  if (playerIds.length < Math.max(definition.minPlayers, requiredBodies)) {
    return err(
      engineError(
        'NOT_ENOUGH_PLAYERS',
        `"${definition.name}" needs at least ${definition.minPlayers} players to start; ${playerIds.length} present.`,
        { gameId: definition.id, present: playerIds.length, required: definition.minPlayers },
      ),
    );
  }
  if (playerIds.length > definition.maxPlayers) {
    return err(
      engineError(
        'SESSION_FULL',
        `"${definition.name}" supports at most ${definition.maxPlayers} players; ${playerIds.length} present.`,
        { gameId: definition.id, present: playerIds.length, max: definition.maxPlayers },
      ),
    );
  }

  const fallbackRole = defaultRoleOf(definition);
  const pool = shuffle(playerIds, rng);
  const assignment = new Map<string, string>();
  let cursor = 0;

  for (const role of definition.roles) {
    if (role.id === fallbackRole.id) continue;
    for (let filled = 0; filled < role.min; filled += 1) {
      const playerId = pool[cursor];
      if (playerId === undefined) {
        // Unreachable given the headcount check above; kept as a hard stop rather
        // than an assumption, because a silent miss here would start a game with
        // nobody chasing.
        return err(
          engineError(
            'ROLE_CONSTRAINT_VIOLATED',
            `Ran out of players while filling role "${role.id}".`,
            { gameId: definition.id, roleId: role.id },
          ),
        );
      }
      assignment.set(playerId, role.id);
      cursor += 1;
    }
  }

  for (const playerId of pool.slice(cursor)) {
    assignment.set(playerId, fallbackRole.id);
  }

  // Respect declared maxima: push the overflow of any capped role into the
  // default role rather than starting a game with five taggers and one runner.
  for (const role of definition.roles) {
    if (role.max === undefined || role.id === fallbackRole.id) continue;
    const holders = [...assignment.entries()]
      .filter(([, roleId]) => roleId === role.id)
      .map(([playerId]) => playerId);
    for (const playerId of holders.slice(role.max)) {
      assignment.set(playerId, fallbackRole.id);
    }
  }

  return ok(assignment);
}

/** Verifies a proposed single-player role change against the definition's maxima. */
export function canHoldRole(
  definition: GameDefinition,
  roleId: string,
  currentHolderCount: number,
): Result<true, EngineError> {
  const role = definition.roles.find((candidate) => candidate.id === roleId);
  if (!role) {
    return err(
      engineError('ROLE_CONSTRAINT_VIOLATED', `Game "${definition.id}" has no role "${roleId}".`, {
        gameId: definition.id,
        roleId,
      }),
    );
  }
  if (role.max !== undefined && currentHolderCount >= role.max) {
    return err(
      engineError(
        'ROLE_CONSTRAINT_VIOLATED',
        `Role "${roleId}" already holds its maximum of ${role.max}.`,
        { gameId: definition.id, roleId, max: role.max },
      ),
    );
  }
  return ok(true);
}
