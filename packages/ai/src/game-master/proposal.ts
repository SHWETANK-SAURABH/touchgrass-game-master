import { z } from 'zod';
import { err, ok, type Result } from '@touchgrass/shared';
import {
  OPTIONAL_EVENT_KINDS,
  type GameDefinition,
  type OptionalEventKind,
} from '@touchgrass/game-definitions';
import { EXTERNAL_EVENT_SCHEMAS, externalGameEventSchema } from '@touchgrass/game-engine';

/**
 * What the Game Master returns: a proposal, never a change.
 *
 *   { rationale, event }      event is one external game event, or null
 *
 * `event` reuses the engine's own schemas for events that may come from outside
 * it. There is no second event model here. Lifecycle events (ROUND_START,
 * ROUND_END, GAME_END) and the events the engine derives from player actions
 * (PLAYER_OUT, POWER_ACTIVATED, OBJECTIVE_COMPLETED) have no external schema, and
 * the external ROLE_CHANGE has no `cause` field, so none of them can be expressed
 * in a proposal at all.
 *
 * `event: null` means the Game Master judged that nothing should happen now.
 *
 * A proposal is not applied by anything in this package. Whether it is safe, and
 * whether it is legal in the game right now, are decided elsewhere.
 */

/** Why the Game Master proposes this, or why it proposes nothing. Kept for audit. */
const rationale = z.string().trim().min(8).max(300);

export const gameMasterProposalSchema = z
  .object({
    rationale,
    event: externalGameEventSchema.nullable(),
  })
  .strict();
export type GameMasterProposal = z.infer<typeof gameMasterProposalSchema>;

/**
 * The output schema given to the model for one game: the proposal shape with
 * `event` narrowed to the kinds that game supports. The runtime constrains
 * decoding to it, so an unsupported kind cannot be generated in the first place.
 */
export function proposalOutputSchemaFor(
  definition: Pick<GameDefinition, 'allowedEventKinds'>,
): z.ZodType<GameMasterProposal> {
  const [first, ...rest] = definition.allowedEventKinds.map(
    (kind): z.ZodType => EXTERNAL_EVENT_SCHEMAS[kind],
  );
  if (!first) throw new Error('A game definition must allow at least one event kind.');
  const second = rest[0];
  const event = second ? z.union([first, second, ...rest.slice(1)]) : first;
  return z.object({ rationale, event: event.nullable() }).strict() as z.ZodType<GameMasterProposal>;
}

function isOptionalKind(value: unknown): value is OptionalEventKind {
  return typeof value === 'string' && (OPTIONAL_EVENT_KINDS as readonly string[]).includes(value);
}

function issuesOf(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path].filter((part) => part !== '').join('.');
    return `${path === '' ? '(root)' : path}: ${issue.message}`;
  });
}

/**
 * Validates untrusted model output as a proposal for a particular game.
 *
 * The event is checked against the schema of its own kind rather than against a
 * union, so a failure names the field ("event.durationSeconds: Too big") instead
 * of reporting an unmatched union. Those messages are what the repair prompt
 * sends back to the model.
 */
export function parseGameMasterProposal(
  value: unknown,
  definition: Pick<GameDefinition, 'name' | 'allowedEventKinds'>,
): Result<GameMasterProposal, string[]> {
  const wrapper = z.object({ rationale, event: z.unknown() }).strict().safeParse(value);
  if (!wrapper.success) return err(issuesOf(wrapper.error));

  const candidate = wrapper.data.event;
  if (candidate === null) return ok({ rationale: wrapper.data.rationale, event: null });
  if (candidate === undefined) return err(['event: required; use null to propose nothing']);

  const kind = typeof candidate === 'object' ? (candidate as { type?: unknown }).type : undefined;
  if (!isOptionalKind(kind) || !definition.allowedEventKinds.includes(kind)) {
    return err([
      `event.type: must be one of ${definition.allowedEventKinds.join(', ')} for ${definition.name}`,
    ]);
  }

  const event = EXTERNAL_EVENT_SCHEMAS[kind].safeParse(candidate);
  if (!event.success) return err(issuesOf(event.error, 'event'));
  return ok({ rationale: wrapper.data.rationale, event: event.data });
}
