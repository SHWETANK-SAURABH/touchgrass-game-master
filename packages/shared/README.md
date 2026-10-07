# @touchgrass/shared

Primitives every other package depends on. Nothing game-specific lives here.

| Module           | Provides                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| `result.ts`      | `Result<T, E>` — expected failures as values, not exceptions           |
| `determinism.ts` | `Clock`, seeded `Rng` (mulberry32), `shuffle`, `seedFromString`        |
| `ids.ts`         | Session/player/event ids, and join codes with ambiguous glyphs removed |
| `env.ts`         | The Zod environment schema — the only module that reads `process.env`  |
| `errors.ts`      | `TouchGrassError` base with stable machine-readable codes              |
| `logger.ts`      | Dependency-free JSON line logger with child bindings                   |

## Two decisions worth knowing

**Non-determinism is injected, never ambient.** `Clock` and `Rng` exist so the game engine can be a
pure function. Reading `Date.now()` or `Math.random()` inside engine code would silently break session
replay, so both arrive as explicit capabilities.

**Join codes exclude `0`, `O`, `1`, `I` and `L`.** A code is shouted across a field, not scanned. A
misheard code should be a code that does not exist, rather than one that joins the wrong session.
