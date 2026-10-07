import { z } from 'zod';
import {
  MODIFIERS_BY_EVENT,
  gameModifierKindSchema,
  optionalEventKindSchema,
  playerActionKindSchema,
} from './vocabulary';

/**
 * Game definitions are *data*, not code.
 *
 * A definition declares everything the rest of the system needs to know about a
 * game: how many bodies it needs, what roles exist, which phases it moves
 * through, which events, modifiers and player actions it supports, how it is
 * scored and won, and which physical risks are inherent to it. The engine reads
 * it to validate actions and events, the safety layer reads it to pick a policy,
 * and the agent reads it to build a prompt.
 *
 * Because it is data, adding a sixth game is a pull request against one file —
 * which is exactly the contribution shape Hacktoberfest rewards.
 */

/** How much ground the game needs. Feeds both matchmaking copy and safety policy. */
export const spaceRequirementSchema = z.enum([
  'small', // a back garden or courtyard
  'medium', // a park lawn or quiet field
  'large', // a full park, woodland edge, or sports pitch
]);
export type SpaceRequirement = z.infer<typeof spaceRequirementSchema>;

/** Expected physical exertion. Caps how demanding a proposed modifier may be. */
export const intensitySchema = z.enum(['low', 'moderate', 'high']);
export type Intensity = z.infer<typeof intensitySchema>;

/**
 * Whether the game involves touching other players at all, and how.
 *
 * Tag inherently involves contact; a nature scavenger hunt does not. The safety
 * layer uses this to reject any proposal that introduces contact into a game
 * that declared itself contact-free.
 */
export const contactPolicySchema = z.enum([
  'none', // no player-to-player contact whatsoever
  'tag-only', // a light touch to tag, nothing more
  'cooperative', // hand-holding, linking arms, team formations
]);
export type ContactPolicy = z.infer<typeof contactPolicySchema>;

export const gameRoleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'role ids are lower-kebab-case'),
  label: z.string().min(1),
  description: z.string().min(1),
  /** Minimum number of players who must hold this role once the game starts. */
  min: z.int().min(0),
  /** Maximum, or omitted for "everyone else". */
  max: z.int().min(1).optional(),
  /**
   * Exactly one role per game is the overflow role: players left over after every
   * other role has met its minimum are assigned here.
   */
  isDefault: z.boolean().default(false),
});
export type GameRole = z.infer<typeof gameRoleSchema>;

/**
 * A named stage of play. Phases give the Game Master a legible sense of "where
 * we are" without letting it move the session itself — only the engine advances
 * a phase, and only in the declared order.
 */
export const gamePhaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  description: z.string().min(1),
  /** Soft pacing guidance. The engine does not auto-advance on it. */
  typicalDurationSeconds: z.int().positive().optional(),
});
export type GamePhase = z.infer<typeof gamePhaseSchema>;

/**
 * Risks that are *inherent* to this game, declared up front.
 *
 * This is not the safety validator — it is an input the validator will consult.
 * Declaring that hide-and-seek naturally tempts players into undergrowth lets
 * the eventual rule set be stricter about that game specifically, instead of
 * applying one blunt policy everywhere.
 */
export const gameSafetyProfileSchema = z.object({
  contactPolicy: contactPolicySchema,
  maxIntensity: intensitySchema,
  /** Players move out of each others sight during normal play (hide & seek, treasure hunt). */
  involvesSeparation: z.boolean(),
  /** Play is unsafe or unsupervisable after dark. */
  requiresDaylight: z.boolean(),
  /** Free-text notes that both the eventual validator and the agent prompt consume. */
  inherentRisks: z.array(z.string().min(1)).min(1),
});
export type GameSafetyProfile = z.infer<typeof gameSafetyProfileSchema>;

/**
 * Game-specific instruction fragments for the Game Master prompt.
 *
 * Kept beside the rules rather than inside the agent, so a new game ships its own
 * voice and its own list of things never to suggest. The agent itself arrives in a
 * later phase; this is the content it will assemble.
 */
export const gameMasterGuidanceSchema = z.object({
  /** One or two sentences describing the Game Master persona for this game. */
  persona: z.string().min(1),
  /** Concrete things good twists do in this game. */
  encourage: z.array(z.string().min(1)).min(1),
  /** Concrete things the model must never propose here, in plain language. */
  avoid: z.array(z.string().min(1)).min(1),
  /** Hand-written examples of well-formed twists, for few-shot prompting. */
  exampleTwists: z.array(z.string().min(1)).min(2),
});
export type GameMasterGuidance = z.infer<typeof gameMasterGuidanceSchema>;

/**
 * A rule the engine enforces when a player reports an action against another
 * player. It names who may do it, to whom, and what happens — as data the engine
 * interprets, never as prose. How the outcome is applied is engine work.
 */
export const gameRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'rule ids are lower-kebab-case'),
    description: z.string().min(1),
    /** The reported action this rule governs. */
    action: z.enum(['PLAYER_TAGGED', 'PLAYER_FOUND']),
    /** Role the reporting player must hold. */
    actorRoleId: z.string().min(1),
    /** Role the other player must hold. */
    targetRoleId: z.string().min(1),
    /** SWAP_ROLES: the two players exchange roles. TARGET_OUT: the target is out for the round. */
    outcome: z.enum(['SWAP_ROLES', 'TARGET_OUT']),
  })
  .strict();
export type GameRule = z.infer<typeof gameRuleSchema>;

/** A power a POWER_UP event can grant. Its effect is one the engine implements. */
export const gamePowerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'power ids are lower-kebab-case'),
    label: z.string().min(1),
    description: z.string().min(1),
    /** TAG_IMMUNITY: while active, the holder cannot be tagged. */
    effect: z.enum(['TAG_IMMUNITY']),
    /** How long the power lasts once activated. */
    durationSeconds: z.int().min(5).max(600),
  })
  .strict();
export type GamePower = z.infer<typeof gamePowerSchema>;

/** The moments at which the engine awards points. */
export const SCORING_TRIGGERS = [
  /** The reporting player made a valid tag. */
  'TAG_MADE',
  /** A player ended the round without being tagged or found. */
  'ROUND_SURVIVED',
  /** The reporting player found another player. */
  'FOUND_PLAYER',
  /** A hiding player was still hidden when the round ended. */
  'STAYED_HIDDEN',
  /** The seeker found every hider before the round ended. */
  'ALL_FOUND',
] as const;
export const scoringTriggerSchema = z.enum(SCORING_TRIGGERS);
export type ScoringTrigger = z.infer<typeof scoringTriggerSchema>;

/** Points for one trigger. A game's scoring is the list of these; nothing else awards points. */
export const scoringRuleSchema = z
  .object({
    trigger: scoringTriggerSchema,
    points: z.int().min(1).max(100),
  })
  .strict();
export type ScoringRule = z.infer<typeof scoringRuleSchema>;

/** How a winner is chosen. The engine evaluates these; no model is asked who won. */
export const WIN_CONDITION_TYPES = ['HIGHEST_SCORE'] as const;
export const winConditionSchema = z
  .object({
    type: z.enum(WIN_CONDITION_TYPES),
  })
  .strict();
export type WinCondition = z.infer<typeof winConditionSchema>;

/** The settings a game runs with. A definition supplies the values a new game starts from. */
export const gameSettingsSchema = z
  .object({
    totalRounds: z.int().min(1).max(10),
    roundDurationSeconds: z.int().min(30).max(3600),
  })
  .strict();
export type GameSettings = z.infer<typeof gameSettingsSchema>;

const INTENSITY_RANK: Record<Intensity, number> = { low: 1, moderate: 2, high: 3 };

export const gameDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'game ids are lower-kebab-case'),
    name: z.string().min(1),
    tagline: z.string().min(1).max(120),
    description: z.string().min(1),
    /** 1 is allowed so a solo game can be defined. */
    minPlayers: z.int().min(1),
    maxPlayers: z.int().min(1),
    recommendedDurationMinutes: z.int().positive(),
    spaceRequirement: spaceRequirementSchema,
    intensity: intensitySchema,
    /** Everyday items players need. Empty means "nothing but yourselves". */
    equipment: z.array(z.string().min(1)),
    roles: z.array(gameRoleSchema).min(1),
    phases: z.array(gamePhaseSchema).min(1),
    /**
     * Optional events this game supports. Lifecycle events (ROUND_START, ROUND_END,
     * GAME_END) are always supported and are not listed.
     */
    allowedEventKinds: z.array(optionalEventKindSchema).min(1),
    /** Modifiers this game supports. Must match the events above. */
    allowedModifiers: z.array(gameModifierKindSchema),
    /** Actions players may report in this game. */
    allowedActionKinds: z.array(playerActionKindSchema).min(1),
    /** What happens when one player reports an action against another. */
    rules: z.array(gameRuleSchema),
    /** Powers a POWER_UP event can grant. Empty unless POWER_UP is allowed. */
    powers: z.array(gamePowerSchema),
    scoring: z.array(scoringRuleSchema),
    /** In priority order: later entries break ties left by earlier ones. */
    winConditions: z.array(winConditionSchema).min(1),
    /** Settings a new game of this definition starts with. */
    settings: gameSettingsSchema,
    /** Thematic directions for generated twists, e.g. "weather", "wildlife". */
    modifierThemes: z.array(z.string().min(1)).min(1),
    safety: gameSafetyProfileSchema,
    gameMaster: gameMasterGuidanceSchema,
  })
  .superRefine((definition, ctx) => {
    if (definition.maxPlayers < definition.minPlayers) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxPlayers'],
        message: 'maxPlayers must be greater than or equal to minPlayers',
      });
    }

    const roleIds = definition.roles.map((role) => role.id);
    if (new Set(roleIds).size !== roleIds.length) {
      ctx.addIssue({ code: 'custom', path: ['roles'], message: 'role ids must be unique' });
    }

    const defaults = definition.roles.filter((role) => role.isDefault);
    if (defaults.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles'],
        message: `exactly one role must set isDefault: true (found ${defaults.length})`,
      });
    }

    for (const [index, role] of definition.roles.entries()) {
      if (role.max !== undefined && role.max < role.min) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles', index, 'max'],
          message: `role "${role.id}" has max below min`,
        });
      }
    }

    // A game cannot start if its roles demand more bodies than minPlayers allows.
    const requiredBodies = definition.roles.reduce((sum, role) => sum + role.min, 0);
    if (requiredBodies > definition.minPlayers) {
      ctx.addIssue({
        code: 'custom',
        path: ['minPlayers'],
        message: `roles require at least ${requiredBodies} players but minPlayers is ${definition.minPlayers}`,
      });
    }

    const phaseIds = definition.phases.map((phase) => phase.id);
    if (new Set(phaseIds).size !== phaseIds.length) {
      ctx.addIssue({ code: 'custom', path: ['phases'], message: 'phase ids must be unique' });
    }

    const kinds = definition.allowedEventKinds;
    if (new Set(kinds).size !== kinds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedEventKinds'],
        message: 'allowedEventKinds must not contain duplicates',
      });
    }

    // A ROLE_CHANGE event is meaningless in a game with a single role.
    if (kinds.includes('ROLE_CHANGE') && definition.roles.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedEventKinds'],
        message: 'ROLE_CHANGE requires at least two roles',
      });
    }

    // Events and modifiers must agree in both directions.
    const modifiers = definition.allowedModifiers;
    if (new Set(modifiers).size !== modifiers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedModifiers'],
        message: 'allowedModifiers must not contain duplicates',
      });
    }
    for (const kind of kinds) {
      const introduced = MODIFIERS_BY_EVENT[kind];
      if (introduced.length > 0 && !introduced.some((modifier) => modifiers.includes(modifier))) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedModifiers'],
          message: `${kind} is allowed but none of its modifiers (${introduced.join(', ')}) is`,
        });
      }
    }
    for (const modifier of modifiers) {
      const supported = kinds.some((kind) => MODIFIERS_BY_EVENT[kind].includes(modifier));
      if (!supported) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedModifiers'],
          message: `${modifier} is allowed but no allowed event introduces it`,
        });
      }
    }

    const actions = definition.allowedActionKinds;
    if (new Set(actions).size !== actions.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedActionKinds'],
        message: 'allowedActionKinds must not contain duplicates',
      });
    }
    // An objective nobody can report as completed could never be scored.
    if (
      (kinds.includes('CHALLENGE') || kinds.includes('BONUS_OBJECTIVE')) &&
      !actions.includes('PLAYER_COMPLETED_CHALLENGE')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedActionKinds'],
        message: 'CHALLENGE and BONUS_OBJECTIVE require the PLAYER_COMPLETED_CHALLENGE action',
      });
    }

    // Powers exist exactly when POWER_UP does, and need an action to activate them.
    const powerIds = definition.powers.map((power) => power.id);
    if (new Set(powerIds).size !== powerIds.length) {
      ctx.addIssue({ code: 'custom', path: ['powers'], message: 'power ids must be unique' });
    }
    if (kinds.includes('POWER_UP') !== definition.powers.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['powers'],
        message: 'powers must be declared if and only if POWER_UP is allowed',
      });
    }
    if (kinds.includes('POWER_UP') && !actions.includes('PLAYER_ACTIVATED_POWER')) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedActionKinds'],
        message: 'POWER_UP requires the PLAYER_ACTIVATED_POWER action',
      });
    }

    const ruleIds = definition.rules.map((rule) => rule.id);
    if (new Set(ruleIds).size !== ruleIds.length) {
      ctx.addIssue({ code: 'custom', path: ['rules'], message: 'rule ids must be unique' });
    }
    for (const [index, rule] of definition.rules.entries()) {
      if (!actions.includes(rule.action)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'action'],
          message: `rule "${rule.id}" governs ${rule.action}, which is not an allowed action`,
        });
      }
      for (const field of ['actorRoleId', 'targetRoleId'] as const) {
        if (!roleIds.includes(rule[field])) {
          ctx.addIssue({
            code: 'custom',
            path: ['rules', index, field],
            message: `rule "${rule.id}" names unknown role "${rule[field]}"`,
          });
        }
      }
    }
    // A reportable action with no rule would have no defined outcome.
    for (const action of ['PLAYER_TAGGED', 'PLAYER_FOUND'] as const) {
      if (actions.includes(action) && !definition.rules.some((rule) => rule.action === action)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules'],
          message: `${action} is allowed but no rule says what it does`,
        });
      }
    }

    const triggers = definition.scoring.map((rule) => rule.trigger);
    if (new Set(triggers).size !== triggers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoring'],
        message: 'each scoring trigger may appear once',
      });
    }

    const winTypes = definition.winConditions.map((condition) => condition.type);
    if (new Set(winTypes).size !== winTypes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['winConditions'],
        message: 'each win condition may appear once',
      });
    }

    // The declared safety ceiling may not sit below the game intensity.
    if (INTENSITY_RANK[definition.safety.maxIntensity] < INTENSITY_RANK[definition.intensity]) {
      ctx.addIssue({
        code: 'custom',
        path: ['safety', 'maxIntensity'],
        message: 'safety.maxIntensity cannot be lower than the game intensity',
      });
    }
  });

export type GameDefinition = z.infer<typeof gameDefinitionSchema>;

/** Input form: `isDefault` is optional before parsing fills in its default. */
export type GameDefinitionInput = z.input<typeof gameDefinitionSchema>;

/**
 * Parses a definition at module load. Every bundled game goes through this, so a
 * malformed definition breaks the build and the test suite rather than a live
 * session.
 */
export function defineGame(input: GameDefinitionInput): GameDefinition {
  return gameDefinitionSchema.parse(input);
}

/** Orders two intensities. Exported for the safety layer, which caps proposals. */
export function intensityAtMost(candidate: Intensity, ceiling: Intensity): boolean {
  return INTENSITY_RANK[candidate] <= INTENSITY_RANK[ceiling];
}
