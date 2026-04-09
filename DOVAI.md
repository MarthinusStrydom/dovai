# DOVAI.md

This file provides guidance to Dovai (dovai.ai) when working with code in this repository.

## Detected stack
- Languages: Rust.
- Frameworks: none detected from the supported starter markers.

## Verification
- Run Rust verification from `rust/`: `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`

## Repository shape
- `rust/` contains the Rust workspace and active CLI/runtime implementation.
- `rust/crates/dovai-cli/` is the main CLI binary (`dovai`).
- `rust/crates/runtime/` is the conversation engine.
- `rust/crates/tools/` contains built-in tool implementations.
- `rust/crates/api/` contains LLM provider clients.

## Working agreement
- Prefer small, reviewable changes and keep generated bootstrap files aligned with actual repo workflows.
- Keep shared defaults in `.dovai.json`; reserve `.dovai/settings.local.json` for machine-local overrides.
- Do not overwrite existing `DOVAI.md` content automatically; update it intentionally when repo workflows change.
