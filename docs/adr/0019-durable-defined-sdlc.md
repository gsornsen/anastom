# ADR 0019: Expand one durable graph and integrate scoped work through controller-owned Git operations

- Status: Accepted implementation direction for [issue #37](https://github.com/gsornsen/anastom/issues/37); completion requires the evidence in the [M4 build brief](../M4_BUILD_BRIEF.md)
- Date: 2026-09-17

## Context

The delivered product has two scheduling paths. `WorkflowEngine` executes a static graph sequentially with process-local persistence, while `DurableRunCoordinator` executes production Task nodes with leases, supervised attempt ownership, snapshots, controls, and crash recovery. A defined SDLC needs planner-driven decomposition, bounded concurrent workers, task-specific worktrees, integration, independent reviews, and final verification. Implementing those features in a separate methodology runner would create a third authority and make recovery and inspection depend on which entry point started the run.

Planner output is not safe scheduling authority. A model may emit duplicate or unsafe task IDs, cycles, excessive fan-out, overlapping mutation scopes, undeclared commands, or a plan whose ordering changes after restart. Git integration also introduces a mutation boundary distinct from a worker attempt: applying accepted changes to a shared branch must remain attributable and recoverable if the coordinator dies between preparing and recording it.

An interactive terminal experience needs live state, but a UI-specific event stream would risk becoming another source of truth or exposing runtime-private information.

## Decision

M4 converges production workflow execution on the fenced durable coordinator. A methodology-specific validator converts schema-valid planner output into a generic, bounded `WorkflowExpanded` event. That event carries the exact normalized generated nodes, order, source digest, and expansion digest. Events and snapshots reconstruct the graph without consulting a model or mutable package files.

One run lease continues to fence all mutations. The owner may supervise multiple independently identified attempts up to persisted concurrency policy. The event mutation stream remains serialized. Controls and recovery reconcile every active execution before the scheduler starts more work.

Each implementation task receives an owned isolated worktree rooted at the exact integration commit for its dependency wave. Ready tasks may run together only when their normalized mutation scopes are disjoint. The control plane checks the resulting changed paths and stores exact diff artifacts before accepting the task result.

The control plane integrates accepted diffs in normalized plan order through a prepared Git operation. It computes the tree and commit before moving the owned branch, persists the expected parent/result, compare-and-swaps the branch, synchronizes the inactive controller-owned worktree, and records the committed checkpoint. Recovery accepts only the recorded parent or result. Any other state pauses. Worker worktrees are never reset during this procedure.

The integrator remains a bounded model-backed role operating after deterministic patch integration. Specification and code-quality reviewers run independently with fresh, read-only contexts. Final acceptance depends on operator-authored command verifiers.

The evidence ledger and user-facing live stream are projections over authoritative events and artifact references. The projection exposes bounded public lifecycle/log/identity/usage evidence and excludes prompts, credentials, private reasoning, hidden tool bodies, and raw provider errors. CLI and later TUI clients consume the projection without owning workflow transitions.

## Consequences

- Static and expanded graphs share transition, persistence, recovery, and inspection semantics.
- Methodology packages can add structured planning without executing arbitrary model-authored commands or state changes.
- Parallelism increases coordinator complexity because controls, failure, and recovery fan in across active attempts.
- Same-wave disjoint scopes deliberately reject some useful plans. This preserves deterministic integration for the first production fan-out contract; broader conflict handling requires later evidence.
- Git integration gains its own prepared operation and exact recovery rules instead of hiding mutation in a prompt.
- Read-only policy must be enforced from `toolPolicy` even when a role inspects a physically isolated integration worktree.
- The terminal experience can evolve independently because it consumes a stable public projection.

## Rejected alternatives

### Keep the process-local engine and add parallelism only there

That would demonstrate fan-out without satisfying durable crash recovery, operator controls, or production runtime execution.

### Build a specialized SDLC coordinator beside the engine

That would duplicate scheduling, persistence, controls, rendering, and recovery, then force later methodologies to choose or reproduce the same machinery.

### Let the planner emit executable workflow YAML

Schema validation alone cannot authorize commands, budgets, paths, runtimes, or state transitions invented by a model. The planner emits bounded domain data; trusted code constructs executable nodes.

### Give all workers one shared worktree

Concurrent mutation would make attribution and recovery ambiguous and would weaken the existing isolation guarantee.

### Let an integrator agent copy or merge worker changes

This would make the model's filesystem behavior the only record of what entered the integration branch. Deterministic diff integration supplies provenance first; the integrator may then make bounded cross-task corrections.

### Persist a separate evidence-ledger database

A second mutable record could disagree with the authoritative event stream. A replayable projection preserves one source of truth.

### Build the TUI before the multi-node event contract

The view would encode transient single-worker assumptions and require structural rework once parallel attempts, integration, and review states appear. M4 supplies the projection and streaming CLI; [issue #38](https://github.com/gsornsen/anastom/issues/38) adds the interactive terminal after that surface stabilizes.
