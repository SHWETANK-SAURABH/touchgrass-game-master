import type { OptionalEventKind } from '@touchgrass/game-definitions';
import type { GameMasterView } from './context';

/**
 * The Game Master's instructions.
 *
 * The prompt is guidance. It is not a safety control and not a rule engine: a
 * model can ignore any sentence here. What it returns is checked by schema, and
 * later by the safety validator and the game engine, which are the authorities.
 */
export const GAME_MASTER_SYSTEM_PROMPT = `You are the Game Master for TouchGrass, a referee for real outdoor games.

The physical world is the actual game. Players are outside, moving, often out of breath. The screen is only the referee and the interface; nothing you say happens on a screen.

Your job is to decide whether the game needs a dynamic event right now, and if so to propose exactly one.

What you do:
- You propose an event. You do not execute it.
- A deterministic game engine and a safety validator decide whether your proposal is used. They are authoritative; you are not.
- If the game is going well, or you are unsure, propose nothing. Proposing nothing is a good answer.

Hard limits:
- Only propose an event kind listed under "allowed.eventKinds" for this game. Never invent an event kind.
- Never try to set or change scores, roles as the result of a tag, timers, rounds, or any other state directly. You cannot start or end a round or the game, put a player out, award points, or say that a player tagged or found someone.
- Only refer to players, roles, powers and modifiers that appear in the supplied game data, by their exact ids.
- Stay within the supplied limits for durations, points and time extensions.
- Do not invent mechanics that the supplied game definition does not have.

How to choose:
- Prefer simple, safe, playable events that a group can understand when it is read aloud once.
- Never propose anything that requires a dangerous activity, and respect the "avoid" list for this game.
- Describe places only in words the players could resolve themselves. You have no map and cannot see the area.
- Keep any text you write short and concrete.

Reply with JSON only: an object with "rationale" (one short sentence explaining your decision) and "event" (one event object, or null to propose nothing).`;

/** A message handed to the agent. The system prompt is the agent's own instructions. */
export type GameMasterMessage =
  { role: 'user'; content: string } | { role: 'assistant'; content: string };

/** How to fill in each event kind. Shown only for the kinds a game allows. */
const EVENT_FIELD_NOTES: Record<OptionalEventKind, string> = {
  ZONE_CHANGE:
    '{"type":"ZONE_CHANGE","modifier":"SAFE_ZONE" or "MOVING_ZONE","zone":"a place in words","durationSeconds":number} — announces a zone. The modifier must be one the game allows.',
  CHALLENGE:
    '{"type":"CHALLENGE","challengeId":"short-unique-id","description":"what to do","playerIds":["player id", ...],"points":number,"durationSeconds":number} — a challenge for the named players.',
  POWER_UP:
    '{"type":"POWER_UP","playerId":"player id","powerId":"a power id from allowed.powers"} — gives a player a power to hold.',
  RULE_MODIFIER:
    '{"type":"RULE_MODIFIER","modifier":"FREEZE_PERIOD","roleIds":["role id", ...],"durationSeconds":number} — announces a freeze period for the named roles.',
  BONUS_OBJECTIVE:
    '{"type":"BONUS_OBJECTIVE","objectiveId":"short-unique-id","description":"what to do","points":number,"durationSeconds":number} — an objective open to every player.',
  TIME_EXTENSION: '{"type":"TIME_EXTENSION","seconds":number} — adds time to the running round.',
  ROLE_CHANGE:
    '{"type":"ROLE_CHANGE","assignments":[{"playerId":"player id","roleId":"role id"}, ...]} — moves players between roles. The result must respect each role\'s min and max.',
};

/** The user message: the current game, as data, and the shapes the reply may take. */
export function buildGameMasterMessages(view: GameMasterView): GameMasterMessage[] {
  const shapes = view.allowed.eventKinds
    .map((kind) => `- ${EVENT_FIELD_NOTES[kind as OptionalEventKind]}`)
    .join('\n');

  return [
    {
      role: 'user',
      content: [
        `Current game: ${view.game.name}.`,
        '',
        'Game data (read-only):',
        JSON.stringify(view, null, 2),
        '',
        'Event shapes you may use for this game:',
        shapes,
        '',
        'Decide whether an event is appropriate now. Reply with JSON only.',
      ].join('\n'),
    },
  ];
}

/** Sent after an invalid reply: what was wrong, and the reply itself. */
export function buildRepairMessages(issues: readonly string[], raw: string): GameMasterMessage[] {
  return [
    { role: 'assistant', content: raw },
    {
      role: 'user',
      content: [
        'Your previous reply was not a valid proposal.',
        '',
        'Problems:',
        ...issues.map((issue) => `- ${issue}`),
        '',
        'Reply again with corrected JSON only. Do not explain. Do not add fields.',
      ].join('\n'),
    },
  ];
}
