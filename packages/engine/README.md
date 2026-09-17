# @anastom/engine

Own deterministic scheduling, typed event transitions, fresh attempt contexts, retry budgets, verification, and evidence recording. Runtime adapters execute requests; the engine decides what their results mean.

## Public API

`WorkflowEngine.createRun` preflights a selected worker's capabilities before persisting initial state; `tick` executes one ready attempt; `runToCompletion` advances sequentially. `inspect` and `events` read evidence without invoking workers. These APIs support process-local deterministic workflow execution through the injectable `RunPersistence`, `ArtifactStore`, and `CommandExecutor` boundaries. `InvalidTransitionError` identifies contradictory event history, and `PersistenceConflictError` identifies duplicate creation or stale append expectations.

Recoverable Task execution uses the engine-owned `DurableRunStore` and `ExecutionHost` interfaces, stable `RunStoreError` codes, lease/process/snapshot/control records, exact execution-plan construction, rolling event-history identity, and the `InMemoryDurableRunStore` reference implementation. `DurableRunCoordinator` composes those boundaries with a runtime registry, workspace checkpoint service, artifact store, and process observer. It creates and releases owned runs, renews leases, persists preparation before host creation and start authority before launch, polls controls, reconciles orphaned attempts, compares complete workspace evidence, applies retry budgets, and refuses unsafe ownership. Durable event contracts record runtime configuration, prepared and authorized execution references, workspace checkpoints, control and cleanup observations, orphan evidence, typed pause reasons, and recovery-blocked state. Renderers expose recorded negotiation, public identity, partial usage, status, and evidence.

The same coordinator folds a validated `WorkflowExpanded` event into its executable graph and supervises up to the persisted parallel limit. Each active attempt retains separate ownership and cleanup evidence while one owned session serializes event commits. Generated implementation work uses assigned task workspaces and accepted patch artifacts. Controller integration records the exact parent/tree/result before compare-and-swap, reconciles interrupted commits, and schedules fresh read-only reviewers plus ordered operator verifiers only after committed integration.

Concurrent terminal handling settles the whole run only after every active sibling reaches a recorded cleanup result. An exhausted failed attempt fails its node even when the worker changed its workspace. A retryable failed attempt with workspace differences pauses the node and cancels active siblings before the run becomes paused, preserving those edits for inspection without starting a replacement.

`projectEvidenceLedger` reconstructs phase decisions, runtime/model identity, exact context and report references, workspace/diff evidence, usage, integration commits, and dependency evidence from the immutable workflow plus authoritative events. `LiveRunProjector` derives the presentation-safe stream used by terminal clients. It caps each message at 2 KiB and each attempt at 128 messages or 64 KiB, reports omitted messages, and produces the same observations when durable history is replayed after reconnect. `resolveRunWorkflowGraph` exposes the exact static-or-expanded topology to read-only clients so they do not duplicate expansion rules. Prompts, structured output bodies, private reasoning, tool bodies, credentials, and raw provider errors have no live-event representation. Commit observers run only after persistence and cannot affect workflow decisions.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api engine`; output is in `.generated/api/engine/` and is not committed.

## Boundaries and invariants

The engine imports core, path-policy, and runtime contracts, not Pi, SQLite, concrete workspaces, or provider SDKs. Events are authoritative; snapshots are bounded, versioned caches that must equal their authoritative event prefix. Durable mutation retries validate an unexpired ownership fence before consulting their idempotency receipt. New controls must be actionable against the event-derived state in the store's write transaction, while retries of an accepted operation return its original receipt. Takeover requires the exact expired lease and a same-clock absent-owner observation made no earlier than expiry. Worker runs record the accepted capability snapshot before attempts, then replay validated identity and one final usage observation from append-only events. Durable histories separate preparation from start authorization and classify an unconfirmed owned execution as `recovery-blocked`; they do not infer absence from a lease or PID. An acknowledged pause or cancel remains authoritative across coordinator restart and is completed before a later resume operation can schedule work. Command and runtime attempts share the same owned-execution evidence. A sanitized typed policy rejection from an adapter's `start` is persisted as that attempt's failure and prevents retry. No telemetry decides node success. All outputs pass schema validation before node success. A timeout wins over a late success, and uncertain termination prevents unsafe retry. The local verifier uses argv without a shell, resolves an existing working directory inside its canonical workspace including safe internal symlinks, and excludes provider credentials.

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

Single-worker Task execution and `sdlc/default` Feature execution use the durable coordinator through the CLI, including pause, cancel, resume, crash recovery, concurrent attempts, recoverable Git integration, live public observations, evidence-ledger inspection, and operational inspection. The defined-SDLC deterministic matrix and unchanged Pi/Codex live demonstrations pass. Deterministic YAML workflows continue through `WorkflowEngine`.

License: [AGPL-3.0-only](../../LICENSE).
