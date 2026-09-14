# @anastom/runtime-pi

Adapt Pi's coding-agent SDK to explicit Anastom requests, using a fresh ephemeral session for every attempt. Provider authentication stays with the operator's normal Pi configuration.

## Public API

`PiRuntimeAdapter` accepts an optional explicit provider/model pair and an injectable session factory for tests. `renderPiPrompt` expresses the explicit context and report contract. `PiSession` defines the small SDK facade used by deterministic lifecycle tests.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api runtime-pi`; output is in `.generated/api/runtime-pi/` and is not committed.

## Boundaries and invariants

The exact SDK version is pinned in package.json. Sessions use no inherited project extensions, skills, prompt templates, conversations, automatic retries, or compaction. Public event normalization excludes private reasoning and raw tool bodies. Mutation tools follow the request policy. Execution IDs use Node's cryptographic UUIDv4; they are not credentials.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/runtime-pi
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
