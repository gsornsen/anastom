# @anastom/runtime-contract

Define the harness-independent interface between Anastom's control plane and execution runtimes. It contains types and stable failure categories, rather than an implementation of orchestration.

## Public API

`RuntimeAdapter` exposes `capabilities`, `start`, `events`, `collect`, and `cancel`. `DurableRuntimeAdapter` adds a bounded credential-free `descriptor`, and `RuntimeDescriptorCodec` parses exact adapter configuration before reconstructing a runtime. `ExecutionRequest`, `ExecutionResult`, `ContextEnvelope`, `WorkspaceRef`, `WorkspaceCheckpoint`, and `ArtifactRef` describe explicit execution and evidence boundaries. `assertExecutionRequest` and `assertExecutionResult` enforce exact process-boundary shapes plus 4 MiB request and 1 MiB result limits; `assertWorkspaceCheckpoint` validates the exact versioned workspace evidence shape and reviewed ignored-content bounds. `probeRuntime` checks a selected adapter before durable state exists; `RuntimeNegotiation` records the accepted workspace requirement and capability snapshot. Versioned schemas validate descriptor, checkpoint, capability, and public observation shapes.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api runtime-contract`; output is in `.generated/api/runtime-contract/` and is not committed.

## Boundaries and invariants

Capabilities describe observable support, including supported filesystem modes. Runtime descriptors are canonical JSON capped at 16 KiB; the shared envelope and adapter codec reject unknown fields, and descriptors exclude credentials, executable overrides, auth paths, environment, prompts, native sessions, and test factories. `RuntimeEvent` can report configured or native-reported provider/model identity and one partial or complete attempt-scoped token observation. Optional counters mean unavailable values stay absent rather than becoming invented zeroes; telemetry does not decide acceptance or price. Adapter handles convey identity, not authorization. Context contains explicit task, inputs, dependency outputs, policy, and required output schema; no ambient conversation is assumed. Durable process recovery belongs to the engine-owned execution host rather than runtime adapters.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/runtime-contract packages/runtime-fake packages/runtime-pi packages/runtime-codex
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
