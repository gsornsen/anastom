# M3 production contract proposal

## Status and review boundary

This is the exact production-contract proposal requested after the five M3 feasibility phases. It is **proposed, not implemented or accepted**. [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md) and the [M3 build brief](M3_BUILD_BRIEF.md) remain the accepted safety boundary. If review accepts this proposal, implementation must preserve these names, ownership boundaries, state transitions, and compatibility rules unless new evidence first amends the proposal and the build brief.

The proposal covers local Linux and macOS Task runs. It does not add provider-session adoption, remote workers, parallel scheduling, force takeover, automatic worktree repair, or exactly-once external effects.

## Ambiguities resolved before implementation

The feasibility work exposed several places where the earlier design could have produced a narrow or unsafe API. This proposal resolves them as follows.

1. **Recovery is not an adapter method.** The unused `RuntimeAdapter.recover()` hook and its two recovery types are removed. A shared execution host owns process identity, launch authorization, inspection, and termination for Pi, Codex, Claude Code, and commands.
2. **A lease fence is not execution authority.** A later database generation can reject stale writes, but it cannot prove that an earlier process tree stopped. The engine requires a separate `active | absent | unknown` execution observation before replacement.
3. **Preparation and authorization are separate durable transitions.** An execution ID and workspace checkpoint are committed before a supervisor is prepared. A sanitized supervisor reference is then committed before the supervisor may launch a worker.
4. **Runtime reconstruction and execution ownership are separate contracts.** Adapters own exact, Allow Listed descriptor schemas. The execution host treats the descriptor and request as opaque validated launch input and never stores credentials.
5. **Mutable coordination is not folded into `RunState`.** Leases and pending control requests are operational records. Status combines them with the event-derived projection in a separate inspection view.
6. **An unknown execution is not called paused or absent.** It produces a typed `recovery-blocked` run state. Retry remains possible, but no replacement worker starts until later evidence establishes absence.
7. **Workspace equality covers every execution owner.** Agent and command attempts use the same pre-attempt checkpoint because verification commands can also mutate or leave descendants.
8. **Snapshots do not introduce a second history.** New events receive transactionally maintained rolling integrity digests. Legacy prefixes without contiguous integrity coverage continue to be hashed from their stored bytes.
9. **Path policy remains split by trust domain.** The existing authored-child resolver stays narrow. A new private-state-root capability handles run-owned directories, records, and socket paths; it is not a universal `resolvePath()` helper.
10. **Bounded reads apply before parsing.** Every operational record and IPC frame is size-checked as bytes, then decoded, exact-schema validated, and identity checked.

## Package ownership

The accepted dependency direction remains control-plane first:

```text
core <- runtime-contract <- engine <- persistence
                   ^          ^            ^
                   |          |            |
            runtime adapters  +---- execution-host

path-policy <- core, engine, persistence, workspaces, execution-host
cli -> engine, persistence, workspaces, execution-host, runtime adapters
```

| Package                     | M3 responsibility                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anastom/core`             | Existing workflow and canonical JSON primitives. It gains no M3 process or database concepts.                                                                                                              |
| `@anastom/runtime-contract` | Runtime descriptors, the existing one-attempt adapter interface, public observations, and normalized results. It removes adapter-level recovery.                                                           |
| `@anastom/engine`           | M3 events, reducer state, lease/store interfaces, execution-host interface, control/recovery policy, and typed errors. It imports no SQLite or vendor runtime.                                             |
| `@anastom/persistence`      | SQLite migrations and the `DurableRunStore` implementation, including leases, fencing, idempotency, controls, rolling event integrity, and snapshots.                                                      |
| `@anastom/execution-host`   | New shared POSIX supervisor implementation, process observation, private control records, bounded framed IPC, and the engine-owned `ExecutionHost` implementation. It imports no concrete runtime adapter. |
| `@anastom/workspaces`       | Exact checkpoint capture/comparison and ownership validation. It does not decide whether recovery may proceed.                                                                                             |
| `@anastom/path-policy`      | Existing authored-child resolution plus the distinct private-state-root capability described below.                                                                                                        |
| `@anastom/cli`              | Composition root, descriptor registry, hidden runtime-host entry point, commands, status rendering, and exit behavior.                                                                                     |
| Runtime packages            | Exact descriptor codecs, current preflight, and one-attempt `RuntimeAdapter` implementations. They do not inspect durable processes or SQLite.                                                             |

`@anastom/engine` owns interfaces implemented by persistence and execution-host, matching the current `RunPersistence` pattern and avoiding a dependency from policy to infrastructure.

## Versioned public records

All records reject unknown fields. Identifiers use the existing safe identifier grammar unless a field is explicitly a UUID. Digests use `sha256:<64 lowercase hexadecimal characters>`. Byte limits are measured before UTF-8 decoding.

### Runtime descriptors

The shared envelope is:

```ts
export interface RuntimeDescriptor {
  version: "anastom.dev/runtime-descriptor/v1alpha1";
  runtimeId: string;
  configurationVersion: string;
  configuration: Readonly<Record<string, JsonValue>>;
}

export interface DurableRuntimeAdapter extends RuntimeAdapter {
  descriptor(): Promise<RuntimeDescriptor>;
}

export interface RuntimeDescriptorCodec<T extends RuntimeDescriptor = RuntimeDescriptor> {
  readonly runtimeId: T["runtimeId"];
  parse(value: unknown): T;
  create(descriptor: T): Promise<RuntimeAdapter>;
}
```

The descriptor is at most 16 KiB as canonical UTF-8 JSON. Runtime and provider IDs are 1–128 characters; model IDs are 1–256 characters. The generic validator checks the envelope and bound. The selected adapter codec then checks the exact configuration version and fields before a lease is acquired.

The initial exact adapter configurations are:

```ts
type PiDescriptor = RuntimeDescriptor & {
  runtimeId: "pi";
  configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1";
  configuration: { provider: string; model: string };
};

type CodexDescriptor = RuntimeDescriptor & {
  runtimeId: "codex";
  configurationVersion: "anastom.dev/runtime-codex-config/v1alpha1";
  configuration: {
    provider: "openai";
    model: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    authSource: "file-store";
  };
};

type ClaudeCodeDescriptor = RuntimeDescriptor & {
  runtimeId: "claude-code";
  configurationVersion: "anastom.dev/runtime-claude-code-config/v1alpha1";
  configuration: {
    provider: "anthropic";
    model: string;
    authSource: "subscription" | "api-key";
  };
};
```

Pi resolves an ambient default to an explicit provider and model before returning its descriptor. Resume never reuses a later ambient default. Test factories, executable overrides, authentication directories, environment variables, prompts, access tokens, API keys, auth-file paths or contents, custom instructions, and native session IDs are not descriptor fields. Fake file scenarios remain process-local; the deterministic M3 acceptance runtime uses a checked-in internal fixture codec rather than a user-resumable Fake descriptor.

### Local owner and lease records

```ts
export interface LocalProcessIdentity {
  version: "anastom.dev/local-process/v1alpha1";
  hostIdentityDigest: string;
  bootIdentityDigest: string;
  pid: number;
  startToken: string;
}

export interface RunLease {
  runId: string;
  ownerId: string;
  owner: LocalProcessIdentity;
  generation: number;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
  released: boolean;
}

export interface RunLeaseToken {
  runId: string;
  ownerId: string;
  generation: number;
}

export type ProcessObservation =
  | { state: "alive"; observedAtMs: number }
  | { state: "absent"; observedAtMs: number }
  | { state: "unknown"; observedAtMs: number; reason: string };
```

`ownerId` is a fresh cryptographic UUID. `hostIdentityDigest` hashes the OS machine identity; `bootIdentityDigest` hashes the Linux boot ID or macOS boot identity. Raw machine identifiers are never stored or printed. If either identity cannot be obtained, automatic takeover is unavailable. These digests, the PID, and start token are identity evidence, not signal authority. The process inspector returns `absent` only when no process has the PID, the strongest supported start identity differs, or the same host has booted again. A same-token collision fails conservatively as `alive` or `unknown`; it can delay takeover but cannot authorize one. State from another or unidentifiable host is `unknown` for automatic takeover.

Production lease duration is 15 seconds and renewal occurs no later than every 5 seconds. SQLite assigns transaction times. Tests inject a store clock; production callers cannot supply timestamps. A CLI waiting for expiry uses bounded polling with a deadline rather than a fixed sleep.

### Workspace checkpoint

```ts
export interface WorkspaceCheckpoint {
  version: "anastom.dev/workspace-checkpoint/v1alpha1";
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  diffDigest: string;
  changedFiles: string[];
  ignoredDigest: string;
  ignoredEntryCount: number;
  ignoredByteCount: number;
  ownership: {
    repositoryRoot: string;
    repositoryCommonDirectory: string;
    workspacePath: string;
    workspaceGitDirectory: string;
    branch: string;
    manifestDigest: string;
    registrationDigest: string;
  };
  diffArtifactId?: string;
}

export type WorkspaceDifference =
  | "version"
  | "workspace-id"
  | "base-commit"
  | "head-commit"
  | "diff-digest"
  | "changed-files"
  | "ignored-content"
  | "repository"
  | "workspace-path"
  | "branch"
  | "ownership-manifest"
  | "worktree-registration";
```

Ignored content is streamed through the digest with the feasibility limits: at most 4,096 entries and 64 MiB of file and symlink-target bytes. A binary diff is at most 16 MiB, matching the current Git capture bound. Non-empty diffs are written as immutable artifacts before the fenced transition; only their reference becomes authoritative in that transition. Two complete captures must match. Capture does not modify the user's staging index.

### Execution references and outcomes

The event stream first records a plan identity that is known before a supervisor exists, then the sanitized prepared reference:

```ts
export interface ExecutionPlanRef {
  version: "anastom.dev/owned-execution/v1alpha1";
  runId: string;
  executionId: string;
  kind: "runtime" | "command";
  generation: number;
  planDigest: string;
}

export interface PersistedExecutionRef extends ExecutionPlanRef {
  manifestDigest: string;
}

export type ExecutionObservation =
  | { state: "active"; execution: ExecutionPlanRef }
  | {
      state: "absent";
      execution: ExecutionPlanRef;
      terminal?: ExecutionTerminalEvidence;
    }
  | {
      state: "unknown";
      execution: ExecutionPlanRef;
      reason:
        | "invalid-record"
        | "identity-mismatch"
        | "boot-mismatch"
        | "supervisor-unreachable"
        | "supervisor-lost"
        | "cleanup-unconfirmed";
    };

export interface ExecutionTerminalEvidence {
  outcome: "succeeded" | "failed" | "blocked" | "cancelled";
  cleanup: "confirmed";
  terminalDigest: string;
}
```

The private capability, endpoint, coordinator identity, supervisor identity, and complete terminal result stay in private operational records. The execution host returns sanitized terminal evidence plus the already normalized result and observations to the engine. Public inspection never emits the capability, endpoint, prompt, private tool body, reasoning, raw provider error, or environment.

## Engine contracts

### Store interface

`RunPersistence.append()` is replaced for M3 execution by an owned, idempotent mutation. The in-memory implementation follows the same observable lease and fencing rules.

```ts
export interface DurableRunStore {
  createOwned(input: CreateOwnedRun): Promise<OwnedRunReceipt>;
  load(runId: string, mode: "execution"): Promise<LoadedRun | null>;
  load(runId: string, mode: "complete-history"): Promise<LoadedRunWithHistory | null>;
  inspectLease(runId: string): Promise<RunLease | null>;
  acquireReleased(input: AcquireReleasedRun): Promise<RunLeaseToken>;
  takeoverExpired(input: TakeoverExpiredRun): Promise<RunLeaseToken>;
  renew(token: RunLeaseToken): Promise<RunLease>;
  release(token: RunLeaseToken): Promise<void>;
  commit(input: FencedRunMutation): Promise<MutationReceipt>;
  submitControl(input: ControlSubmission): Promise<ControlReceipt>;
  pendingControls(runId: string, limit?: number): Promise<ControlRequest[]>;
}

export interface CreateOwnedRun {
  runId: string;
  workflow: WorkflowDefinition;
  initialEvents: readonly RunEvent[];
  ownerId: string;
  owner: LocalProcessIdentity;
  operationId: string;
  snapshot: RunSnapshot;
}

export interface OwnedRunReceipt {
  lease: RunLeaseToken;
  mutation: MutationReceipt;
}

export interface LoadedRun {
  workflow: WorkflowDefinition;
  state: RunState;
  eventPrefixDigest: string;
  snapshotSource: "snapshot-tail" | "full-replay";
  snapshotSequence?: number;
}

export interface LoadedRunWithHistory extends LoadedRun {
  events: RunEvent[];
}

export interface AcquireReleasedRun {
  runId: string;
  ownerId: string;
  owner: LocalProcessIdentity;
}

export interface TakeoverExpiredRun extends AcquireReleasedRun {
  observedLease: RunLease;
  ownerAbsence: Extract<ProcessObservation, { state: "absent" }>;
}

export interface FencedRunMutation {
  lease: RunLeaseToken;
  operationId: string;
  expectedSequence: number;
  events: readonly RunEvent[];
  snapshot?: RunSnapshot;
  handlesControlOperationId?: string;
}

export interface MutationReceipt {
  runId: string;
  operationId: string;
  firstSequence: number;
  lastSequence: number;
  replayed: boolean;
}

export interface ControlSubmission {
  runId: string;
  operationId: string;
  action: "pause" | "cancel";
}

export interface ControlRequest extends ControlSubmission {
  recordedAtMs: number;
}

export interface ControlReceipt extends ControlRequest {
  replayed: boolean;
}
```

`createOwned` atomically inserts the immutable definition, initial events, generation-one lease, event integrity, mutation receipt, and initial snapshot. `acquireReleased` handles a released lease or a legacy run without a lease. It never takes an expired unreleased lease. `takeoverExpired` accepts only an exact previously inspected lease plus an `absent` observation and rechecks the owner, generation, expiry, and release state inside `BEGIN IMMEDIATE`.

`commit` validates the unexpired fence before looking up the mutation ID. It then returns an existing same-payload receipt, rejects a changed payload, compares the expected sequence, validates and appends the complete event batch, records event integrity, optionally writes a snapshot, and acknowledges a matching control request in one transaction. The payload digest is computed internally from the canonical expected sequence, events, snapshot identity, and handled control ID.

Expected operational conflicts use one error with a stable code:

```ts
export class RunStoreError extends Error {
  readonly code:
    | "not-found"
    | "ownership-conflict"
    | "lease-expired"
    | "sequence-conflict"
    | "idempotency-conflict"
    | "control-conflict"
    | "busy"
    | "unsupported-history"
    | "corrupt-store";
}
```

Callers must branch on `code`, never diagnostic text.

### Execution-host interface

The engine owns this interface and `@anastom/execution-host` implements it:

```ts
export interface ExecutionHost {
  prepare(input: PrepareExecution): Promise<PersistedExecutionRef>;
  authorize(execution: PersistedExecutionRef): Promise<OwnedExecution>;
  inspect(execution: ExecutionPlanRef): Promise<ExecutionObservation>;
  terminate(execution: ExecutionPlanRef): Promise<ExecutionObservation>;
}

export type PrepareExecution =
  | {
      plan: ExecutionPlanRef;
      coordinator: LocalProcessIdentity;
      descriptor: RuntimeDescriptor;
      request: ExecutionRequest;
    }
  | {
      plan: ExecutionPlanRef;
      coordinator: LocalProcessIdentity;
      command: CommandDefinition;
      workspace: WorkspaceRef;
    };

export interface OwnedExecution {
  readonly execution: PersistedExecutionRef;
  events(): AsyncIterable<RuntimeEvent>;
  collect(): Promise<ExecutionResult | CommandExecutionResult>;
  cancel(): Promise<ExecutionObservation>;
}
```

`prepare` may start only the supervisor. It must return after the private control record and sanitized `awaiting-start` manifest are atomically published. `inspect` accepts the earlier plan reference so a replacement can classify a crash between manifest publication and `AttemptStartAuthorized`. No manifest for an exact persisted plan proves absence because launch cannot be authorized before manifest publication. `authorize` succeeds only after `AttemptStartAuthorized` is durable under the same generation. The supervisor atomically publishes `starting` before the first worker-side effect, then `active`. Any supervisor loss from `starting` or `active` is `unknown`. `collect` resolves only after a terminal record with confirmed descendant cleanup is durable.

After authorization, the supervisor starts the hidden CLI runtime-host as a new process-group leader and passes the descriptor and request over a private inherited pipe. The host reconstructs the adapter through the registered codec and runs it inside that child. Keeping the supervisor outside the owned group lets it terminate the host and every adapter or command descendant without signalling itself. Checked-in programs are invoked with argument vectors and no shell. Runtime packages never receive state-directory paths or lease credentials.

### Event additions

Old event names and reducers remain readable. New M3 runs use these exact additions:

```ts
type M3RunEventPayload =
  | { type: "RuntimeConfigured"; descriptor: RuntimeDescriptor }
  | {
      type: "AttemptPrepared";
      nodeId: string;
      attempt: number;
      execution: ExecutionPlanRef;
      workspaceCheckpoint: WorkspaceCheckpoint;
    }
  | {
      type: "AttemptStartAuthorized";
      nodeId: string;
      attempt: number;
      execution: PersistedExecutionRef;
    }
  | {
      type: "ControlRequestObserved";
      operationId: string;
      action: "pause" | "cancel";
      recordedAtMs: number;
    }
  | {
      type: "ExecutionCleanupObserved";
      nodeId: string;
      attempt: number;
      executionId: string;
      cause: "pause" | "cancel" | "timeout" | "recovery";
      outcome: "confirmed" | "unknown";
    }
  | {
      type: "AttemptOrphaned";
      nodeId: string;
      attempt: number;
      executionId: string;
      lostGeneration: number;
      reason: "coordinator-lost" | "launch-interrupted";
      workspaceObservation: WorkspaceCheckpoint;
      workspaceDifferences: WorkspaceDifference[];
      terminalArtifactId?: string;
    }
  | { type: "RunRecoveryBlocked"; operationId: string; reason: RecoveryBlockReason };

type RevisedM3LifecyclePayload =
  | {
      type: "NodeReady";
      nodeId: string;
      reason: "dependencies-satisfied" | "retry" | "resumed" | "recovered";
    }
  | { type: "NodePaused"; nodeId: string; reason: PauseReason }
  | { type: "RunPaused"; reason: PauseReason }
  | { type: "RunResumed"; operationId: string }
  | { type: "RunCancelled"; operationId: string; reason: string };
```

`AttemptStatus` adds `prepared` and `orphaned`; `RunStatus` adds `recovery-blocked`. `NodePaused` may follow a cancelled or orphaned current attempt. Legacy lifecycle events without the M3 fields retain their original reducer meaning. `RunResumed` is valid from `paused` or `recovery-blocked` only after the recovery batch has made every affected node schedulable or safely paused.

```ts
export type RecoveryBlockReason =
  | {
      kind: "execution-unknown";
      executionId: string;
      detail: Extract<ExecutionObservation, { state: "unknown" }>["reason"];
    }
  | { kind: "cleanup-unknown"; executionId: string }
  | { kind: "history-incompatible"; detail: "missing-descriptor" | "missing-execution-ref" };

export type PauseReason =
  | { kind: "operator"; operationId: string }
  | { kind: "workspace-conflict"; differences: WorkspaceDifference[] }
  | { kind: "attempt-budget-exhausted"; nodeId: string; attempts: number }
  | { kind: "runtime-unavailable"; runtimeId: string }
  | { kind: "policy-violation"; runtimeId: string };
```

An orphan is valid only for the latest `prepared` or `running` attempt, under a later lease generation, after execution absence is established. It is terminal and may be recorded once. A `RunRecoveryBlocked` event does not claim cleanup or absence. Repeated resume may inspect again; only later `absent` evidence can advance it.

### Inspection view

Mutable coordination is reported beside event state:

```ts
export interface DurableRunInspection {
  definitionDigest: string;
  workflow: WorkflowDefinition;
  state: RunState;
  ownership: {
    lease: RunLease | null;
    ownerState: "live" | "expired" | "released" | "unknown";
  };
  pendingControls: ControlRequest[];
  snapshot: { source: "snapshot-tail" | "full-replay"; sequence?: number };
  events?: RunEvent[];
}
```

`status` omits complete events. `inspect --json` includes them. Owner state combines the database lease with a model-free local process observation. Neither command acquires, renews, releases, or takes over a lease, repairs a snapshot, contacts a runtime, or starts a worker.

## SQLite schema and transaction rules

M3 adds one immutable migration. Existing `runs` and `events` rows and their JSON bytes are not rewritten.

| Table              | Key and purpose                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_leases`       | One mutable row per run: owner identity, generation, database-assigned times, expiry, and release flag.                                      |
| `run_mutations`    | `(run_id, operation_id)` immutable payload digest and committed sequence range.                                                              |
| `control_requests` | `(run_id, operation_id)` action and database-assigned time; optional acknowledged event sequence is a derived index checked against history. |
| `event_integrity`  | `(run_id, sequence)` event-byte digest and rolling history digest for M3-written events.                                                     |
| `run_snapshots`    | `(run_id, sequence, reducer_version)` rebuildable cache bytes and digests.                                                                   |

Foreign keys point to `runs` or `events`. Generation, sequence, duration, byte-count, and time fields have positive integer checks. Action and state fields use closed SQL checks. Mutation rows, integrity rows, and their referenced events cannot be updated or deleted. Snapshot rows may be replaced only by a current fenced mutation because they are caches. Control acknowledgement may advance once from null to the sequence of a matching persisted event; the event remains the semantic authority.

The migration columns are fixed as follows; timestamp columns are integer Unix milliseconds assigned by the store's database clock:

```text
run_leases(
  run_id PRIMARY KEY REFERENCES runs,
  owner_id, owner_json, owner_digest,
  generation, acquired_at_ms, renewed_at_ms, expires_at_ms, released
)

run_mutations(
  run_id REFERENCES runs, operation_id, generation, payload_digest,
  expected_sequence, first_sequence, last_sequence, committed_at_ms,
  PRIMARY KEY(run_id, operation_id)
)

control_requests(
  run_id REFERENCES runs, operation_id, action, recorded_at_ms,
  acknowledged_sequence,
  PRIMARY KEY(run_id, operation_id),
  FOREIGN KEY(run_id, acknowledged_sequence) REFERENCES events(run_id, sequence)
)

event_integrity(
  run_id, sequence, event_digest, history_digest,
  PRIMARY KEY(run_id, sequence),
  FOREIGN KEY(run_id, sequence) REFERENCES events(run_id, sequence)
)

run_snapshots(
  run_id REFERENCES runs, sequence, version, reducer_version,
  definition_digest, event_prefix_digest, state_digest, state_json,
  created_at_ms,
  PRIMARY KEY(run_id, sequence, reducer_version)
)
```

IDs, digests, JSON types, positive generations/sequences, `released IN (0,1)`, `action IN ('pause','cancel')`, and snapshot byte bounds receive SQL checks where SQLite can enforce them. Application validation still treats every row as untrusted input. `pendingControls` returns only unacknowledged rows, oldest first, with a default and maximum limit of 100.

All lease and mutation writes use `BEGIN IMMEDIATE`. The database enables foreign keys, WAL, a five-second busy timeout, and the existing migration drift checks. A busy timeout is not a lease decision and produces `RunStoreError("busy")`.

### Rolling event integrity

For canonical `event_json` bytes:

```text
eventDigest = SHA256(event_json UTF-8 bytes)
H0 = SHA256("anastom.dev/event-history/v1alpha1\n")
Hi = SHA256(canonicalJson({
  version: "anastom.dev/event-history/v1alpha1",
  previous: H(i-1),
  runId,
  sequence,
  eventType,
  eventDigest
}))
```

Every M3 event insert writes `event_integrity` in the same transaction. For a legacy prefix without integrity rows, the loader reads and validates those exact stored events to calculate the missing chain. The first later M3 event records the resulting cumulative digest without modifying legacy rows. A snapshot may use a stored cumulative digest only when integrity coverage is contiguous from sequence one to its prefix. Otherwise it recomputes the prefix from authoritative event bytes.

The complete-history loader always parses and validates every event. The execution loader may trust a transactionally written covered prefix and parse only the tail. Direct administrator rewriting of both immutable history and integrity records remains outside the threat model; schema drift, broken chains, malformed tails, and ordinary corruption fail closed.

### Snapshots

```ts
export interface RunSnapshot {
  version: "anastom.dev/run-snapshot/v1alpha1";
  reducerVersion: "anastom.dev/run-reducer/v1alpha1";
  runId: string;
  definitionDigest: string;
  sequence: number;
  stateJson: string;
  stateDigest: string;
  eventPrefixDigest: string;
}
```

Canonical `stateJson` is capped at 4 MiB. The loader considers newest candidates first and ignores invalid, unknown, oversized, noncanonical, identity-mismatched, definition-mismatched, prefix-mismatched, state-digest-mismatched, or tail-contradicting snapshots. It then performs full replay. Corrupt authoritative history is an error, never snapshot fallback. A read-only command does not rewrite the cache.

## Supervisor protocol and private state

M3 uses filesystem Unix sockets on POSIX. Endpoint paths are capped at 100 UTF-8 bytes, below the supported Linux and macOS pathname limits. The default socket root is a canonical, current-user-owned, mode-`0700` directory below `/tmp/anastom-<uid>/`. A 16-byte state-directory digest and the 16 UUID bytes are encoded as compact unpadded base64url directory and socket names, keeping the canonical macOS `/private/tmp` form within the same limit. An explicit future runtime-root option would require its own CLI contract; M3 does not read an ambient environment override.

The durable state directory contains the plan, control, manifest, start-authority, and terminal records below a run/execution directory. The socket directory contains no credential or capability. Private records are mode `0600`; directories are mode `0700`.

| Boundary                                                    |                                             Maximum |
| ----------------------------------------------------------- | --------------------------------------------------: |
| Plan, control, manifest, and start-authority record         |                                         64 KiB each |
| Terminal record                                             |                                               4 MiB |
| One request or response frame                               |                                               1 MiB |
| Private inherited launch frame                              |                                               4 MiB |
| Accepted connections per supervisor                         |                               1 active and 8 queued |
| One connection lifetime                                     |                                           5 seconds |
| Public runtime observations retained after coordinator loss | 256, with log eviction and `droppedLogs` accounting |

Each connection carries exactly one four-byte big-endian length-prefixed canonical JSON request and one response, then half-closes. Trailing bytes, multiple frames, unknown fields, invalid UTF-8, a wrong capability, a wrong execution ID, a wrong generation, and an expired connection fail closed. Capability comparison is constant-time after equal-length validation.

The private capability is 256 random bits. Only its digest appears in the manifest and start authority. The supervisor validates the plan digest, coordinator/boot identity, capability, execution ID, and generation before authorization. It detects coordinator loss through inherited-pipe closure plus verified process identity and begins cleanup without waiting for lease expiry. `terminate` sends `SIGTERM` to the owned process group, waits a bounded grace period, sends `SIGKILL` if required, reaps the direct child, and confirms that the observed group has no non-zombie members. It never signals from a bare PID, group number, or stale manifest.

Manifest states are `awaiting-start`, `starting`, `active`, and `terminal`:

- absent supervisor plus authenticated `awaiting-start` proves no worker launch was authorized;
- live authenticated supervisor answers inspection directly;
- absent supervisor plus authenticated terminal record and confirmed cleanup proves absence;
- absent supervisor from `starting` or `active`, or any invalid identity record, is `unknown`.

The host persists only bounded normalized public observations. Adapter-native streams, raw errors, prompts, reasoning, tool bodies, credential values, and environment snapshots never cross the protocol. The coordinator polls controls at least every 500 milliseconds while an execution is active and renews its lease on the independent five-second cadence.

Canonical normalized execution results are capped at 1 MiB before they enter the terminal record. Oversized output becomes a typed schema-violation failure after confirmed cleanup. This makes Pi subject to the same result bound already implied by the native JSONL adapters.

## Private path-policy capability

The existing `canonicalExistingRoot()` and `resolveExistingChild()` API continues to handle caller-authorized existing authored paths and internal symlinks. M3 adds a separate capability:

```ts
export interface PrivatePathRoot {
  readonly path: string;
  ensureDirectory(segments: readonly string[]): Promise<string>;
  readFile(segments: readonly string[], options: { maxBytes: number }): Promise<Buffer>;
  writeFileAtomic(
    segments: readonly string[],
    bytes: Uint8Array,
    options: { maxBytes: number },
  ): Promise<void>;
  socketPath(segments: readonly string[], options: { maxBytes: number }): string;
}

export function ensurePrivatePathRoot(path: string): Promise<PrivatePathRoot>;
```

Every segment must be a single nonempty filename component: no separators, dot components, null bytes, or absolute input. The function creates an absent leaf root at mode `0700`; an existing root must be a canonical ordinary directory owned by the current user with no group/other permissions. Existing M1 state directories are tightened to mode `0700` only after confirming current-user ownership and nonsymlink identity. Methods revalidate run-owned parents as ordinary nonsymlinked directories. Reads open an ordinary nonsymlinked file, reject an initial size above the limit, read at most `maxBytes + 1` through the opened descriptor, and verify its identity did not change. Atomic writes create an exclusive temporary ordinary file in the same parent, apply mode `0600`, enforce the byte limit, sync and close the file, rename it over the fixed leaf, and sync the parent directory. Callers select fixed record names; untrusted text never becomes a path expression.

`socketPath` validates segments, containment, and the full UTF-8 path limit. It does not unlink an existing entry. The execution host may remove a stale socket only after its authenticated manifest proves the prior supervisor absent or terminal. This capability assumes the current local account is trusted; it is integrity hardening and CodeQL-safe path construction, not protection against a malicious process running as the same user.

Artifact storage and workspace ownership migrate to `PrivatePathRoot` only where their semantics match. Signed executable lookup, authentication stores, managed-policy discovery, and native model-selected file tools retain their existing separate rules.

## Recovery and control sequences

### Starting an attempt

1. Renew the run lease.
2. Generate the execution UUID.
3. Capture the workspace twice and write any diff artifact.
4. Commit `AttemptScheduled` and `AttemptPrepared` with the plan reference and checkpoint under one mutation ID.
5. Call `ExecutionHost.prepare`; no worker may start.
6. Commit `AttemptStartAuthorized` with the sanitized execution reference under a new mutation ID.
7. Call `authorize`; the supervisor persists `starting` before any runtime or command side effect.
8. Stream public observations and collect a terminal result whose cleanup is confirmed.
9. Commit existing result/verification events and a stable-boundary snapshot.

A crash in steps 4–7 consumes the attempt. Recovery classifies it using the persisted attempt state and supervisor evidence; it never quietly reuses the attempt number.

### Resume after coordinator loss

1. Load and validate the descriptor before lease acquisition.
2. Refuse a live, unexpired, foreign-host, or unknown owner without mutation; a changed boot identity on the same host proves the prior process absent.
3. After expiry and an `absent` owner observation, take over using the exact observed lease.
4. Process the oldest pending pause/cancel request first.
5. Inspect the prepared/running execution. `unknown` commits `RunRecoveryBlocked`, releases the lease, and starts nothing.
6. Terminate an active execution and require a later `absent` observation.
7. Capture the workspace and retain its diff evidence.
8. Atomically record `AttemptOrphaned` once with the lost generation and workspace comparison.
9. On mismatch, pause with `workspace-conflict`. On exhausted budget, pause with `attempt-budget-exhausted`.
10. Reconstruct the adapter and rerun current preflight. A failure pauses with a typed reason and starts no attempt.
11. On exact match and remaining budget, emit `NodeReady` with `recovered`, then schedule a freshly numbered attempt.

### Pause and cancel

`pause` and `cancel` insert a deduplicated control request without acquiring the lease. If no live owner exists, the command may become the coordinator through the ordinary acquisition/takeover path. The owner records `ControlRequestObserved` before cleanup.

At a scheduling boundary, pause changes only the run state and preserves pending/ready nodes. During an attempt, confirmed cleanup is followed atomically by `AttemptCancelled`, `NodePaused`, and `RunPaused`. Cancel similarly cancels every nonterminal node and records `RunCancelled`. Unknown cleanup records `ExecutionCleanupObserved(outcome: "unknown")` and `RunRecoveryBlocked`; it does not claim a completed pause or cancel.

Duplicate operation IDs with the same action return their original receipt/outcome. Reuse with another action conflicts. A new ID against an already achieved pause or terminal cancellation is a semantic no-op. Resume is an ownership operation and uses mutation IDs; it is not inserted into the pause/cancel inbox.

## CLI contract

M3 adds:

```text
anastom pause  <run> [--state-dir <path>] [--operation-id <uuid>]
anastom cancel <run> [--state-dir <path>] [--operation-id <uuid>]
anastom resume <run> [--state-dir <path>] [--operation-id <uuid>]
```

Generated operation IDs are printed before the first mutation so an interrupted caller can retry them. Exit `0` means the requested terminal state was reached or already held. Exit `1` means the request was accepted but remains pending, or safe progress is blocked; output includes the operation ID and typed reason. Exit `2` remains invalid usage, missing run, or invalid stored input. Diagnostics remain credential-free.

`run` records the descriptor before attempt one. Existing M1/M2/M2.5 runs remain fully inspectable. Resume of an old history without a descriptor or execution reference fails closed as `history-incompatible`; it never guesses the original flags. The implementation includes fixture databases for each pre-M3 shape.

## Implementation slices after approval

Each slice is a separately reviewable stacked PR. Later slices remain based on the preceding approved contract branch so the whole stack can ultimately merge through PR #24 in order.

1. Runtime descriptors, event/reducer additions, exact JSON schemas, compatibility fixtures, and Changesets.
2. `PrivatePathRoot`, workspace checkpoint production code, and focused caller migrations.
3. Durable store migration, lease/fence/idempotency/control transactions, event integrity, and snapshot loader.
4. `@anastom/execution-host`, hidden fixture host, and model-free conformance for all four execution owners.
5. Engine start, heartbeat, control, orphan, workspace, and recovery state machines.
6. CLI commands, runtime registry, inspection output, and old-history refusal behavior.
7. Process-level M3 acceptance and `docs/M3_EVIDENCE.md`.

Every code/contract slice carries reviewed package Changesets and updates affected package READMEs/changelogs. No slice uses a real model. A contradiction found during implementation stops the affected slice and updates this proposal, ADR 0018, and the build brief before the API changes.

## Explicitly deferred

- Windows process ownership and named-pipe behavior;
- provider-session or transcript adoption;
- accepting a completed orphan result as node success;
- force takeover, process killing from unauthenticated numeric identities, or remote ownership;
- automatic reset, merge, deletion, or acceptance of orphan workspace changes;
- environment-selected socket roots;
- general secret detection in arbitrary JSON instead of exact descriptor schemas;
- exactly-once model, tool, command, filesystem, or network effects;
- M4 parallel nodes, integration worktrees, planning, and review workflows.
