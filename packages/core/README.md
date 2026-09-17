# @anastom/core

Parse authored workflows, Markdown tasks, and bounded Feature contracts into strict, replayable definitions. This package owns the Workflow IR, defined-SDLC input and expansion contracts, local JSON Schemas, canonical JSON, and content digests.

## Public API

`loadWorkflow` and `loadTask` load files selected by a trusted local caller. `loadWorkflowWithinRoot(root, file)` and `loadTaskWithinRoot(root, file)` additionally confine an operator-selected source to an authorized directory; the scoped workflow loader confines referenced schemas to that same source tree. `parseWorkflowYaml` and `parseTaskMarkdown` validate authored text, with `TaskDocument` describing the latter's result. `normalizeWorkflow` and `compileTask` resolve execution policy. `workerReportSchema` exposes the built-in Task worker report contract, and `assertWorkflowDefinition` validates stored snapshots.

`loadFeatureWithinRoot` and `parseFeatureMarkdown` validate operator-owned objectives, acceptance criteria, planner/concurrency limits, attempt policy, and shell-free verifier commands. `loadSdlcMethodology` confines and snapshots the six checked-in role prompts and JSON Schemas. `normalizeFeaturePlan` accepts bounded planner data, derives stable dependency waves, and rejects cycles, unsafe scopes, and same-wave overlap. `expandSdlcPlan` produces the content-addressed task, integration, independent-review, and verifier graph; `assertSdlcGraphExpansion` protects replay. `parseReviewReport` enforces consistent approval and blocking-finding semantics. `canonicalJson`, `digestBytes`, and `digestJson` provide deterministic evidence identity.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api core`; output is in `.generated/api/core/` and is not committed.

## Boundaries and invariants

Core imports no engine, runtime, storage, model, or harness implementation. The [path-policy operation](../path-policy/README.md) resolves existing children of a caller-authorized canonical source root, rejecting lexical and symlink escape. Direct Workflow and Task loaders retain trusted-caller semantics; remote hosts must authorize filenames and use the scoped APIs when arguments can select paths. Feature input is source-scoped. Methodology manifests use fixed names, bounded UTF-8 reads, portable internal references, compiled local schemas, and content digests that remain stable when the package moves. Versioned assets in `schemas/` are part of the contract; stored snapshots retain their original embedded schemas.

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

Single-worker task execution and durable recovery are delivered. The defined-SDLC Feature, methodology, plan, review, and deterministic expansion contracts are available for the production coordinator work now underway. Parallel production execution and integration remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
