---
name: verify
description: Run format check, clippy lint, and full test suite to verify changes before committing. Use after making code changes or when asked to verify the build.
---

Run the following checks in order. Stop at the first failure and report the error.

1. **Format check**: `cargo fmt --check --all`
   - If this fails, run `cargo fmt --all` to fix formatting, then re-check.

2. **Clippy lint**: `cargo clippy --workspace --all-targets -- -D warnings`
   - Report any warnings or errors. Do not auto-fix clippy suggestions — report them for the user to decide.

3. **Tests**: `cargo nextest run --workspace`
   - Report pass/fail counts. If tests fail, show the failing test names and output.

If all three pass, report: "All checks passed: format, clippy, and tests."

For a single crate, accept an optional crate name argument and scope the commands:
- `cargo fmt --check -p $ARGUMENTS`
- `cargo clippy -p $ARGUMENTS --all-targets -- -D warnings`
- `cargo nextest run -p $ARGUMENTS`
