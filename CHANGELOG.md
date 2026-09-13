# Changelog

All notable changes to Anastom will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases will use semantic versioning once the public API reaches its first tagged version.

## [Unreleased]

### Added

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

### Changed

- Reframed the README for external readers with Mycelium origins, project goals, current support, roadmap, and documentation links.
- Made README updates the default for every pull request, with documented reasons for exceptions.
- Enforced attempt deadlines in the control plane; late results cannot override timeout, and unconfirmed termination prevents retry.
