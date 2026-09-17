# @anastom/workspaces

Give each mutating run an owned Git topology, retain task edits as exact evidence, and integrate accepted work without mutating the operator's checkout.

## Public API

`resolveGitRepository` resolves the canonical source root and base commit. `GitWorkspaceManager.create` creates an isolated or readonly workspace. `capture` returns a binary-capable diff against the base. `captureWorkspaceCheckpoint` captures complete content and ownership twice; `compareWorkspaceCheckpoints` reports every recovery-relevant difference while ignoring only a later immutable diff-artifact reference. `cleanup` safely removes only an owned, clean, unchanged worktree.

`createFeatureWorkspaceTopology` creates one integration branch/worktree for a Feature run and retains its normalized protected paths. `loadFeatureWorkspaceTopology` revalidates that ownership in later processes. `createFeatureTaskWorkspace` creates each task worktree at the exact integration commit for its dependency wave. `captureScopedWorkspacePatch` retains exact binary-capable bytes while rejecting changes outside declared mutation scopes or inside protected inputs. `prepareWorkspaceIntegration` applies ordered accepted patches through a temporary Git index and writes a deterministic commit object without moving a ref. `reconcileWorkspaceIntegration` accepts only the recorded parent or result, moves the owned branch with compare-and-swap, and synchronizes only unchanged controller-owned content. `assertIntegrationPreparation` validates replayed preparation identity and digest.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api workspaces`; output is in `.generated/api/workspaces/` and is not committed.

## Boundaries and invariants

The source repository must be clean. Isolated and readonly selections receive ownership manifests under a fixed-segment private-state root. Feature topology gets its own immutable ownership record; workspace IDs, paths, branches, and bases are derived from validated run/task identities. Isolated run branches and all selected Git registrations must match. A readonly checkpoint requires the state root outside the repository so control-plane files cannot enter its ignored-content identity or worker input. Capture uses a temporary index so worker staging remains intact. Checkpoints reject unstable double captures, invalid UTF-8 names, binary diffs over 16 MiB, ignored trees over 4,096 entries or 64 MiB, unsupported ignored entry types, and changed Git ownership. Ignored ordinary files are streamed without following symlinks.

Task acceptance compares segment-aware repository paths and protects selected Feature, methodology, and verifier inputs. A schema-valid successful mutating role may produce an empty accepted patch; it retains the SHA-256 identity of zero bytes and can create a deterministic no-op integration commit. Integration accepts at most 64 MiB of exact patches, rejects overlapping same-wave scopes and patch conflicts, fixes commit identity/time/message, and persists the expected parent/tree/commit/digests before ref mutation. Recovery never resets worker worktrees or unrelated integration content. Cleanup refuses unowned paths, dirty files, and worker commits; workspaces are retained by default. Git isolation is not an operating-system security sandbox.

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

Single-worker Task execution and durable recovery are delivered. Run-scoped Feature topology, task worktrees, mutation-scope enforcement, protected inputs, accepted patch capture, and prepared deterministic Git integration compose with the concurrent durable graph coordinator and production Feature CLI. The deterministic matrix and unchanged Pi/Codex live Feature runs pass.

License: [AGPL-3.0-only](../../LICENSE).
