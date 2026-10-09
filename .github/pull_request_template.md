## What this changes

<!-- One or two sentences. Link the issue if there is one: "Closes #123". -->

## Why

<!-- What problem does it solve, or what does it make possible? -->

## How it was tested

<!-- The commands you ran, and anything you tried by hand. -->

## Checklist

- [ ] `npm run verify` passes
- [ ] New behaviour has a test; a bug fix has a test that fails without the fix
- [ ] Documentation that describes this change is updated
- [ ] No secret, token or connection string is in the diff
- [ ] No existing test was weakened or deleted to make this pass

<!-- Only if this touches packages/ai, packages/safety, or how a Game Master event reaches a game: -->

- [ ] I have read [the safety contract](../CONTRIBUTING.md#the-safety-contract), and the model's
      output is still proposal-only and passes the existing schema, engine and safety checks
