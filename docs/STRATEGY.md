# Anastom Strategy

## Strategic thesis

The coding-model market will remain volatile. Model quality, serving behavior, tool use, context management, and pricing will change faster than any stable engineering workflow should.

Therefore Anastom should not compete by having the best proprietary agent prompt or by coupling itself tightly to one model provider.

It should compete by becoming the **best place to encode and execute engineering process across models and harnesses**.

## Strategic positioning

Anastom sits above coding harnesses and below the developer's engineering intent:

```text
Developer / Team
      |
Intent, constraints, goals
      |
+-----------------------------+
|          ANASTOM            |
| workflow + policy + state   |
+-----------------------------+
      |
Runtime execution contract
      |
+------+------+------+--------+
| Pi   |Codex |Claude|Others  |
+------+------+------+--------+
      |
models / tools / sandboxes
```

## Who it is initially for

The first user is a senior or staff-level engineer, engineering manager, founder, or AI-native developer who:

- already uses coding agents heavily;
- delegates work that lasts hours or days;
- uses multiple models;
- cares about engineering methodology;
- wants deterministic guardrails;
- is comfortable with CLI tooling;
- is willing to configure workflows for leverage;
- values inspectability more than "one-click magic."

Do not optimize the MLP for first-time AI coding users.

## Wedge

The initial wedge is:

> **Reliable, resumable, methodology-driven multi-agent software work across more than one coding harness.**

The first differentiated experience should be a long-running engineering task that:

1. creates a typed plan;
2. dispatches isolated workers;
3. persists state outside any agent transcript;
4. verifies work deterministically;
5. survives interruption;
6. resumes correctly;
7. can run against two different harnesses without changing the workflow.

## What to preserve from Mycelium

Mycelium already demonstrates several ideas that should survive:

- large catalog of specialist agents;
- fast/lazy discovery rather than loading everything into context;
- multiple coordination modes;
- real-time event-based collaboration;
- durable workflow execution with Temporal;
- operational health/status concepts;
- hooks and event-driven automation;
- local-first analytics;
- explicit meta-orchestration.

Mycelium should be treated as a validated prototype and migration source, not technical debt to discard.

## What to deliberately change

### Move from Claude-native concepts to neutral concepts

Avoid making the new core depend on:

- Claude commands;
- Claude plugin manifests;
- Claude subagent semantics;
- Claude conversation state;
- Claude-specific hook events.

Use adapters to translate neutral Anastom concepts into each harness.

### Move from agent-centric to workflow-centric design

Mycelium's large specialist catalog remains useful, but Anastom's primary abstraction should be a workflow run and its state graph.

Agents are resources assigned to nodes.

### Move from prompt-defined orchestration to runtime-enforced orchestration

Models may recommend transitions, but policies should validate them.

### Move from global coordination to run-scoped namespaces

Every run should have isolated:

- state;
- artifacts;
- event history;
- budgets;
- workspaces;
- hypotheses;
- review records.

### Move from "context accumulation" to "context construction"

Each agent invocation should receive a deliberately assembled context envelope.

## Build strategy

### Phase A — prove the abstraction
Build the smallest workflow IR and runtime that can execute one workflow on Pi.

### Phase B — prove portability
Run the same workflow through Codex without changing workflow semantics.

### Phase C — prove durability
Interrupt a real multi-agent task, restart Anastom, and continue from durable state.

### Phase D — prove methodological value
Implement hypothesis debugging and delegated TDD as workflows using the same primitives.

### Phase E — prove collaboration
Add specialist council and adversarial tournament primitives.

### Phase F — prove adaptive routing
Route roles dynamically using model/harness capability and empirical run history.

## Technology strategy

### Primary implementation language: TypeScript

Reasons:

- Pi exposes a TypeScript SDK and extensions;
- TrueForge exposes a TypeScript SDK;
- OpenHands exposes TypeScript in addition to Python/REST;
- Temporal has a mature TypeScript SDK;
- strong schema tooling;
- easy JSON/YAML interoperability;
- appropriate for CLI, server, event-stream, and adapter development.

Python can remain a first-class worker/tool language, particularly for ML and evaluation, but it should not be required for the core control plane.

### Runtime: Node.js first; Bun-compatible where practical

Do not make Bun-specific behavior a core requirement initially. Optimize for broad compatibility and deterministic CI.

### Monorepo

Use a TypeScript monorepo so core contracts, adapters, workflow packages, CLI, and test fixtures can evolve together.

### Persistence

MLP:
- SQLite for runs, events, artifacts metadata, leases, and metrics;
- filesystem for large artifacts/workspaces.

Later:
- Postgres;
- Redis for real-time/distributed coordination;
- Temporal for long-duration workflows once the core semantics are stable.

Do **not** begin by requiring Temporal. First define Anastom's workflow semantics independently, then map them to Temporal.

### Schema system

Use runtime-validated schemas (e.g. Zod or equivalent) for every boundary:

- Workflow IR;
- execution request/result;
- evidence;
- events;
- hypotheses;
- role requirements;
- adapter capabilities.

The system should reject malformed agent output rather than "interpret it generously."

## Open-source strategy

The strongest open-source surface is:

- Workflow IR/specification;
- core runtime;
- reference CLI;
- runtime adapter contract;
- default methodologies;
- skills compatibility;
- eval harness;
- first-party Pi/Codex/Mycelium adapters.

This encourages an ecosystem of:

- methodology packs;
- role packs;
- harness adapters;
- evaluators;
- routing policies;
- observability integrations.

## Avoid these traps

### Building another universal agent SDK
Pi, TrueForge, OpenHands and others already do this.

Anastom should orchestrate them.

### Reimplementing every harness tool
Do not own editor/LSP/debugger/browser implementations unless the abstraction demands it.

### Porting all 130+ Mycelium agents first
Start with a tiny role catalog that exercises routing and workflow composition.

### Premature distributed architecture
Prove semantics in one process with SQLite. Then distribute.

### UI before reliability
An excellent trace/inspection CLI is enough for the MLP.

### Prompt-as-code without typed state
Prompts may be versioned assets, but they should not be the workflow engine.

## Success over the first year

Anastom is succeeding when:

- a workflow can run unchanged across 3+ harnesses;
- developers can write custom methodologies without modifying core;
- multi-day runs resume safely;
- expensive models are used selectively;
- cheap-worker delegation is measurably cost-effective;
- failures produce useful postmortems rather than runaway retry loops;
- model/harness regressions can be detected empirically;
- user-owned workflows remain stable despite provider changes.
