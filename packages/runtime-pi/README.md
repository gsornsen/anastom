# @anastom/runtime-pi

Adapt Pi's coding-agent SDK to explicit Anastom requests, using a fresh ephemeral session for every attempt. Provider authentication stays with the operator's normal Pi configuration.

## Public API

`PiRuntimeAdapter` accepts an optional explicit provider/model pair and an injectable session factory for tests. Its durable descriptor resolves Pi's effective ambient default to an explicit provider/model before persistence. `piRuntimeDescriptorCodec` validates the exact versioned configuration and reconstructs only that selection. `renderPiPrompt` expresses the explicit context and report contract. `PiSession` defines the small SDK facade used by deterministic lifecycle tests. Its capability snapshot declares filesystem modes, and completed assistant calls provide available attempt-scoped partial usage with provider/model provenance.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api runtime-pi`; output is in `.generated/api/runtime-pi/` and is not committed.

## Boundaries and invariants

The exact SDK version is pinned in package.json. Sessions use no inherited project extensions, skills, prompt templates, conversations, automatic retries, or compaction. Descriptor resolution starts no model request and persists no authentication or test factory. An injected session factory therefore requires an explicit provider/model before it can describe a durable runtime. Public event normalization excludes private reasoning and raw tool bodies. Positive provider usage is counted once per completed assistant call; missing or synthetic-zero counters remain unavailable. Bounded queues preserve lifecycle and final usage under log pressure. If a final response is schema-invalid, the adapter may issue one format-only correction in the same session and attempt; it forbids more repository work and a second invalid response fails normally. Mutation tools follow the request policy. Execution IDs use Node's cryptographic UUIDv4; they are not credentials.

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

Single-worker Task and concurrent `sdlc/default` Feature execution are delivered through the same one-attempt adapter boundary. The unchanged Pi live Feature passed analysis, planning, overlapping implementation, integration, independent review, and verification with durable evidence. Interactive approval gates and further runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
