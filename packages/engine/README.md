# @anastom/engine

Own deterministic scheduling, typed event transitions, fresh attempt contexts, retry budgets, verification, and evidence recording. Runtime adapters execute requests; the engine decides what their results mean.

## Public API

`WorkflowEngine.createRun` preflights a selected worker's capabilities before persisting initial state; `tick` executes one ready attempt; `runToCompletion` advances sequentially. `inspect` and `events` read evidence without invoking workers. `RunPersistence`, `ArtifactStore`, and `CommandExecutor` remain the M1/M2 injectable boundaries. M3 adds the separate engine-owned `DurableRunStore` and `ExecutionHost` interfaces, stable `RunStoreError` codes, lease/process/snapshot/control records, exact execution-plan construction, snapshot construction, rolling event-history identity, and an `InMemoryDurableRunStore` reference implementation. `buildContext` takes named options and returns frozen context, canonical bytes, and digest. M3 event contracts add exact runtime configuration, prepared and authorized execution references, workspace checkpoints, control/cleanup observations, orphan evidence, typed pause reasons, and recovery-blocked state while preserving legacy lifecycle records. Renderers expose the recorded negotiation, public identity, partial usage, status, and evidence.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api engine`; output is in `.generated/api/engine/` and is not committed.

## Boundaries and invariants

The engine imports core, path-policy, and runtime contracts, not Pi or provider SDKs. Events are authoritative; snapshots are bounded, versioned caches that must equal their authoritative event prefix. Durable mutation retries validate an unexpired ownership fence before consulting their idempotency receipt. Takeover requires the exact expired lease and a same-clock absent-owner observation made no earlier than expiry. Worker runs record the accepted capability snapshot before attempts, then replay validated identity and one final usage observation from existing append-only events. New M3 histories separate durable preparation from start authorization and classify an unconfirmed execution as `recovery-blocked`; they do not infer absence from a lease or PID. Command and runtime attempts share the same owned-execution evidence. Legacy events replay with their original meaning. A sanitized typed policy rejection from an adapter's `start` is persisted as that attempt's failure and prevents retry. No telemetry decides node success. All outputs pass schema validation before node success. A timeout wins over a late success, and uncertain termination prevents unsafe retry. The local verifier uses argv without a shell, resolves an existing working directory inside its canonical workspace including safe internal symlinks, and excludes provider credentials.

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

Single-worker task execution is delivered. M3 descriptor, event/reducer, path/workspace, durable-store, and execution-host contracts are implemented, but the engine recovery coordinator and operator commands do not use them yet. Parallel graphs, approvals, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
