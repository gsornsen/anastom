# 0017 — Durable execution ownership and recovery

- Status: Accepted by the owner on 2026-09-16 in [PR #23](https://github.com/gsornsen/anastom/pull/23); exact runtime ownership APIs remain gated on feasibility evidence
- Date: 2026-09-15

## Context

Anastom already persists the immutable workflow definition, context and result artifacts, and every accepted transition. That makes a completed run inspectable from another process, but it does not make an interrupted run safe to continue.

The engine currently records `AttemptScheduled` and `AttemptStarted` before calling a worker. If the coordinator exits during that worker, replay reconstructs a running attempt with no process-local handle. `runToCompletion()` then has no ready node to schedule. The persistence boundary has optimistic sequence checks but no exclusive run owner or fencing token, and the CLI does not retain enough sanitized adapter configuration to recreate the selected runtime.

The optional `RuntimeAdapter.recover()` shape does not solve this problem. No shipped adapter proves that a provider session can be adopted after a coordinator crash. A retained Git worktree also may contain partial unaccepted edits. Starting another worker without reconciling both the old execution and its workspace could create concurrent mutation or duplicate external effects.

M3 needs a local durability contract that is stronger than replay and narrower than a distributed scheduler.

## Decision

### Recover workflow control, not provider sessions

M3 recovery creates a new coordinator and, when safe, a newly numbered attempt with a fresh context. It does not promise to reconnect to an interrupted model conversation or continue under the same attempt identity.

The existing optional `recover()` contract will be removed during M3 unless feasibility evidence establishes a concrete adopter with semantics stronger than session convenience. Runtime-specific session reattachment can return through a later reviewed capability. M3 instead needs an execution-ownership operation that can answer whether a previously recorded execution is active, absent, or unknown and can confirm termination when it is active. Exact method names remain gated on the process-ownership feasibility probe in the [M3 build brief](../M3_BUILD_BRIEF.md).

An engine-generated execution ID is recorded before an adapter may cause model, command, or tool side effects. Adapter-owned process metadata may live in a run-owned operational record keyed by that ID, but credentials, private messages, reasoning, and tool bodies may not enter that record.

### Use a local lease and a fencing generation

One process owns a runnable run at a time. The SQLite store maintains a mutable operational lease containing:

- the run ID;
- an opaque owner ID;
- an opaque local host/boot identity;
- the local process ID and a process-start identity used to detect PID reuse;
- a monotonically increasing fencing generation;
- acquisition, heartbeat, and expiry times.

Lease acquisition, renewal, release, and fenced event append use `BEGIN IMMEDIATE` transactions. Every execution-state mutation carries the current generation. Once a later generation is acquired, the store rejects writes from every earlier generation even if the former process resumes.

Expiry alone does not prove that the old coordinator stopped. Automatic takeover requires both an expired lease and proof that the recorded local process identity is absent. If process liveness cannot be established, Anastom reports an ownership conflict and starts no worker. A future force-takeover operation may stop or quarantine work, but it must never imply that concurrent external effects are safe.

M3 is single-host. A state directory whose prior owner belongs to another or unidentifiable host is inspectable but not automatically resumable.

### Separate workflow history from operational coordination

Immutable events remain the authority for workflow state. M3 may add four SQLite concerns with deliberately different roles:

| Record           | Role                                                                | Authority                                                                  |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| events           | Ordered workflow transitions and accepted evidence                  | Authoritative                                                              |
| run leases       | Current local owner, heartbeat, expiry, and fencing generation      | Mutable operational coordination                                           |
| mutation keys    | Unique mutation ID, payload digest, and committed event range       | Immutable idempotency index; events remain the semantic result             |
| control requests | Deduplicated pause/cancel requests submitted by another CLI process | Operational input until the owner records the corresponding event          |
| snapshots        | Versioned, checksummed folded state at a known event sequence       | Rebuildable cache; deletion or rejection must not change the replay result |

A fenced append uses a caller-retained mutation ID. Repeating that ID with the same payload returns the original committed range. Reusing it with another payload is a conflict. This closes the "commit succeeded but the caller did not observe the return" gap without making claims about exactly-once provider or tool effects.

Control requests need no run lease because their purpose is to ask the current owner to act. The owner polls or is notified, records the request in the event stream under its fence, and performs cleanup. After a crash, a replacement owner processes any pending request before scheduling work.

### Treat snapshots as verified caches

Snapshots contain a reducer/schema version, run ID, event sequence, canonical state bytes, and digest. They are written transactionally at reviewed stable boundaries such as attempt completion, pause/cancel completion, and run completion. High-volume runtime observations do not each require a snapshot.

Execution may load the newest compatible snapshot and replay its tail. Full-history inspection remains available. A malformed, unknown-version, or digest-mismatched snapshot is ignored and rebuilt from events; it may not hide a corrupt event stream. Tests must compare snapshot-plus-tail state with full replay for every lifecycle shape introduced by M3.

This is an integrity and consistency boundary for Anastom-managed storage, not a defense against an administrator deliberately rewriting the database and disabling its constraints.

### Reconcile the execution before the workspace

After safe lease takeover, the new owner reconciles the current attempt in this order:

1. Establish the old execution as absent, or terminate it and confirm absence.
2. Capture the current owned workspace and preserve any partial diff as evidence.
3. Record the old running attempt and its post-crash workspace observation as orphaned exactly once.
4. Compare that observation with the immutable pre-attempt workspace checkpoint.
5. Start a new attempt only when the workspace matches and the attempt budget allows it.

The pre-attempt checkpoint covers the exact head commit, binary-capable diff digest, and changed-file set. It therefore works after earlier accepted nodes have changed the run worktree; it is not merely a comparison with the original base commit.

If the workspace differs, ordinary `resume` pauses with a typed workspace-conflict reason. It does not reset, clean, apply, or accept partial edits. An operator may inspect and manually restore the owned worktree to the recorded checkpoint, then retry resume. A future reviewed command may create a fresh worktree from a checkpoint, but implicit destructive recovery is outside M3.

An orphaned attempt consumes its attempt number and counts against `maxAttempts`. A crash may already have incurred provider usage or external effects, so the control plane cannot grant an unrecorded free retry. The deterministic M3 recovery fixture uses a budget of at least two. If no attempt remains, resume pauses with typed budget evidence.

### Persist only a sanitized runtime descriptor

`anastom resume <run>` must not depend on the original Task file or the operator remembering launch flags. The run records a versioned descriptor sufficient for the CLI's adapter registry to reconstruct the same public selection. The descriptor includes only reviewed fields such as adapter ID, provider/model selection, reasoning setting, and authentication-source choice.

Each adapter owns validation and reconstruction of its descriptor. The engine stores it without interpreting vendor-specific fields. Credentials, access tokens, API keys, auth-file contents, custom instructions, environment snapshots, and private runtime payloads are forbidden. Preflight runs again after reconstruction because installed binaries, policy, authentication availability, and capabilities may have changed.

Runs created before this descriptor exists remain inspectable. Automatic resume rejects them with a typed compatibility reason rather than guessing configuration from partial identity observations.

### Make pause and cancel durable operations

The CLI gains explicit `pause`, `cancel`, and `resume` operations for durable Task runs. Each operation has an ID that is printed and may be supplied again when retrying an uncertain invocation.

- Pause is reversible. With no active attempt, the owner records the paused state at the scheduling boundary. With active work, it records intent, requests termination once, confirms cleanup, cancels that attempt, and then records the node and run as paused.
- Cancel is terminal. It follows the same cleanup rule, cancels remaining work, and records terminal run cancellation only after active execution is confirmed absent.
- Resume acquires ownership, finishes any pending control request, reconciles an orphan if one exists, records resumption, and schedules only safe ready work.

If termination cannot be confirmed, the operation remains visibly pending or pauses with a typed recovery-unsafe reason. Anastom does not announce a completed pause/cancel while a known worker may still mutate its workspace.

Repeated operation IDs return their recorded outcome. A different operation ID against an already achieved state is a semantic no-op and does not append a contradictory second terminal transition.

## Consequences

- Crash recovery stays in the control plane and does not depend on one provider's session model.
- Fencing protects durable state, while process reconciliation and workspace checkpoints protect side-effect boundaries.
- Users may need to inspect an ambiguous execution or partial worktree before progress continues. That refusal is part of the safety contract.
- Snapshot code can improve replay cost without creating a second source of workflow truth.
- The persistence and runtime contracts will receive breaking pre-1.0 changes with explicit Changesets, package documentation, and compatibility tests.
- Process identity and descendant cleanup must work on the supported Linux and macOS CI hosts before the public API is finalized.

## Alternatives rejected for M3

### Adopt every provider session

Provider and harness sessions do not share a proven ownership, authentication, or replay contract. Reattachment remains an optional later optimization after safe workflow restart exists.

### Retry whenever the lease expires

A stalled former owner or surviving descendant could still be running. Fencing prevents its database writes but cannot undo filesystem, network, or provider effects. M3 requires local-owner absence and execution reconciliation.

### Reset dirty worktrees automatically

Partial edits are evidence and may include useful or externally authored work. Ordinary resume preserves them and pauses.

### Give orphan retries a free budget exemption

The coordinator cannot prove that an interrupted attempt consumed no provider or external resources. Orphans remain visible, numbered attempts.

### Store runtime credentials with the run

Durability does not justify credential intermediation. Existing tool-owned authentication stores remain the only credential source.

### Add distributed scheduling now

Remote ownership, consensus clocks, queues, and cross-host process control would expand M3 beyond its local demonstration and obscure the single-host invariants that need proof first.

## Review triggers

Revisit this decision if feasibility cannot establish safe local process identity, an adapter cannot expose a durable execution identity before side effects, exact workspace comparison is insufficient on supported Git repositories, or snapshot loading cannot fail back to full replay without changing observable state.

## Feasibility refinement — process ownership

The first [M3 feasibility probe](../M3_FEASIBILITY.md) on 2026-09-16 found that Pi, Codex, Claude Code, and command descendants can all survive coordinator `SIGKILL`; current product handles are not durable. It also disproved direct-leader PID as a complete boundary by retaining a descendant after its verified group leader exited. The former identity could no longer authorize group signalling safely.

A shared parent-death supervisor prototype observed the coordinator identity, terminated a TERM-resistant worker group and descendant, confirmed absence, and exited. The probe passed on Ubuntu 24.04 and macOS 15 CI in PR #24. Its `ps` start time is low-resolution on macOS, so it is not production authority by itself. M3 will evaluate this shared supervisor with a two-phase persisted start handshake, supervisor-issued random execution capability, and same-host/boot binding before defining adapter-specific recovery operations. Pi requires an out-of-process attempt host for equivalent descendant ownership. Durable manifests, fenced start authorization, framed runtime IPC, production-protocol Linux/macOS coverage, and supervisor-failure cases remain gates; this refinement does not yet approve a public API.

## Feasibility refinement — supervisor protocol

The second [M3 feasibility probe](../M3_FEASIBILITY.md) implements the candidate as a temporary production-shaped protocol without exporting it from a package. An engine-shaped execution UUID and fence enter an atomic attempt plan before the supervisor starts. The supervisor authenticates the live coordinator and boot, creates a random 256-bit capability, opens a user-only Unix socket, and publishes an atomic sanitized manifest plus a separate private control record. The coordinator validates that handshake and records start authority before the authenticated `authorize` request may create an execution side effect.

One bounded length-prefixed request and response cross each half-closed socket connection. Exact schemas reject unknown fields; public events are validated and capped. Connection lifetime is bounded, and shutdown destroys every accepted socket so an idle client cannot delay cleanup. The random capability itself remains out of the sanitized manifest and terminal evidence. A later process treats malformed or mismatched persisted control data as `unknown`. A matching terminal record with confirmed cleanup proves absence only after the supervisor is also absent.

On the owner macOS host, model-free Pi, Codex, Claude Code, and command executions all relayed success, rejected wrong capability/fence/oversized input, confirmed explicit cancellation, and cleaned their observed processes after coordinator death. Deliberately killing the supervisor left its active command group alive; inspection returned `unknown` and replacement remained forbidden. Fixture-only out-of-band cleanup removed that group. A gated start case exposed the launch-publication ambiguity: the supervisor now persists `starting` before the first possible worker side effect, and loss in that state is always unknown even when this particular fixture had not yet launched. Only `awaiting-start` proves that launch was never authorized. Linux and clean macOS CI remain required before recording the protocol as cross-platform evidence.

This result supports one shared supervisor/runtime-host lifecycle instead of adapter-specific recovery methods. It does not approve the temporary TypeScript names as public API. Stronger production process identity, final state-directory placement and socket path limits, bounded record loading, SQLite fencing integration, workspace checkpoints, and snapshot evidence remain gates.
