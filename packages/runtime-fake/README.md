# @anastom/runtime-fake

Provide deterministic scripted execution for tests, tutorials, and reproducible failures without provider credentials or model calls.

## Public API

`parseFakeScenario` validates YAML. `loadFakeScenario` also materializes file references. `FakeRuntimeAdapter` implements the runtime boundary by selecting a script for each node and attempt. Existing inline file text remains supported.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api runtime-fake`; output is in `.generated/api/runtime-fake/` and is not committed.

## Boundaries and invariants

File changes require an isolated workspace and explicit mutation authorization. A `fromFile` source resolves relative to the scenario directory through the shared existing-child policy. Relative traversal and symlink targets outside the canonical scenario directory are rejected; an internal symlink target is allowed. File references must be loaded before constructing executable scenarios. Requests, scripts, and collected results are defensively copied so callers cannot alter in-flight or terminal outcomes. Fake declares all three workspace modes for deterministic workflow execution and reports no provider token usage. Fake handles are process-local; no recovery is provided.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/runtime-fake
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution and durable recovery are delivered. Parallel production graphs, approvals, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
