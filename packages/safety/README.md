# @touchgrass/safety

The hazard taxonomy, policy derivation, and the verdict contract. See
[SAFETY.md](../../SAFETY.md) for the full specification.

| Module          | Status          | Provides                                                            |
| --------------- | --------------- | ------------------------------------------------------------------- |
| `hazards.ts`    | **implemented** | 15 hazard categories with severity, rationale, and example signals  |
| `policy.ts`     | **implemented** | `policyFor(definition)` — derives a session's rules from its game   |
| `verdict.ts`    | **implemented** | `SafetyVerdict`, `SafetyViolation`, the `SafetyValidator` signature |
| matching engine | **Phase 2**     | The code that turns a proposal into a verdict                       |

## Why the taxonomy ships before the validator

Deciding _what_ counts as a hazard, how severe it is, and what evidence would show it, is the product
judgement. Writing matching rules against a fixed taxonomy afterwards is mechanical. The hard half is
here and under test.

## Invariants enforced in code

- `NON_NEGOTIABLE_HAZARDS` is **derived** from severity, not a second hand-maintained list — a test
  asserts the two agree.
- `safetyPolicySchema` **refuses** any policy that omits a critical hazard category.
- `maxRuleDurationSeconds` clamps downward only. A host can tighten a session, never loosen it.
- `supervisedByAdult` defaults to `false`, the stricter assumption.
- `SafetyDisposition` has no "unknown" member. Unclassifiable input is a reject.
- `SafetyValidator` is **not** `async`. A safety check that can await can hang, time out, and be
  skipped — and the signature also forbids asking a model whether its own output was safe.
