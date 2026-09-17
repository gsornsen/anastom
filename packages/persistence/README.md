# @anastom/persistence

Persist immutable workflow definitions, ordered events, and filesystem evidence so status and inspection work across CLI processes.

## Public API

`SqliteDurableRunStore` provides atomic owned creation, 15-second leases, exact expired-owner takeover, monotonic fencing, idempotent event batches, actionable and deduplicated pause/cancel requests, rolling event integrity, and rebuildable snapshots. A newly submitted control is accepted only when it can change the state folded inside the same write transaction; a prior operation ID keeps its original idempotent receipt. The store expects the database parent to exist; production callers authorize and create that private state root through `@anastom/path-policy` before opening it. `FileArtifactStore` creates artifact parents through the fixed-segment private-state root, atomically publishes synced immutable evidence without replacement, and verifies content digests on bounded reads. Reads reject symlinked run-owned parents, nonordinary files, identity changes during access, and artifacts larger than 16 MiB.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api persistence`; output is in `.generated/api/persistence/` and is not committed.

## Boundaries and invariants

SQLite uses foreign keys, immediate write transactions, WAL, a five-second busy timeout, and append-only triggers. The store validates the current unexpired fence before idempotency lookup, assigns transaction timestamps internally, acknowledges a control only through its exact immutable observation event, and reports operational conflicts through stable `RunStoreError.code` values. Snapshot candidates are bounded disposable caches; invalid candidates fall back to authoritative full replay. Every owned event append extends a rolling digest in the same transaction. `migrations/` contains numbered SQL and a manifest; a checksummed journal plus `user_version` track applied steps. Failed upgrades roll back DDL and the journal. A nonempty database without migration history, drift, gaps, newer versions, invalid definitions, and corrupt authoritative evidence fail closed. Back up with SQLite's backup facilities before upgrades; automatic destructive downgrades are excluded.

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

The CLI composes this store for recoverable Pi, Codex, and Claude Code Task and Feature execution, including parallel expanded graphs and later-process terminal attachment. The process-local YAML workflow path does not use SQLite. Approvals and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
