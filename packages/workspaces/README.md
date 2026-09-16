# @anastom/workspaces

Give each mutating run an owned isolated Git worktree and retain its edits and evidence for operator review.

## Public API

`resolveGitRepository` resolves the canonical source root and base commit. `GitWorkspaceManager.create` creates an isolated or readonly workspace. `capture` returns a binary-capable diff against the base. `captureWorkspaceCheckpoint` captures complete content and ownership twice; `compareWorkspaceCheckpoints` reports every recovery-relevant difference while ignoring only a later immutable diff-artifact reference. `cleanup` safely removes only an owned, clean, unchanged worktree.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api workspaces`; output is in `.generated/api/workspaces/` and is not committed.

## Boundaries and invariants

The source repository must be clean. Isolated and readonly selections receive ownership manifests under a fixed-segment private-state root. Isolated run branches and all selected Git registrations must match. A readonly checkpoint requires the state root outside the repository so control-plane files cannot enter its ignored-content identity or worker input. Capture uses a temporary index so worker staging remains intact. Checkpoints reject unstable double captures, invalid UTF-8 names, binary diffs over 16 MiB, ignored trees over 4,096 entries or 64 MiB, unsupported ignored entry types, and changed Git ownership. Ignored ordinary files are streamed without following symlinks. Cleanup refuses unowned paths, dirty files, and worker commits; workspaces are retained by default. Git isolation is not an operating-system security sandbox.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/workspaces
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
