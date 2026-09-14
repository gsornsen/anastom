# Architecture

## Status and objective

This document describes the implemented M0 boundary and the accepted M1 extension. Later milestone ideas are labeled explicitly.

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
+-------------+---------------+-------------------------------+
| Fake (M0)   | Pi (M1)       | Codex and others (later)      |
+-------------+---------------+-------------------------------+
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
- **Model:** the LLM selected for an attempt; model selection remains adapter configuration in M1.
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

M0 deliberately sends all four node kinds through the fake adapter so the scheduler and transition model can be tested without side effects. M1 replaces that test convenience with separate execution paths:

| Node kind  | M1 owner                       | M1 behavior                                                                                  |
| ---------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `agent`    | `RuntimeAdapter`               | Pi executes one fresh bounded session in the assigned workspace.                             |
| `command`  | control-plane command executor | Spawn an exact argument vector, capture bounded output, and decide success from exit status. |
| `verifier` | fake adapter only              | General verifier plugins remain deferred; the M1 demo verifies with a `command` node.        |
| `gate`     | fake adapter only              | Human approval, machine conditions, audit, and resume remain deferred.                       |

Unsupported executable node kinds must fail before an attempt starts. They must not fall back to Pi.

## Runtime adapter contract

The implemented lifecycle is:

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

M1 does not add model selection to this request. Runtime and model configuration resolve outside the workflow role. M2 adds capability negotiation and makes portability across Pi and Codex observable.

`recover` is optional contract space and is not implemented for live Pi attempts in M1. SQLite durability in M1 supports cross-process `status` and `inspect`; M3 defines ownership leases, orphan detection, and safe execution recovery.

## Runtime capabilities

Adapters declare observable capabilities such as streaming, cancellation, structured output, usage reporting, tool integrations, and sandboxing. M1's Pi adapter declares its enabled capabilities; the engine does not yet negotiate or persist a snapshot.

The [proposed M2 contract](M2_BUILD_BRIEF.md) validates the explicitly selected adapter against a Task's fixed worker requirements and records the accepted snapshot before execution. It proposes shared adapter conformance and available token observations. These are not implemented yet. Automatic runtime/model routing and fallback remain M12.

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

M1 uses SQLite for two authoritative records:

```text
runs(run_id, workflow_digest, workflow_json, created_at)
events(run_id, sequence, event_type, event_json, recorded_at)
```

`(run_id, sequence)` is unique. Creating a run and appending events are transactional. Appends compare the expected sequence and fail on conflict. SQLite enables foreign keys and WAL where the storage location supports it.

`workflow_json` contains the normalized immutable definition. `workflow_digest` covers a canonical serialization of that definition. Database timestamps support operator inspection; event sequence remains the only transition ordering authority.

Artifact bodies live below a per-run filesystem directory. Their digest and metadata enter the event stream. M1 does not add mutable node, attempt, lease, snapshot, evidence, usage, or projection tables. Those tables require a milestone that uses them.

## Failure semantics

Failures retain typed categories: runtime unavailable, model/provider, tool, schema violation, verification, budget exhausted, policy violation, workspace conflict, human rejection, and unknown/internal.

Retry policy reacts to the category and budget. Exhaustion is fail-fast in M1. Repeating a failed instruction without a new recorded reason is not a recovery policy.

## Deferred architecture

M1 does not implement Codex, human gates, nested workflows, fan-out, shared integration, capability routing, snapshots, execution leases, crash recovery, pause/resume, cost routing, circuit breakers beyond attempt and duration limits, or a general evidence graph.

The controlling decisions are recorded in `docs/adr/`. A later milestone may supersede an ADR with another ADR; it must not silently edit away the reason for the earlier choice.
