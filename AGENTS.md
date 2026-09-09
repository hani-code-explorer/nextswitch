# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project Overview

Nextswitch is a VoIP SWITCH for Call Centers, built as a Rust workspace with multiple crates covering SIP signaling, RTP media handling, an API layer, and a web UI.

## Build & Test Commands

- **Format**: `cargo fmt --all`
- **Lint**: `cargo clippy --workspace -- -D warnings` (must pass clean before committing)
- **Test**: `cargo nextest run` (use `cargo nextest run -p <crate>` for a single crate)
- **Build**: `cargo build --workspace`

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, etc. Scope with the crate name when changes are crate-specific (e.g., `feat(sip): implement SIP proxy core`).

**Spec-driven atomic commits**: All code changes for a single spec/design MUST be committed together as one atomic unit after implementation is complete and verified. Do NOT commit incremental changes during implementation.

Workflow:
1. Design spec → commit spec document only (`docs: add <topic> design spec`)
2. Implement all changes (no commits during implementation)
3. Verify all CI gates pass
4. Commit all implementation changes together (`feat(<scope>): implement <topic>`)
5. Create PR for review

Exception: Documentation-only changes (specs, README, AGENTS.md) may be committed separately.

## Code Style

- Default `rustfmt` — run `cargo fmt` before committing.
- Clippy warnings are errors (`-D warnings`). Fix or `#[allow]` with justification.

## Workspace Layout

This is a Cargo workspace. When adding a new crate, register it in the root `Cargo.toml` `[workspace.members]`. Prefer adding shared logic to a common/internal crate rather than duplicating across crates.

## Before Marking Done

Run `cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo nextest run` — or use `/verify`.
