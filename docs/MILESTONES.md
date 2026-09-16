# Milestones

Every milestone must produce something independently useful or demoable.

## M0 — Skeleton: "Anastom can describe work"

### Demo

Run:

```bash
anastom validate examples/workflows/hello.yaml
anastom graph examples/workflows/hello.yaml
```

and receive a validated typed workflow graph.

### Deliverables

- monorepo;
- core schemas;
- Workflow IR v0;
- methodology package format;
- CLI shell;
- fake runtime;
- event types;
- architecture decision records.

### Why it matters

This proves the core language before coupling to an LLM harness.

---

## M1 — Single worker: "Anastom can delegate one bounded task"

Status: complete. See [M1_EVIDENCE.md](M1_EVIDENCE.md) for deterministic checks, the controlled Pi/Anthropic demonstration, durable inspection, digests, and retained diff.

### Demo

On a small repository:

```bash
anastom run tasks/add-endpoint.md --runtime pi
```

Pi receives a fresh context envelope, modifies an isolated worktree, and returns a structured report. The control plane runs the independent command verifier and records acceptance.

### Deliverables

- Pi runtime adapter;
- context-envelope builder;
- worktree manager;
- command verifier;
- durable SQLite run/event store;
- `run`, `status`, `inspect`.

### Boundary

M1 has one agent worker and one deterministic command verifier. It retains one authoritative structured output per node and records context, diffs, logs, and verification output as artifacts. Cross-process inspection is required; recovery of work running during a crash remains M3.

The accepted implementation contract and completion evidence are in [M1_BUILD_BRIEF.md](M1_BUILD_BRIEF.md).

### Why it matters

First useful end-to-end slice.

---

## M2 — Portable worker: "The same contract runs somewhere else"

Status: complete after the owner's review of [PR #19](https://github.com/gsornsen/anastom/pull/19). The accepted contract is in [M2_BUILD_BRIEF.md](M2_BUILD_BRIEF.md), and the paired Pi/Codex demonstration, feasibility gates, CI, and durable replay are recorded in [M2_EVIDENCE.md](M2_EVIDENCE.md).

### Demo

Execute the exact same Task via:

```bash
--runtime pi
--runtime codex
```

and compare verified outcomes and public event evidence.

Runtime and model selection remain external to the unchanged Task. The accepted Codex CLI slice requires paired explicit provider/model selections; the brief gives the complete demonstration commands and capability preflight. Normalized traces share an event contract, not necessarily identical observations or implementation text. SDK reconsideration is [blocked in the backlog](https://github.com/gsornsen/anastom/issues/12) until the inspected limitations are disproven, resolved upstream, or justify an upstream contribution workstream.

### Deliverables

- Codex adapter;
- adapter capability negotiation;
- normalized event mapping;
- normalized usage/telemetry where available;
- conformance test suite for runtime adapters.

### Boundary

One selected worker and one independent command verifier. Capability negotiation checks that selected adapter; automatic routing and fallback remain M12. M2 records available token telemetry with explicit unknown/partial values, without estimating billing or adding cost-budget policy. Recovery remains M3.

### Why it matters

This is the architectural proof that Anastom is not another harness.

---

## M2.5 — Claude Code worker: "Another supported harness"

Status: complete and owner-accepted on 2026-09-15. [Issue #13](https://github.com/gsornsen/anastom/issues/13) is closed. [ADR 0015](adr/0015-claude-code-worker-profile.md) and the [M2.5 build brief](M2_5_BUILD_BRIEF.md) set the reviewed design; [native feasibility evidence](M2_5_FEASIBILITY.md) records model-free and synthetic checks; and [M2.5 completion evidence](M2_5_EVIDENCE.md) records the unchanged provider-backed Task, independent verifier, durable artifacts, clean source clone, and owner acceptance.

### Demo and deliverables

Run the unchanged Task through a Claude Code CLI and/or SDK adapter with the same shared conformance, independent verification, and durable inspection contract.

### Boundary

The source adapter invokes an end user's separately installed, unmodified Claude Code CLI with explicit subscription/API-key selection, without Anastom login, credential intermediation, request proxying, or resale. Subscription mode has Read/Glob/Grep/Write/Edit under the tested native profile; bare API-key mode exposed Read/Edit only, so new-file creation is unavailable there. The exact native installation, selected subscription form, ordinary customization exclusion, file confinement, and process ownership have model-free or synthetic evidence. The owner-approved subscription-backed run completed the unchanged Task and independent verifier. [ADR 0016](adr/0016-path-policy-after-third-adapter.md) records the narrow shared existing-child resolver added after comparing the third worker's distinct path rules and the PR's operator-file CodeQL findings.

---

## M3 — Durable execution: "Kill it and it comes back"

Status: design accepted by the owner on 2026-09-16 in [PR #23](https://github.com/gsornsen/anastom/pull/23). The [M3 build brief](M3_BUILD_BRIEF.md) and [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md) settle the recovery semantics while gating exact APIs on process-ownership, workspace, and SQLite feasibility evidence.

### Demo

Start a run, terminate the Anastom process during worker execution, restart, then:

```bash
anastom resume <run>
```

The workflow reconstructs state and continues as a newly numbered attempt only after the old owner, execution, workspace, and remaining budget are reconciled. Ambiguity pauses with evidence instead of starting a second worker.

### Deliverables

- snapshots;
- leases/attempt ownership;
- idempotent transition handling;
- resume semantics;
- orphan attempt detection;
- explicit pause/cancel.

### Why it matters

This is the first major differentiator from ordinary coding-agent wrappers.

---

## M4 — Defined SDLC: "Ship a real feature"

### Demo

Give Anastom a full-stack feature brief. It:

```text
analyzes -> plans -> decomposes -> parallelizes -> integrates -> reviews -> verifies
```

and produces a branch ready for human review.

### Deliverables

- `sdlc/default`;
- planner;
- bounded implementer;
- integrator;
- spec reviewer;
- code-quality reviewer;
- dependency-aware parallel task execution;
- integration worktree;
- evidence ledger.

### Why it matters

This is the first workflow that can replace a typical Superpowers-style execution for known work.

---

## M5 — Circuit breakers: "The agent cannot burn the night down"

### Demo

Inject a task that intentionally cannot satisfy a verifier. Anastom:

- detects repeated failure;
- stops mutation;
- snapshots evidence;
- invokes an independent diagnostician or escalates;
- never enters an unbounded fix/retry loop.

### Deliverables

- retry policies;
- repeated-failure fingerprints;
- token/cost/time budgets;
- mutation-scope constraints;
- escalation transitions;
- failure report.

### Why it matters

Directly addresses the class of failure that motivated Anastom.

---

## M6 — Hypothesis debugging: "Debug scientifically"

### Demo

Against a seeded non-obvious bug, Anastom records at least two plausible causes, runs experiments chosen to distinguish them, updates confidence, fixes the winning cause, and verifies the result.

### Deliverables

- `debug/hypothesis`;
- hypothesis/evidence schemas;
- experiment planner;
- belief/confidence updates;
- reproduction gate;
- discriminating-test policy;
- fix/verify transition.

### Why it matters

Shows that methodology is runtime semantics rather than prompt flavor.

---

## M7 — Delegated TDD: "Frontier brain, cheap hands"

### Demo

A strong planner derives interfaces and tests, then multiple cheaper workers independently implement bounded components. A strong reviewer validates integration.

### Deliverables

- `tdd/delegated`;
- role-to-model configuration;
- test-contract artifacts;
- task mutation boundaries;
- worker fan-out/fan-in;
- cost/usage report.

### Why it matters

Demonstrates economically useful heterogeneous model orchestration.

---

## M8 — Mycelium bridge: "Existing investment survives"

### Demo

Load selected Mycelium agents/skills into Anastom and execute at least one migrated workflow or role through a compatibility package.

### Deliverables

- Mycelium importer;
- agent metadata translation;
- skill/prompt migration tooling;
- compatibility documentation;
- mapping of Mycelium coordination concepts into Anastom events/artifacts.

### Why it matters

Avoids a flag-day rewrite and validates continuity.

---

## M9 — Specialist council: "Experts collaborate without groupthink"

### Demo

A cross-cutting architecture problem fans out to database, backend, security, frontend, and reliability specialists. They independently analyze, cross-critique, and synthesize a recommendation.

### Deliverables

- council primitive;
- private first-round contexts;
- shared evidence board;
- cross-critique round;
- synthesizer;
- unresolved-disagreement artifact.

### Why it matters

Adds collaboration without reducing everything to parent/child delegation.

---

## M10 — Adversarial tournament: "Competing paths earn the win"

### Demo

Three implementation/architecture candidates are produced independently and evaluated against a predefined rubric plus empirical checks.

### Deliverables

- candidate population primitive;
- advocate/attacker option;
- blind evaluator;
- tournament bracket or scoring;
- candidate revision loop;
- winner/decision evidence.

### Why it matters

Supports situations where multiple viable paths exist and premature convergence is harmful.

---

## M11 — Nested methodologies: "Engineering changes mode midstream"

### Demo

An SDLC workflow hits an unexplained test failure, enters `debug/hypothesis`, resolves the issue, then returns to the original implementation node.

### Deliverables

- nested workflow call/return;
- scoped state;
- artifact inheritance rules;
- budget inheritance;
- nested trace visualization.

### Why it matters

This realizes the central Anastom thesis that methodology is phase-local and composable.

---

## M12 — Adaptive routing: "Use the right substrate for the role"

### Demo

Anastom selects a runtime/model based on role requirements, cost, context, provider health, and historical eval performance.

### Deliverables

- capability registry;
- model/runtime catalog;
- routing policy interface;
- empirical performance records;
- fallback chains;
- reason-for-route trace.

### Why it matters

Turns model churn from a liability into an optimization opportunity.

---

# MLP boundary

The MLP target is approximately **M0 through M7**, with M8 highly desirable because it validates the migration story.

M9–M12 are the first post-MLP differentiators.

Do not delay the MLP for them.
