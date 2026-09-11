# Product Requirements — Minimum Lovable Product

## Product

Anastom

## MLP objective

Deliver a local-first CLI control plane that can execute a useful multi-agent engineering workflow through interchangeable coding-agent runtimes, preserve durable state outside agent transcripts, and enforce deterministic verification and failure policies.

The MLP should be useful on real repositories, not only demonstration tasks.

## Lovable moment

A developer runs:

```bash
anastom run feature.md --method sdlc --runtime pi
```

Anastom:

1. creates a durable run;
2. converts the selected methodology into an executable workflow graph;
3. assigns roles;
4. builds fresh context envelopes;
5. executes work in isolated worktrees;
6. gathers structured evidence;
7. verifies acceptance criteria;
8. pauses safely if intervention is needed;
9. resumes after process restart;
10. renders a concise trace explaining what happened.

The developer can then rerun the same methodology with:

```bash
anastom run feature.md --method sdlc --runtime codex
```

without rewriting the workflow.

That is the MLP.

## Primary use cases

### UC1 — Defined feature development

Given a concrete feature brief, execute:

```text
analyze -> plan -> decompose -> implement -> review -> verify
```

At least two implementation tasks may execute independently.

### UC2 — Hypothesis-driven debugging

Given a reproducible or partially reproducible defect:

- establish reproduction;
- generate multiple causal hypotheses;
- store each hypothesis structurally;
- run discriminating experiments;
- update confidence/evidence;
- converge only when exit criteria are satisfied;
- implement and verify a fix.

### UC3 — Delegated TDD

Use a strong planner/reviewer role while smaller workers implement bounded tasks against explicit test contracts.

The routing mechanism may be statically configured in the MLP. Dynamic learned routing is later.

### UC4 — Pause and resume

Kill the Anastom process during a run, restart it, and resume without asking an LLM to reconstruct the entire workflow from conversation history.

### UC5 — Runtime portability

At least one representative workflow must run via two independent runtime adapters.

Required: Pi and Codex.

Desired: Mycelium/Claude compatibility adapter.

## Functional requirements

### FR1 — Workflow IR

The system shall represent:

- workflow metadata/version;
- nodes/phases;
- dependencies;
- role requirements;
- inputs/outputs;
- entry/exit conditions;
- evidence contracts;
- execution policy;
- retry/escalation;
- mutation permissions;
- budgets;
- gates;
- nested workflow invocation.

MLP may defer complex loops to a simple transition API, but the IR must not prevent them.

### FR2 — Methodology packages

A methodology package shall contain:

- workflow definition;
- role definitions;
- prompt/context templates;
- schemas;
- evaluators;
- policy defaults;
- documentation.

MLP ships with:

1. `sdlc/default`
2. `debug/hypothesis`
3. `tdd/delegated`

### FR3 — Runtime adapter interface

Each adapter must expose capabilities and implement an execution contract similar to:

```ts
interface RuntimeAdapter {
  id: string;
  capabilities(): Promise<RuntimeCapabilities>;

  start(input: ExecutionRequest): Promise<ExecutionHandle>;
  events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent>;
  cancel(handle: ExecutionHandle): Promise<void>;
  collect(handle: ExecutionHandle): Promise<ExecutionResult>;
}
```

An adapter must not decide workflow policy.

### FR4 — Context envelope

Every worker invocation must be built from explicit components:

- goal;
- node/task contract;
- selected repository context;
- permitted workspace;
- relevant artifacts/evidence;
- role instructions;
- required output schema;
- verification commands;
- budget.

The default must be fresh context, not inherited parent transcript.

### FR5 — Structured outputs

Core workflow transitions must consume schema-validated outputs.

Examples:

- plan;
- hypothesis;
- experiment;
- review finding;
- verification result;
- task completion report.

Free-form prose may be attached but shall not be authoritative state.

### FR6 — Durable event log

Every meaningful transition shall append an event containing:

- run ID;
- node ID;
- attempt;
- event type;
- timestamp;
- actor/runtime/model identifiers;
- relevant artifact references;
- status/error metadata.

Replaying the event stream plus snapshots must reconstruct run state.

### FR7 — Workspace isolation

Implementation workers shall operate in isolated git worktrees by default.

The workflow may specify:

- read-only;
- branch/worktree;
- shared integration worktree.

### FR8 — Deterministic verification

Verification must be executable without asking the implementing agent whether work is correct.

Supported MLP verifiers:

- command exit status;
- test suite;
- lint;
- typecheck;
- file/diff constraints;
- structured reviewer rubric.

### FR9 — Circuit breakers

MLP shall support:

- maximum attempts per node;
- maximum model tokens or cost if usage data is available;
- wall-clock deadline;
- repeated-failure signature detection;
- maximum mutation scope;
- manual approval escalation.

A circuit breaker must produce a durable failure report.

### FR10 — Intervention

At minimum:

```bash
anastom status <run>
anastom inspect <run>
anastom pause <run>
anastom resume <run>
anastom cancel <run>
```

Optional MLP stretch:

```bash
anastom intervene <run> --message ...
```

### FR11 — Model/role mapping

MLP shall permit static config such as:

```yaml
roles:
  planner:
    runtime: pi
    model: anthropic/opus-5
    effort: high

  implementer:
    runtime: pi
    model: openai/gpt-5.6-sol
    effort: medium

  reviewer:
    runtime: codex
    model: gpt-5.6-sol
    effort: high
```

Workflow definitions may request capabilities instead of hardcoded models.

### FR12 — Traceability

`anastom inspect` must answer:

- What is the current goal?
- Which workflow/methodology is active?
- Which nodes are complete/running/blocked/failed?
- Which agent/model/runtime did each attempt use?
- What evidence caused each important transition?
- What remains before success?
- Why did the system retry/escalate/stop?

## Non-functional requirements

### Reliability
A process crash after any persisted transition must not corrupt the run.

### Reproducibility
Workflow package version, prompts/templates, relevant config, runtime/model identifiers, and verifier definitions should be recorded.

### Observability
All node attempts must expose elapsed time, model/runtime identity, status, and usage if available.

### Portability
Core packages must not import Pi-, Codex-, or Claude-specific types.

### Testability
A fake deterministic runtime adapter must allow workflow tests without calling an LLM.

### Local-first
The default MLP requires no hosted Anastom service.

## Explicit MLP non-goals

- polished graphical UI;
- cloud multi-tenancy;
- automatic model benchmark marketplace;
- arbitrary distributed worker cluster;
- Kubernetes;
- enterprise auth;
- full Mycelium agent catalog;
- autonomous methodology selection;
- learned model routing;
- collaborative real-time human editing;
- generalized non-software workflows.

## Acceptance criteria

The MLP is complete when all are true:

1. One non-trivial feature workflow completes against Pi.
2. The same workflow completes against Codex.
3. A run can be terminated and resumed from persisted state.
4. Two worker tasks can execute in isolated worktrees and integrate.
5. A worker that fails the same verifier repeatedly is stopped by policy.
6. `debug/hypothesis` maintains at least two competing hypotheses and records discriminating evidence.
7. `tdd/delegated` can use different configured models for planner and implementer roles.
8. `anastom inspect` provides a human-comprehensible execution trace.
9. Fake-runtime integration tests cover workflow transitions without external LLM calls.
10. A Mycelium migration note demonstrates how at least one existing Mycelium agent or workflow can be represented in Anastom.

## MLP quality bar

The product should feel safe enough that its author is willing to hand it a real repository overnight.

That requires fewer features and stronger runtime semantics, not more autonomous behavior.
