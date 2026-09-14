# Changelog

All notable changes to Anastom will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every package uses SemVer with Changesets release plans and its own changelog. Initial private versions remain 0.0.0 until the first reviewed versioning step.

## [Unreleased]

### Added

- Reproducible offline Codex CLI feasibility probe and proposed profile refinement covering ambient discovery exclusion, original file-authentication ownership, bounded OpenAI transport, and native cache-write placeholders.
- M1 retrospective and proposed M2 portable-worker build contract covering Codex integration, selected-runtime capability preflight, shared conformance, token observations, feasibility gates, and completion evidence.
- Prettier formatting and editor defaults, public API JSDoc enforcement with required descriptions across functions, classes, and types, readability/complexity limits, package documentation, optional TypeDoc generation, and contributor hygiene checks.
- Changesets release planning for all eight private packages, with CI validation and a reviewed manual versioning process.
- Versioned SQLite migrations with checksummed history, schema validation, atomic failure rollback, and safe adoption of existing unversioned stores.
- Confined file references for fake workspace changes and tests for unsafe pointers, schema summaries, migration failures, and hygiene gate failures.

- M0 TypeScript workspace with a validated Workflow IR.
- Event-sourced fake execution engine and in-memory persistence.
- Scriptable fake runtime and CLI validation, graph, run, and inspect commands.
- Deterministic acceptance coverage for M0 behavior.
- Accepted M1 single-worker build contract and eight foundational architecture decision records.
- M1 strict Markdown task compiler and versioned worker-report/command-result schemas.
- Exact-pinned Pi SDK adapter with fresh ephemeral sessions, public tool event mapping, structured reports, cancellation, and disposal.
- Owned isolated Git worktrees with source-checkout isolation, binary diff capture, retained worker commits, and explicit safe cleanup.
- SQLite immutable run definitions, transactional append-only events, optimistic conflicts, and validated replay.
- Canonical context and filesystem artifacts with SHA-256 identities, plus durable CLI `status` and `inspect --json`.
- Independent verification commands with duration limits, bounded stdout/stderr, and evidence on failure.
- Controlled HTTP fixture, explicit fake file-change scenarios, M1 boundary tests, and a demo guide.
- Successful live Pi/Anthropic `claude-opus-4-8` fixture demonstration with independent acceptance and recorded sanitized evidence.

### Changed

- Accepted the M2 Codex CLI design; tracked blocked SDK reconsideration and added M2.5 Claude Code support after M2, with subscription authentication to be investigated during design.
- Replaced milestone-based executable fixture and CI names with capability names, and removed duplicated durable demo coverage from CI.
- Refactored inspection, engine execution, and event transitions into readable stages and rewrote durable CLI tests around contributor-facing behavior.
- Moved authored and normalized workflow/task/scenario schemas into versioned assets; worker reports require at least 30 non-whitespace summary characters.

- Reframed the README for external readers with Mycelium origins, project goals, current support, roadmap, and documentation links.
- Made README updates the default for every pull request, with documented reasons for exceptions.
- Enforced attempt deadlines in the control plane; late results cannot override timeout, and unconfirmed termination prevents retry.
- Hardened task front-matter parsing with a line scanner and resolved explicit task filenames consistently with workflow loading.
