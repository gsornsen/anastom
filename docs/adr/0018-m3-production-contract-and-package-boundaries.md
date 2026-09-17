# 0018 — M3 production contract and package boundaries

- Status: Accepted and implemented on the consolidated PR #24 candidate; complete-branch owner acceptance required before merge
- Date: 2026-09-16

## Context

[ADR 0017](0017-durable-execution-ownership-and-recovery.md) accepted M3's safety semantics while deliberately leaving exact TypeScript and storage shapes open. Five model-free feasibility phases then established shared parent-death supervision, two-phase worker authorization, fail-closed supervisor loss, fenced SQLite mutations, exact workspace checkpoints, and snapshot integrity on Linux and macOS.

Those probes also showed why copying their temporary types directly would be unsafe. Adapter-level recovery would duplicate OS ownership across vendors. A lease generation cannot prove a process tree absent. One generic path resolver would mix authored paths, private operational state, installed executables, and authentication stores. A snapshot prefix digest without transactionally maintained event integrity would still require hashing the entire prefix.

## Decision

Use [the M3 production contract](../M3_PRODUCTION_CONTRACT.md) as the implementation baseline while the owner reviews the completed stack before final acceptance and merge.

The proposal makes the following package decisions:

- remove the unused optional `RuntimeAdapter.recover()` contract;
- keep vendor adapters responsible for exact sanitized descriptor codecs and one attempt;
- add `@anastom/execution-host` for shared POSIX supervision and bounded authenticated IPC;
- keep execution-host and durable-store interfaces in `@anastom/engine`, with infrastructure packages implementing them;
- extend `@anastom/persistence` through additive tables for leases, mutation receipts, controls, rolling event integrity, and snapshots;
- keep portable checkpoint evidence shapes beside existing workspace records in `@anastom/runtime-contract`, while moving the proven capture/comparison algorithm into `@anastom/workspaces`;
- add a private-state-root capability to `@anastom/path-policy` while retaining the existing authored-child resolver; and
- keep `@anastom/cli` as the runtime registry and process composition root.

Before the first supported release, use the complete durable store as migration one and remove the superseded `SqliteRunPersistence` and fake Task execution paths. No external users or retained user databases exist, so preserving those transitional paths would create a compatibility promise without a beneficiary. Deterministic fake YAML workflows keep their process-local engine path. A durable run always has a runtime descriptor, ownership record, execution evidence when active, and rolling integrity from its first event; missing records are corruption rather than a historical format.

The exact public records, event transitions, transaction order, limits, compatibility behavior, CLI syntax, and implementation slices are defined in the proposal. No production API or migration changes in this ADR.

The path supplied to `ensurePrivatePathRoot()` is an explicitly caller-authorized local root, rather than an untrusted child path beneath some other universal root. The function canonicalizes the existing parent, fixes the leaf, rejects symlinks and non-directories, enforces current-user ownership and private permissions, verifies the canonical result, and returns a capability whose descendants use validated fixed segments. Automated or remote callers must authorize the root before invoking this boundary. CodeQL alert 41 was individually dismissed as a false positive with this rationale; the path-injection query remains enabled.

## Consequences

M3 recovery will have one OS ownership boundary across all current workers and commands. The engine can remain independent from SQLite and vendor runtimes. Durable mutations will carry explicit lease fences and operation IDs. Development databases created by superseded pre-release implementations are not supported inputs; recreate them from the current initial schema.

The new execution-host package and breaking pre-1.0 runtime/store changes require package documentation, Changesets, generated API review, and model-free cross-platform conformance. Private operational paths gain one shared implementation without turning unrelated path trust domains into a single permissive resolver.

## Rejected shapes

### Add `inspectExecution()` to every adapter

All current owners need the same process-tree and coordinator-death semantics. Vendor-specific inspection would duplicate the hardest invariant and still leave command execution separate.

### Put SQLite and supervisor details in the engine

That would make policy depend on infrastructure and make deterministic in-memory testing less representative. Engine-owned interfaces preserve dependency direction.

### Persist one giant resumable-run JSON record

Leases, immutable transitions, idempotency receipts, control requests, snapshots, and private execution authority have different mutation and trust rules. Combining them would weaken transaction checks and public inspection boundaries.

### Generalize all path handling behind one resolver

Existing authored children may follow safe internal symlinks. Private run state rejects symlinked parents and uses fixed segment names. Installed tools and authentication stores use provenance rules. One resolver cannot express those distinctions without unsafe option combinations.

### Treat lease expiry as worker absence

Fencing protects SQLite history only. It cannot stop a surviving agent or command from changing files or causing external effects.

## Review triggers

Revise the production contract and the accepted M3 build brief before implementation if cross-platform production tests cannot preserve two-phase start authorization, if Pi cannot resolve its effective model without a provider call, if private socket placement cannot satisfy the 100-byte bound, if transactionally maintained event integrity cannot bind every durable event, or if the event transitions cannot represent unknown cleanup without permitting another worker.
