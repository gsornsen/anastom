# @anastom/persistence

Persist immutable workflow definitions, ordered events, and filesystem evidence so status and inspection work across CLI processes.

## Public API

`SqliteRunPersistence` implements atomic create, optimistic append, validated load, and close. Its constructor validates and applies versioned migrations. `FileArtifactStore` writes immutable evidence and verifies content digests on read.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api persistence`; output is in `.generated/api/persistence/` and is not committed.

## Boundaries and invariants

SQLite uses foreign keys, immediate transactions, and append-only triggers. `migrations/` contains immutable numbered SQL and a manifest; a checksummed journal plus user_version track applied steps. Failed upgrades roll back DDL and the journal. The original unversioned store is adopted only when its full schema matches migration one. Drift, gaps, newer versions, invalid definitions, and corrupt evidence fail closed. Back up with SQLite's backup facilities before upgrades; automatic destructive downgrades are excluded.

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

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
