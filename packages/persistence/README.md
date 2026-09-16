# @anastom/persistence

Persist immutable workflow definitions, ordered events, and filesystem evidence so status and inspection work across CLI processes.

## Public API

`SqliteRunPersistence` preserves the M1/M2 atomic-create and optimistic-append interface. `SqliteDurableRunStore` implements the separate M3 contract: atomic owned creation, 15-second leases, exact expired-owner takeover, monotonic fencing, idempotent event batches, deduplicated pause/cancel requests, rolling event integrity, and rebuildable snapshots. Both constructors validate and apply versioned migrations. `FileArtifactStore` creates artifact parents through the fixed-segment private-state root, atomically publishes synced immutable evidence without replacement, and verifies content digests on read, rejecting symlinked run-owned artifact parents and nonordinary artifact files.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api persistence`; output is in `.generated/api/persistence/` and is not committed.

## Boundaries and invariants

SQLite uses foreign keys, immediate write transactions, WAL, a five-second busy timeout, and append-only triggers. The M3 store validates the current unexpired fence before idempotency lookup, assigns transaction timestamps internally, acknowledges a control only through its exact immutable observation event, and reports operational conflicts through stable `RunStoreError.code` values. Snapshot candidates are bounded disposable caches; invalid candidates fall back to authoritative full replay. Legacy event bytes remain unchanged, and the first later M3 append extends a rolling digest calculated from those exact bytes. `migrations/` contains immutable numbered SQL and a manifest; a checksummed journal plus user_version track applied steps. Failed upgrades roll back DDL and the journal. The original unversioned store is adopted only when its full schema matches migration one. Drift, gaps, newer versions, invalid definitions, and corrupt authoritative evidence fail closed. Back up with SQLite's backup facilities before upgrades; automatic destructive downgrades are excluded.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/persistence
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. The M3 durable store and execution host are implemented and model-free tested, but the recovery coordinator and CLI do not compose them yet. Parallel graphs, approvals, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
