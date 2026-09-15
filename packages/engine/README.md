# @anastom/engine

Own deterministic scheduling, typed event transitions, fresh attempt contexts, retry budgets, verification, and evidence recording. Runtime adapters execute requests; the engine decides what their results mean.

## Public API

`WorkflowEngine.createRun` preflights a selected worker's capabilities before persisting initial state; `tick` executes one ready attempt; `runToCompletion` advances sequentially. `inspect` and `events` read evidence without invoking workers. `RunPersistence`, `ArtifactStore`, and `CommandExecutor` are injectable boundaries. `buildContext` takes named options and returns frozen context, canonical bytes, and digest. Renderers expose the recorded negotiation, public identity, partial usage, status, and evidence.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api engine`; output is in `.generated/api/engine/` and is not committed.

## Boundaries and invariants

The engine imports core and runtime contracts, not Pi or provider SDKs. Events are authoritative; worker runs record the accepted capability snapshot before attempts, then replay validated identity and one final usage observation from existing append-only events. No telemetry decides node success. All outputs pass schema validation before node success. A timeout wins over a late success, and uncertain termination prevents unsafe retry. The local verifier uses argv without a shell and excludes provider credentials.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/engine
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
