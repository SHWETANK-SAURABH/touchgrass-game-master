# @touchgrass/game-definitions

Game rules as **data**, not code. Five games: `tag`, `hide-and-seek`, `ice-and-fire`,
`treasure-hunt`, `nature-challenge`.

Each definition declares everything the rest of the system needs:

- headcount (Tag is 2–4; a solo game may declare a minimum of 1), duration, space requirement,
  intensity, equipment
- roles with minimums, maximums, and exactly one overflow role
- named phases in order
- `allowedEventKinds`, `allowedModifiers`, `allowedActionKinds` — what the engine accepts for this
  game. The three lifecycle events are always supported and are not listed.
- `rules` — for a tag or a find: which role may do it to which role, and the outcome
- `powers`, `scoring`, `winConditions`, `settings` — data the engine interprets

Tag and Hide & Seek carry complete, approved rules. Ice & Fire, Treasure Hunt and Nature Challenge
have only the fields the schema requires: no rules and no scoring.

- a `safety` profile: contact policy, intensity ceiling, separation, daylight, inherent risks
- a `gameMaster` block: persona, `encourage`, `avoid`, and hand-written `exampleTwists`

## Adding a game

```ts
import { defineGame } from '../schema';

export const captureTheFlag = defineGame({/* … */});
```

`defineGame` parses at module load, so a malformed definition breaks the build and the test suite
rather than a live session. Register it in `registry.ts` and it appears in the UI automatically.

The schema enforces real invariants, not just types: exactly one default role, roles that cannot
demand more players than `minPlayers` allows, no `ROLE_CHANGE` in a single-role game, events and
modifiers that agree with each other, a rule for every reportable action, a safety ceiling that
cannot sit below the game's own intensity, and a non-empty prohibition list.

The shared vocabularies (event kinds, modifier kinds, player action kinds) are in `vocabulary.ts`.
How the engine uses all of this is described in
[GAME_ENGINE.md](../game-engine/GAME_ENGINE.md).

## Why the Game Master's voice lives here

A new game should ship its own persona and its own list of things never to suggest, without touching
agent code. Keeping guidance beside the rules is what makes a sixth game a one-file pull request.
