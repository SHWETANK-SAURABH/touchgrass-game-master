# TouchGrass Engineering Rules

- AI proposes; safety validates; the deterministic game engine executes.
- LLMs must never directly mutate game state.
- Game state transitions must be deterministic and testable.
- Player actions enter through the deterministic game engine.
- Use Zod at external/model boundaries.
- Keep model providers replaceable.
- Do not add infrastructure before its planned phase.
- Do not silently invent game mechanics.
- Prefer small, focused modules.
- Run `npm run verify` and `npm run build` after architectural changes.
- Do not proceed to the next phase without an explicit instruction.
