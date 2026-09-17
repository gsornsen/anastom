# @anastom/core

Parse authored workflows and Markdown tasks into strict, replayable definitions. This package owns the Workflow IR, local JSON Schemas, canonical JSON, and content digests.

## Public API

`loadWorkflow` and `loadTask` load files selected by a trusted local caller. `loadWorkflowWithinRoot(root, file)` and `loadTaskWithinRoot(root, file)` additionally confine an operator-selected source to an authorized directory; the scoped workflow loader confines referenced schemas to that same source tree. `parseWorkflowYaml` and `parseTaskMarkdown` validate authored text, with `TaskDocument` describing the latter's result. `normalizeWorkflow` and `compileTask` resolve execution policy. `workerReportSchema` exposes the built-in Task worker report contract, and `assertWorkflowDefinition` validates stored snapshots. `canonicalJson`, `digestBytes`, and `digestJson` provide deterministic evidence identity.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api core`; output is in `.generated/api/core/` and is not committed.

## Boundaries and invariants

Core imports no engine, runtime, storage, model, or harness implementation. The [path-policy operation](../path-policy/README.md) resolves existing children of a caller-authorized canonical source root, rejecting lexical and symlink escape. Direct local loaders retain trusted-caller semantics; remote hosts must authorize filenames and use the scoped APIs when arguments can select paths. Schema loading is local and injectable. Versioned assets in `schemas/` are part of the contract; stored snapshots retain their original embedded schemas.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/core
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
