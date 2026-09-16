# Architecture

## Status and objective

This document describes the implemented control plane through M2.5. The accepted M3 durability design and model-free feasibility prototypes are labeled explicitly; M3 product behavior and exact API shapes are not implemented yet.

Anastom keeps engineering policy independent from agent runtime implementation. The control plane owns authoritative state and verification; a runtime adapter owns one bounded agent loop.

## Layer model

```text
+-------------------------------------------------------------+
| User interface                                              |
| CLI now; TUI, API, and UI later                             |
+-------------------------------+-----------------------------+
                                |
+-------------------------------v-----------------------------+
| Control plane                                                |
| scheduler | policy | transitions | budgets | command checks |
+-------------------------------+-----------------------------+
                                |
+-------------------------------v-----------------------------+
| Workflow runtime                                             |
| IR interpreter | context builder | artifacts | event replay  |
+-------------------------------+-----------------------------+
                                |
+-------------------------------v-----------------------------+
| Runtime adapter contract                                     |
+-------------+---------------+-------------+-----------------+
| Fake (M0)   | Pi (M1)       | Codex (M2)  | Claude (M2.5)   |
+-------------+---------------+-------------+-----------------+
                                |
+-------------------------------v-----------------------------+
| Execution capabilities                                       |
| models | tools | LSP | debugger | MCP | browser | sandbox   |
+-------------------------------------------------------------+
```

## Domain concepts

- **Run:** one durable execution of one root workflow.
- **Workflow definition:** a versioned executable methodology graph.
- **Workflow instance:** runtime state of a workflow within a run.
- **Node:** the smallest schedulable workflow unit.
- **Attempt:** one execution attempt of a node.
- **Role:** a semantic capability profile requested by an agent node.
- **Runtime:** the harness used for one agent attempt.
- **Model:** the LLM selected for an attempt; model selection remains explicit adapter configuration outside the authored workflow.
- **Context envelope:** the explicit immutable input to an attempt.
- **Artifact:** a durable output such as a worker report, diff, log, or command result.
- **Evidence:** an artifact or observation supporting a later decision; a general evidence graph is deferred.
- **Gate:** a machine or human authorization condition; executable gates are deferred beyond M1.
- **Policy:** deterministic constraints governing execution.
- **Workspace:** the filesystem and Git isolation boundary assigned by the control plane.

## Ownership boundary

Anastom owns workflow state, scheduling, dependencies, roles, budgets, retries, context construction, verification, workspace assignment, authoritative status, adapter selection, and trace replay.

A harness owns one agent loop, model communication, harness-native tool execution, session mechanics, streaming, and optional editor or browser integrations. A harness response is an observation until Anastom validates and records it.

The control plane must not delegate scheduling, retry policy, acceptance decisions, workspace selection, or durable state to a prompt or harness session.

## Execution ownership

M0 deliberately sends all four node kinds through the fake adapter so the scheduler and transition model can be tested without side effects. Durable Task execution uses separate execution paths:

| Node kind  | Current owner                  | Current behavior                                                                                         |
| ---------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `agent`    | selected `RuntimeAdapter`      | Pi, Codex, or Claude Code executes one fresh bounded attempt in the assigned workspace.                  |
| `command`  | control-plane command executor | Spawn an exact argument vector, capture bounded output, and decide success from exit status.             |
| `verifier` | fake adapter only              | General verifier plugins remain deferred; delivered Task demonstrations verify with a `command` node.    |
| `gate`     | fake adapter only              | Human approval, machine conditions, and audit remain deferred; M3 proposes operational pause and resume. |

Unsupported executable node kinds must fail before an attempt starts. They must not fall back to another adapter.

## Runtime adapter contract

The implemented lifecycle through M2.5 is:

```ts
export interface RuntimeAdapter {
  readonly id: string;

  capabilities(): Promise<RuntimeCapabilities>;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent>;
  collect(handle: ExecutionHandle): Promise<ExecutionResult>;
  cancel(handle: ExecutionHandle): Promise<void>;
  recover?(persisted: PersistedExecutionRef): Promise<RecoveredExecution | null>;
}
```

The implemented M0 request includes `nodeKind`; `role` is optional because deterministic nodes do not have roles:

```ts
type ExecutionRequest = {
  runId: string;
  workflowInstanceId: string;
  nodeId: string;
  nodeKind: NodeKind;
  attempt: number;
  role?: ResolvedRole;
  workspace: WorkspaceRef;
  context: ContextEnvelope;
  budget: AttemptBudget;
  requiredOutputSchema: JsonSchema;
  toolPolicy: ToolPolicy;
};
```

Runtime and model configuration resolve outside the workflow role. M2 added capability negotiation and made portability across Pi and Codex observable; M2.5 applied the same boundary to Claude Code.

`recover` is optional contract space that no live adapter implements. SQLite durability supports cross-process `status` and `inspect`, but an attempt running during coordinator loss cannot yet continue. Accepted [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md) removes session adoption from the M3 baseline and replaces it with fenced ownership plus evidence-backed execution reconciliation before a fresh attempt. The M3 supervisor probe deliberately remains repository-level feasibility code until its shared lifecycle boundary and the persistence/workspace evidence justify a replacement package contract.

## Runtime capabilities

Adapters declare observable capabilities such as streaming, cancellation, structured output, usage reporting, tool integrations, and sandboxing. The engine validates the explicitly selected adapter against the Task's requirements and persists the accepted capability snapshot before creating an attempt.

The completed [M2 contract](M2_BUILD_BRIEF.md) also provides shared adapter conformance and normalized available token observations. M2.5 demonstrates that a third source adapter can preserve the same control-plane boundary. Automatic runtime/model routing and fallback remain M12.

## Workspace contract

The workspace reference evolves from the M0 in-memory fixture to this M1 union:

```ts
type WorkspaceRef =
  | { id: string; mode: "memory" }
  | {
      id: string;
      mode: "readonly";
      repoRoot: string;
      path: string;
      baseCommit: string;
    }
  | {
      id: string;
      mode: "isolated";
      repoRoot: string;
      path: string;
      branch: string;
      baseCommit: string;
    };
```

The control plane creates an isolated Git worktree from an exact base commit, assigns its path to Pi, records the branch and resulting head, and captures the final diff as an artifact. A run never asks Pi to create or select its own worktree.

M1 retains successful and failed worktrees for inspection and provides explicit cleanup. It never deletes a worktree that it cannot prove it owns. Shared integration and runtime-managed external workspaces are later modes.

Git worktrees isolate branches and concurrent edits. They are not a security sandbox. Pi currently runs with the host process permissions, so M1's security claim is traceable workspace isolation under local trust.

## Context construction

Every agent attempt receives a newly built, immutable envelope containing:

- envelope version and digest;
- task objective and acceptance criteria;
- role ID;
- validated workflow inputs and dependency outputs;
- assigned workspace and allowed mutation mode;
- selected artifact references;
- deterministic verification command;
- required structured-output schema;
- attempt budget.

The envelope excludes parent transcripts, failed reasoning branches unless promoted to an artifact, sibling scratchpads, superseded plans, credentials, and irrelevant repository content. The exact serialized envelope is stored before the adapter starts so inspection can explain what the worker received.

## Pi adapter

M1 integrates the maintained `@earendil-works/pi-coding-agent` TypeScript SDK directly. The adapter creates an in-memory Pi session rooted at the assigned worktree, subscribes to session events, sends one context-derived prompt, collects the final assistant response, and disposes the session. Cancellation calls Pi's abort operation.

The adapter uses Pi's normal authentication and model configuration. Anastom does not copy provider credentials into events or artifacts and does not treat Pi session storage as durable Anastom state. The dependency is pinned to an exact reviewed version in the implementation PR.

If the embedded SDK cannot meet one of these contracts at the pinned version, the implementation must document the mismatch before choosing RPC or subprocess integration. The adapter boundary must not change merely to mirror Pi internals.

## Deterministic command verification

The M1 command executor receives an argument vector rather than a shell string. It:

- resolves a workspace-relative working directory and rejects escapes;
- starts the executable without shell interpolation;
- supplies only the inherited environment allowed by policy;
- applies a wall-clock limit and bounded stdout/stderr capture;
- records exit code, signal, duration, truncation flags, and output artifacts;
- passes only when the process exits with code zero before timeout.

Pi may run commands while implementing a task, but only the control-plane command result authorizes the verification transition.

## Timeout and cancellation race

The control plane owns attempt deadlines. At the deadline it records a timeout request, calls adapter cancellation once, waits a bounded grace period, and records the attempt as a `budget-exhausted` failure. A timeout consumes an attempt.

A result observed after the timeout may be retained as diagnostic evidence but cannot change the terminal attempt or run state. Cancellation failure is recorded and does not extend the deadline. Tests use an injected clock or deterministic timer control.

## Events and persistence

The append-only event stream remains the authoritative transition history. Run state is reconstructed by replaying events in sequence; projections and snapshots are derived data.

The current durable store uses SQLite for two authoritative records:

```text
runs(run_id, workflow_digest, workflow_json, created_at)
events(run_id, sequence, event_type, event_json, recorded_at)
```

`(run_id, sequence)` is unique. Creating a run and appending events are transactional. Appends compare the expected sequence and fail on conflict. SQLite enables foreign keys and WAL where the storage location supports it.

`workflow_json` contains the normalized immutable definition. `workflow_digest` covers a canonical serialization of that definition. Database timestamps support operator inspection; event sequence remains the only transition ordering authority.

Artifact bodies live below a per-run filesystem directory. Their digest and metadata enter the event stream. M0-M2.5 do not add mutable node, attempt, lease, snapshot, evidence, usage, or projection tables. Accepted M3 design adds operational lease, idempotency, control-request, and snapshot records while preserving events as the workflow authority. The [M3 build brief](M3_BUILD_BRIEF.md) defines their different trust and lifecycle rules.

## Failure semantics

Failures retain typed categories: runtime unavailable, model/provider, tool, schema violation, verification, budget exhausted, policy violation, workspace conflict, human rejection, and unknown/internal.

Retry policy reacts to the category and budget. Exhaustion is fail-fast in M1. Repeating a failed instruction without a new recorded reason is not a recovery policy.

## Accepted M3 durability boundary

M3 adds local single-host recovery after coordinator loss. Its accepted design uses an expiring run lease with a monotonically increasing fencing generation, durable sanitized runtime reconstruction, pre-attempt workspace checkpoints, typed orphan attempts, rebuildable state snapshots, and explicit pause/cancel/resume operations. A replacement attempt starts only after the former owner is absent, the old execution is stopped, the workspace still matches its checkpoint, and authored attempt budget remains. See the [M3 build brief](M3_BUILD_BRIEF.md) and [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md).

Initial [M3 process-ownership feasibility](M3_FEASIBILITY.md) shows that all current execution owners can leave descendants after coordinator `SIGKILL`. It also rejects a direct native leader PID as the complete durable identity because a descendant can retain the group after that leader exits. A shared parent-death supervisor prototype passes on Ubuntu and macOS CI. Its production-shaped successor adds an execution UUID, fence and boot binding, an atomic manifest, private random capability, durable two-phase start authorization, and exact bounded local-socket frames. Across the owner macOS host and Ubuntu/macOS CI, model-free Pi, Codex, Claude Code, and command executions pass success relay, cancellation, and parent-death cleanup. Supervisor loss produces `unknown` and forbids replacement.

A separate SQLite contention probe passes on the owner macOS host and Ubuntu/macOS CI. Real process pairs serialize initial acquisition, renewal, expired absent-owner takeover, release, and reacquisition through generations one to three. Fences reject earlier owners before idempotency lookup; duplicate mutations return one physical append and the same contiguous range; changed digests and wrong expected sequences leave no partial rows; and lease-free control IDs deduplicate or conflict by action. This temporary schema does not change the production store.

The workspace-checkpoint probe passes on the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI in stacked PR #27. It preserves the real staging index while identifying complete content relative to the run base, fingerprints bounded ignored files/directories and symlink targets, and binds the result to canonical repository/worktree ownership. Content or `HEAD` changes mismatch; branch, manifest, symlink-boundary, and registration changes reject capture; a clone with identical Git content has a different identity. The probe does not change the workspace package.

The snapshot probe passes on the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI in stacked PR #28. For reopened M1/M2/M2.5-shaped and pause/resume/cancel histories, validated snapshot-plus-tail state equals full replay. Snapshot state is bound to the immutable workflow digest and exact event-prefix digest; invalid snapshots fall back, while corrupt authoritative events still fail. The probe does not add a migration or package API. All feasibility phases are now cross-platform; a separate contract review still gates production persistence and runtime changes.

Provider-session reattachment, automatic worktree reset, exactly-once external effects, force takeover, distributed scheduling, human gates, nested workflows, fan-out, shared integration, automatic capability routing, cost routing, circuit breakers beyond current attempt/duration limits, and a general evidence graph remain deferred.

The controlling decisions are recorded in `docs/adr/`. A later milestone may supersede an ADR with another ADR; it must not silently edit away the reason for the earlier choice.
