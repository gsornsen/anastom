# Changelog

All notable changes to Anastom will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every package uses SemVer with Changesets release plans and its own changelog. Initial private versions remain 0.0.0 until the first reviewed versioning step.

## [Unreleased]

### Added

- Add the seventh stacked M3 production slice: deterministic separate-process crash/restart acceptance for clean, dirty-workspace, and unknown-execution recovery; pre-expiry ownership refusal; stale-fence and duplicate-operation checks; snapshot-corruption fallback; artifact and source-worktree audits; and `docs/M3_EVIDENCE.md`.
- Add the sixth stacked M3 production slice: CLI composition for exact Pi, Codex, and Claude Code descriptors; an isolated runtime-host entry point; durable `pause`, `cancel`, and `resume`; operational status/inspection; stable exit behavior; and fail-closed corrupt-state handling.
- Add the fifth stacked M3 production slice: a vendor-neutral durable coordinator with five-second heartbeat, fenced two-phase start order, exact runtime/command ownership, control polling and restart continuation, orphan/workspace reconciliation, attempt-budget enforcement, snapshot boundaries, and typed ownership refusal.
- Add the fourth stacked M3 production slice: an engine-owned execution-host contract and shared POSIX supervisor with digest-bound private control records, explicit pre-launch readiness, bounded authenticated IPC, runtime/command isolation, parent-death cleanup, fail-closed loss inspection, and model-free coverage for all four current execution owners.
- Add the third stacked M3 production slice: an engine-owned durable-store contract and matching in-memory/SQLite implementations with leases, monotonic fences, idempotent batches, controls, rolling integrity, rebuildable snapshots, stable errors, and a complete initial schema.
- Add the second stacked M3 production slice: a fixed-segment private-state root, exact workspace-checkpoint validation, double-captured Git/content/ownership evidence, bounded streamed ignored-content hashing, and focused workspace/artifact path migrations.
- Begin the stacked M3 production implementation with bounded credential-free runtime descriptors and exact Pi, Codex, and Claude Code reconstruction codecs. Add prepare/authorize, control, cleanup, orphan, typed pause, and recovery-blocked event/reducer contracts for runtime and command attempts while retaining process-local workflow event behavior.
- Propose the exact M3 production contract after all five feasibility phases: package ownership, sanitized runtime descriptors, two-stage execution references, engine-owned durable-store and execution-host interfaces, typed recovery events, rolling event integrity, bounded supervisor records, and a private-state-root path capability. ADR 0018 keeps the proposal review-gated before implementation.
- Add a model-free M3 snapshot probe with a checked-in folded-state schema, exact workflow/event-prefix/state digest binding, snapshot-plus-tail equality across reopened lifecycle histories, newest-compatible selection, corrupt-snapshot fallback, and rejection of corrupt authoritative events. The matrix passes on Linux and macOS; exact persistence APIs remain for separate review.
- Add a model-free M3 exact-workspace checkpoint probe covering committed, tracked, staged, untracked, binary, symlink, ignored-file/directory, `HEAD`, and canonical ownership changes while preserving the user's staging index. The matrix passes on Linux and macOS; exact public M3 APIs remain unfrozen.
- Add a model-free multi-process M3 SQLite contention probe for `BEGIN IMMEDIATE` lease acquisition, renewal, absent-owner takeover, release, monotonically increasing fences, idempotent mutation receipts, contiguous event batches, and deduplicated control requests. It passes on Linux and macOS; the temporary schema keeps production persistence APIs and migrations unfrozen.
- Add a production-shaped M3 attempt-supervisor protocol probe with engine-shaped execution IDs, private random capabilities, two-phase start authorization, a persisted conservative `starting` boundary, exact bounded local IPC, public result relay, confirmed cancellation and parent-death cleanup across all four current execution owners, and fail-closed `unknown` evidence after supervisor loss. The probe passes on Linux and macOS; public runtime APIs remain gated on separate contract review.
- Add a model-free M3 process-ownership probe across Pi, Codex, Claude Code, and command execution. It reproduces surviving descendants after coordinator death, disproves direct leader PID as a complete recovery identity, and establishes a shared parent-death supervisor as the cross-platform candidate. Fixed-name, atomically published fixture records keep readiness portable under concurrent CI filesystems.
- Owner-accepted M3 durable-execution contract with single-host fenced ownership, idempotent transitions, rebuildable snapshots, sanitized runtime reconstruction, orphan and workspace reconciliation, and explicit pause/cancel/resume semantics. Exact APIs remain gated on the completed feasibility findings and separate contract review.
- Complete a source-level Claude Code CLI worker with explicit subscription/API-key selection, signed-release native-byte attestation, model-free authentication and managed-policy preflight, bounded JSONL/public evidence, structured reports, and confirmed POSIX process cleanup. The owner accepted the subscription-backed unchanged M2 Task, independent verifier, and 9/9 durable artifact checks.
- Add later-process historical M1/M2 store replay evidence and a proposed third-adapter path-policy decision before extracting a shared resolver.
- Add a narrow canonical-root existing-child resolver for Fake scenario references, verifier working directories, and scoped CLI source/schema reads. The CLI now requires authored source files inside its current directory; its SemVer plan records this selection change as breaking.
- Reject symlinked run-owned artifact parents on later-process evidence reads.
- Make Codex process cleanup deterministic across Linux and macOS by excluding zombie-only groups and using a bounded reap window.
- Owner-accepted M2.5 Claude Code worker ADR and build brief, with an exact-version native loopback probe and official-interface/authentication audit. This was design evidence before the adapter implementation.
- Completed M2 portable-worker support with selected-runtime capability negotiation, normalized identity/usage events, an exact-pinned Codex CLI process adapter, shared conformance doubles, and accepted fail-closed managed-policy preflight in ADR 0014. The owner-authenticated paired Pi/Codex endpoint demonstration and Linux/macOS/CodeQL CI passed.
- Accumulated-context Codex regression fixture and accepted owned-catalog compaction control in ADR 0013; accepted ADR 0012 status and the owner-selected Terra/medium live configuration are recorded.

- Reproducible offline Codex CLI feasibility probe and proposed profile refinement covering ambient discovery exclusion, original file-authentication ownership, bounded OpenAI transport, and native cache-write placeholders.
- M1 retrospective and proposed M2 portable-worker build contract covering Codex integration, selected-runtime capability preflight, shared conformance, token observations, feasibility gates, and completion evidence.
- Prettier formatting and editor defaults, public API JSDoc enforcement with required descriptions across functions, classes, and types, readability/complexity limits, package documentation, optional TypeDoc generation, and contributor hygiene checks.
- Changesets release planning for all eight private packages, with CI validation and a reviewed manual versioning process.
- Versioned SQLite migrations with checksummed history, schema validation, atomic failure rollback, and rejection of unjournaled existing schemas.
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

### Fixed

- Reject inherited object keys during event replay, fail runtime/event schema validation on the first error, route execution-host fixture records through the shared private-path capability, and make the SQLite busy-error test independent of the production five-second contention wait.

### Changed

- Make package source, comments, JSDoc, identifiers, fixtures, and test names independent of project milestone labels; enforce the rule in `pnpm hygiene`. Remove the superseded fake Markdown Task path, `SqliteRunPersistence`, historical-resume variants, and compatibility-only tests before the first supported release; consolidate the durable store as the initial migration.
- Accepted the M2 Codex CLI design; tracked blocked SDK reconsideration and added M2.5 Claude Code support after M2, with subscription authentication to be investigated during design.
- Replaced milestone-based executable fixture and CI names with capability names, and removed duplicated durable demo coverage from CI.
- Refactored inspection, engine execution, and event transitions into readable stages and rewrote durable CLI tests around contributor-facing behavior.
- Moved authored and normalized workflow/task/scenario schemas into versioned assets; worker reports require at least 30 non-whitespace summary characters.

- Reframed the README for external readers with Mycelium origins, project goals, current support, roadmap, and documentation links.
- Made README updates the default for every pull request, with documented reasons for exceptions.
- Enforced attempt deadlines in the control plane; late results cannot override timeout, and unconfirmed termination prevents retry.
- Hardened task front-matter parsing with a line scanner and resolved explicit task filenames consistently with workflow loading.
