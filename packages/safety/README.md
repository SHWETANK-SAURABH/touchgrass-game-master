# @touchgrass/safety

The hazard taxonomy, policy derivation, the verdict contract, and the deterministic safety
validator. See [SAFETY.md](../../SAFETY.md) for the design and for what the validator cannot do.

| Module         | Provides                                                                           |
| -------------- | ---------------------------------------------------------------------------------- |
| `hazards.ts`   | 18 hazard categories with severity, rationale, and example signals                 |
| `policy.ts`    | `policyFor(definition)` — derives a session's rules from its game                  |
| `verdict.ts`   | `SafetyVerdict`, `SafetyViolation`, the `SafetyValidator` signature                |
| `text.ts`      | Normalises free text; says when text cannot be read                                |
| `rules.ts`     | `LEXICAL_RULES` — small named word rules, one hazard category each                 |
| `assess.ts`    | `assessEventSafety(event, policy)` — the pure assessment, returns a verdict        |
| `clearance.ts` | `validateSafety`, `SafetyClearedEvent`, `releaseClearedEvent` — the trust boundary |

```ts
const cleared = validateSafety(validated, state); // validated: the engine's ValidatedGameEvent
if (!cleared.ok) {
  // { kind: 'UNSAFE', verdict } or { kind: 'NOT_EVALUATED', reason }
}
```

Domain-valid does not mean safe. The input is an event the engine has already found legal; this
package answers a different question, and only an event that passes both is applied.

## Invariants enforced in code

- No model, clock, network or random source is used. The same event and policy always give an
  identical verdict, which carries no timing.
- The validator decides and returns a value. It applies nothing and changes neither the state, the
  definition nor the event. It imports one engine function: the check that a value is a genuine
  `ValidatedGameEvent`.
- A `SafetyClearedEvent` can only be obtained from `validateSafety`. A copy, a look-alike or one
  rebuilt from JSON is refused by `releaseClearedEvent`.
- Only `allow` clears an event. `revise` and `reject` are both refusals; nothing rewrites an event.
- Text that cannot be read, and instructions that leave the risky choice open, are violations.
  `SafetyDisposition` has no "unknown" member.
- A model's rationale is never read.
- The policy is derived from the registered game definition. A caller can pass options that make it
  stricter, never a policy or a definition.
- `NON_NEGOTIABLE_HAZARDS` is **derived** from severity, and `safetyPolicySchema` refuses any policy
  that omits a critical hazard category.
- `maxRuleDurationSeconds` clamps downward only. `supervisedByAdult` defaults to `false`.
- `SafetyValidator` is **not** `async`.

## Limits

`allow` means no rule matched. The rules are a word list and a few numeric limits: they cannot see
the place a game is played, they can be evaded by wording they do not list, and they refuse some
safe instructions that mention a hazard. The engine does not depend on this package, so a caller that
uses the engine directly is not checked.
