# @touchgrass/game-definitions

Game rules as **data**, not code. Five games: `tag`, `hide-and-seek`, `ice-and-fire`,
`treasure-hunt`, `nature-challenge`.

Each definition declares everything the rest of the system needs:

- headcount, duration, space requirement, intensity, equipment
- roles with minimums, maximums, and exactly one overflow role
- named phases in order
- `allowedEventKinds` — the subset of the seven event kinds the Game Master may propose here
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
demand more players than `minPlayers` allows, no `ROLE_ASSIGN` in a single-role game, a safety ceiling
that cannot sit below the game's own intensity, and a non-empty prohibition list.

## Why the Game Master's voice lives here

A new game should ship its own persona and its own list of things never to suggest, without touching
agent code. Keeping guidance beside the rules is what makes a sixth game a one-file pull request.
