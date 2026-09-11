# Architecture

## Architectural objective

Anastom must keep engineering policy independent from agent runtime implementation.

## Layer model

```text
+-------------------------------------------------------------+
| User Interface                                              |
| CLI now; TUI/API/UI later                                   |
+-------------------------------+-----------------------------+
                                |
+-------------------------------v-----------------------------+
| Control Plane                                                |
| scheduler | policy | transitions | budgets | routing | gates |
+-------------------------------+-----------------------------+
                                |
+-------------------------------v-----------------------------+
| Workflow Runtime                                             |
| IR interpreter | nested flows | evidence | context builder   |
+-------------------------------+-----------------------------+
                                |
+-------------------------------v-----------------------------+
| Runtime Adapter Contract                                     |
+-----+-----------+------------+-------------+-----------------+
| Pi  | Codex     | Mycelium   | TrueForge   | OpenHands ...  |
+-----+-----------+------------+-------------+-----------------+
                                |
+-------------------------------v-----------------------------+
| Execution Capabilities                                       |
| models | tools | LSP | debugger | MCP | browser | sandbox   |
+-------------------------------------------------------------+
```

## Domain concepts

### Run
One durable execution of one root workflow.

### Workflow definition
Versioned executable methodology graph.

### Workflow instance
Runtime state of a workflow within a run.

### Node
Smallest schedulable workflow unit.

### Attempt
One execution attempt of a node.

### Role
Semantic capability profile requested by a node.

### Runtime
Harness used to execute an attempt.

### Model
LLM selected for an attempt.

### Context envelope
Explicit immutable description of what an attempt receives.

### Artifact
Durable output: plan, code diff, hypothesis, benchmark, review, test result, etc.

### Evidence
Artifact or observation that can support/refute a claim or transition.

### Gate
Condition requiring machine or human authorization before transition.

### Policy
Deterministic constraints governing execution.

### Workspace
Filesystem/git isolation boundary.

## Control-plane ownership

Anastom owns:

- workflow state;
- scheduling;
- dependency resolution;
- role requirements;
- budgets;
- retry/escalation rules;
- context construction;
- evidence references;
- verification;
- workspace assignment;
- authoritative status;
- adapter selection;
- trace/replay.

Harness owns:

- one agent loop;
- model communication;
- native tool execution;
- harness-local session mechanics;
- harness-specific streaming;
- optional LSP/debugger/browser integration.

This ownership boundary should be aggressively defended.

## Runtime adapter contract

Suggested initial shape:

```ts
export interface RuntimeAdapter {
  readonly id: string;

  capabilities(): Promise<RuntimeCapabilities>;

  start(request: ExecutionRequest): Promise<ExecutionHandle>;

  events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent>;

  collect(handle: ExecutionHandle): Promise<ExecutionResult>;

  cancel(handle: ExecutionHandle): Promise<void>;

  recover?(
    persisted: PersistedExecutionRef
  ): Promise<RecoveredExecution | null>;
}
```

`ExecutionRequest` includes:

```ts
type ExecutionRequest = {
  runId: RunId;
  workflowInstanceId: WorkflowInstanceId;
  nodeId: NodeId;
  attempt: number;

  role: ResolvedRole;
  model?: ModelSelection;

  workspace: WorkspaceRef;
  context: ContextEnvelope;
  budget: AttemptBudget;

  requiredOutputSchema: JsonSchema;
  toolPolicy: ToolPolicy;
};
```

## Adapter capability negotiation

Adapters should declare capabilities rather than forcing Anastom to assume parity:

```ts
type RuntimeCapabilities = {
  streaming: boolean;
  cancellation: boolean;
  resumableSession: boolean;
  nativeSubagents: boolean;
  mcp: boolean;
  lsp: boolean;
  debugger: boolean;
  browser: boolean;
  structuredOutput: "native" | "prompted" | "none";
  usageReporting: "tokens" | "cost" | "partial" | "none";
  sandboxing: string[];
};
```

Workflow policy may require or prefer capabilities.

## Event sourcing

Anastom should use an append-only event stream as its source of history.

Examples:

```text
RunCreated
WorkflowInstantiated
NodeReady
AttemptScheduled
AttemptStarted
RuntimeEventObserved
ArtifactProduced
EvidenceRecorded
VerifierStarted
VerifierPassed
VerifierFailed
CircuitBreakerOpened
NodeCompleted
NodeFailed
WorkflowCalled
WorkflowReturned
RunPaused
RunResumed
RunCompleted
```

Snapshots are optimization, not authority.

## Failure semantics

Failures should have categories:

- runtime unavailable;
- model/provider failure;
- tool failure;
- schema violation;
- verification failure;
- budget exhausted;
- policy violation;
- workspace conflict;
- human rejection;
- unknown/internal.

Policies can react differently to each category.

Do not let "failure" mean "ask the same model to try again."

## Circuit-breaker model

Possible deterministic inputs:

```text
attempt_count
same_verifier_failure_count
normalized_error_fingerprint
diff_similarity
files_touched
budget_consumed
time_elapsed
tool_call_loop_score
review_rejection_count
```

Actions:

```text
retry_same
retry_fresh_context
switch_model
switch_runtime
spawn_diagnostician
roll_back
request_human
fail_node
fail_workflow
```

## Context construction

Default context composition:

```text
system role contract
+ node objective
+ acceptance criteria
+ allowed mutations
+ selected source context
+ relevant durable artifacts
+ known evidence
+ verifier definitions
+ required output schema
+ budget
```

Explicitly exclude:

- unrelated parent transcript;
- failed reasoning branches unless relevant as evidence;
- sibling private scratchpads;
- superseded plans.

## Workspace strategy

Use git worktrees as the default implementation isolation primitive.

Possible modes:

- `readonly`: inspection only;
- `isolated`: dedicated branch/worktree;
- `shared-integration`: controlled integrator;
- `external`: runtime-managed sandbox.

A node must declare mutation intent.

## Persistence strategy

### MLP
SQLite + local filesystem.

Tables roughly:

```text
runs
workflow_instances
nodes
attempts
events
artifacts
evidence
workspaces
leases
usage
```

### Later
Abstract persistence behind repository interfaces.

Add:
- Postgres for shared state;
- Redis for low-latency coordination/eventing;
- Temporal for durable distributed workflows.

Temporal should implement Anastom semantics, not define them.

## Security posture

A runtime adapter is potentially executing arbitrary code.

Anastom should record:

- workspace;
- allowed tool classes;
- approval policy;
- environment exposure;
- secret references;
- network policy if available.

MLP can rely on local trust but should design contracts that allow later sandbox enforcement.

## Observability

Every attempt should produce:

- runtime/model;
- elapsed time;
- token/cost usage if available;
- tool/event counts;
- artifacts;
- diff statistics;
- verifier outcomes;
- retry/escalation reason.

Metrics should support future routing decisions.

## Architectural rule of thumb

If a new feature is only meaningful for one harness, it probably belongs in an adapter or capability plugin rather than `core`.
