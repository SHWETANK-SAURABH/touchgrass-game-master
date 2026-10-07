import { z } from 'zod';

/**
 * Game definitions are *data*, not code.
 *
 * A definition declares everything the rest of the system needs to know about a
 * game: how many bodies it needs, what roles exist, which phases it moves
 * through, which kinds of event the Game Master may propose, and which physical
 * risks are inherent to it. The engine reads it to validate commands, the safety
 * layer reads it to pick a policy, and the agent reads it to build a prompt.
 *
 * Because it is data, adding a sixth game is a pull request against one file —
 * which is exactly the contribution shape Hacktoberfest rewards.
 */

/**
 * The closed set of event kinds a Game Master may propose.
 *
 * This enum is the narrow waist of the whole product. The model cannot invent a
 * new kind of effect on the world; it can only fill in one of these shapes, and
 * each shape gets a deterministic handler in the engine. An unrecognised kind is
 * a validation failure, not a feature.
 */
export const GAME_EVENT_KINDS = [
  /** Narration or a briefing read aloud. Changes no rules. */
  'ANNOUNCE',
  /** A new objective players must complete, e.g. "find three different leaf shapes". */
  'OBJECTIVE',
  /** A rule twist applied to some or all players, e.g. "taggers may only side-step". */
  'MODIFIER',
  /** A spatial rule expressed in human landmarks, e.g. "the big oak is now safe". */
  'ZONE_RULE',
  /** Starts, extends or ends a countdown. */
  'TIMER',
  /** Awards or removes points. */
  'SCORE_ADJUST',
  /** Moves players between the roles the definition declares. */
  'ROLE_ASSIGN',
] as const;

export const gameEventKindSchema = z.enum(GAME_EVENT_KINDS);
export type GameEventKind = z.infer<typeof gameEventKindSchema>;

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

const INTENSITY_RANK: Record<Intensity, number> = { low: 1, moderate: 2, high: 3 };

export const gameDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'game ids are lower-kebab-case'),
    name: z.string().min(1),
    tagline: z.string().min(1).max(120),
    description: z.string().min(1),
    minPlayers: z.int().min(2),
    maxPlayers: z.int().min(2),
    recommendedDurationMinutes: z.int().positive(),
    spaceRequirement: spaceRequirementSchema,
    intensity: intensitySchema,
    /** Everyday items players need. Empty means "nothing but yourselves". */
    equipment: z.array(z.string().min(1)),
    roles: z.array(gameRoleSchema).min(1),
    phases: z.array(gamePhaseSchema).min(1),
    /** Subset of GAME_EVENT_KINDS the Game Master may propose in this game. */
    allowedEventKinds: z.array(gameEventKindSchema).min(1),
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

    // A ROLE_ASSIGN event is meaningless in a game with a single role.
    if (kinds.includes('ROLE_ASSIGN') && definition.roles.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedEventKinds'],
        message: 'ROLE_ASSIGN requires at least two roles',
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
