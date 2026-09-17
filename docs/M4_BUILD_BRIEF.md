# M4 build brief — Defined SDLC

## Status and mission

This document defines the delivered behavior targeted by [issue #37](https://github.com/gsornsen/anastom/issues/37). Pull-request metadata records implementation progress; this brief describes the durable product boundary that remains accurate after merge. Completion requires the deterministic and live evidence listed below.

Given one strict feature brief and one explicitly selected runtime/model, Anastom must analyze the repository, produce a bounded structured plan, expand that plan into a durable dependency graph, execute independent implementation tasks concurrently in isolated worktrees, integrate accepted changes deterministically, obtain independent specification and code-quality reviews, run operator-authored verification commands, and retain one integration branch ready for human review.

The same feature brief and `sdlc/default` methodology must run through Pi and Codex without changing workflow policy. M4 continues to use one selected runtime/model for every model-backed role; heterogeneous role routing remains M7.

## Ambiguities resolved before implementation

### Product input

M4 adds a strict Markdown `Feature` document instead of overloading the single-worker `Task` contract. YAML front matter owns identifiers, acceptance criteria, verification commands, task/concurrency limits, and attempt duration. The Markdown body is the objective. Prose cannot add commands, widen mutation scope, select a runtime, or alter budgets.

Feature policy may name normalized repository-relative protected paths for operator-owned verifier programs or other immutable inputs. The CLI always adds the Feature document and any methodology resources that live in the target repository. Command arguments are never guessed to be paths; methodology resources installed outside the target repository are retained by their content-addressed snapshot and cannot be reached by target-repository patches.

The CLI form is:

```bash
anastom run feature.md --method sdlc/default --runtime pi
```

Runtime-specific provider/model/authentication flags remain explicit CLI configuration and are persisted through the existing credential-free descriptor boundary.

### Methodology is versioned content

`sdlc/default` is a checked-in methodology package containing a manifest, role definitions, prompt templates, JSON Schemas, and documentation. The loader resolves every referenced regular file beneath one canonical package root, applies byte/count limits, rejects unknown fields and symlink escapes, and produces a canonical snapshot and digest before a run is created. Execution uses the persisted snapshot rather than rereading mutable package files after restart.

The package defines six semantic roles:

- analyst;
- planner;
- bounded implementer;
- integrator;
- specification reviewer;
- code-quality reviewer.

Roles remain model-neutral. The selected runtime adapter renders the explicit context envelope; methodology prompts do not invoke harness-native subagents, hidden sessions, or provider tools outside the adapter profile.

### Planner output is data, not authority

The planner returns a schema-valid `FeaturePlan` containing a summary and between two and eight tasks. Each task has a safe stable ID, objective, acceptance criteria, dependencies, and one or more repository-relative mutation scopes. The control plane additionally validates:

- every dependency names another task;
- the task graph is acyclic;
- task order is stable;
- every scope is relative, normalized, nonempty, and free of traversal;
- concurrently executable tasks have disjoint scopes;
- configured task and concurrency limits are respected.

The model never creates events, chooses node status, assigns workspaces, selects execution order, or updates the graph directly.

After plan validation, the control plane emits one `WorkflowExpanded` event containing the exact normalized node definitions, stable node order, source plan digest, and expansion digest. Replay reconstructs the same graph without invoking a model or rereading a methodology. Expansion is allowed once, from the configured planner node, before any generated node starts. A mismatched replay or duplicate expansion is corrupt history.

Generated implementation node IDs are `implement.<task-id>`. The control plane adds integration, specification-review, quality-review, and verification nodes from the persisted methodology snapshot. Generated nodes use the same normalized `WorkflowNode` contract as authored nodes; expanded definitions live in authoritative event history and the folded state.

### One durable graph path

The production durable coordinator becomes the authoritative executor for both static and expanded graphs. The fake runtime uses that path for deterministic M4 acceptance. The earlier process-local engine may remain only while an explicit current demo or test still requires it; once callers migrate, its persistence wrappers, scheduler loop, and compatibility-only tests are deleted under the implementation Definition of Done.

The run retains one fenced owner and serialized event mutation stream. That owner may supervise up to `maxParallel` independently identified attempts at once. Each attempt keeps the existing prepare, persist, authorize, inspect, terminate, timeout, orphan, and workspace-checkpoint contract. Concurrency never permits two writers to the same workspace.

Ready selection is deterministic:

1. fold all committed transitions;
2. identify dependency-satisfied pending nodes in persisted node order;
3. select at most the remaining parallel capacity;
4. prepare and authorize each selected attempt in node order;
5. accept terminal observations in completion order while preserving each attempt's identity;
6. make later scheduling decisions only from committed state.

Runtime completion order may differ between runs. Node identity, dependency rules, integration order, and final evidence ordering remain deterministic.

### Workspace topology

One feature run owns:

- an integration worktree and branch rooted at the source base commit;
- one isolated implementation worktree per active task, rooted at the exact integration commit established for that dependency wave;
- read-only execution policy for analysis, planning, and review attempts against the relevant clean worktree.

Physical worktree isolation and mutation authorization are separate. A read-only role may inspect an isolated integration worktree, but its request disables mutations and the runtime profile must select read-only tools/sandboxing. Exact before/after checkpoints prove that it remained unchanged.

Workspace IDs, paths, branches, base commits, manifests, and node assignment enter durable state before execution. Branch and directory segments derive only from validated run/node identifiers through the private-path and workspace capabilities.

### Mutation scope and worker acceptance

An implementation attempt succeeds only after:

- its structured report passes the methodology schema;
- the final workspace checkpoint is complete;
- every changed path is inside one declared task scope;
- protected feature, methodology, and verifier inputs are unchanged;
- the workspace contains no unaccounted ownership change;
- the exact binary-capable diff is stored as an immutable artifact.

The report is evidence, not proof that the change is correct. Final command verification remains independent.

### Deterministic integration

Successful task diffs are integrated by the control plane, never by trusting a worker report. Tasks in one dependency wave are applied in normalized plan order. Same-wave scopes are disjoint; an apply failure or unexpected overlap becomes a typed integration conflict and stops automatic mutation.

Integration uses a controller-owned Git operation:

1. verify the integration workspace identity, clean state, and expected parent commit;
2. apply exact accepted diff artifacts to a temporary Git index;
3. compute the resulting tree and deterministic commit object without moving the branch;
4. persist `IntegrationPrepared` with parent, source artifact digests, tree, and expected commit;
5. compare-and-swap the owned integration branch from the parent to the expected commit;
6. synchronize the inactive controller-owned worktree to that exact commit;
7. persist `IntegrationCommitted` and a complete checkpoint.

Recovery accepts only the recorded parent or expected commit. At the parent it may repeat the compare-and-swap. At the expected commit it may restore the inactive controller-owned worktree and finish the recorded transition. Any other ref, worktree, manifest, or registration state pauses with evidence. This narrow synchronization rule does not authorize resetting a worker-owned workspace or arbitrary user changes.

Dependency-ready tasks in a later wave branch from the committed integration head containing their predecessors. Implementation worktrees remain retained for review.

### Integrator and independent review

After all task diffs enter the integration branch, one bounded integrator attempt may make cross-task corrections in that branch. Its context includes the feature contract, accepted plan, task reports, exact diff references, and integration history. It does not receive private worker reasoning or transcripts. Its final diff is checked and recorded like any other mutating attempt.

The specification and code-quality reviewers then run concurrently with fresh contexts and read-only mutation policy against the exact integrated commit:

- the specification reviewer compares the feature objective and acceptance criteria to the integrated result and evidence;
- the code-quality reviewer evaluates correctness risks, maintainability, tests, repository conventions, and unnecessary complexity.

Each produces a bounded structured review with `approved`, findings, evidence references, and a summary. A rejected review fails the M4 run with retained evidence. Automatic review-repair loops and repeated-failure policy belong to M5.

### Verification

Only operator-authored commands from the feature document execute as final deterministic verifiers. They run without a shell, in declared order, against the integration worktree. Every command has an argv vector, relative working directory, time limit, and output limit. All must pass. Planner, implementer, integrator, and reviewer prose cannot add or replace verifier commands.

### Evidence ledger and live projection

The evidence ledger is a deterministic projection over authoritative events and immutable artifact references. It is not a second mutable database. For every phase it exposes the decision, actor/runtime/model identity, input context digest, output/report reference, workspace/diff evidence, usage when available, and the evidence that permitted the next transition.

M4 also exposes a bounded public live-event projection suitable for newline-oriented CLI streaming and later terminal rendering. It includes run/node/attempt identity, public lifecycle state, bounded runtime log messages, public provider/model metadata, usage observations, integration/review/verification transitions, and dropped-message counts. It excludes prompts, private reasoning, credentials, hidden tool bodies, raw provider errors, and unbounded output. Replaying durable history produces the same user-facing state after reconnect.

The full-screen terminal client tracked in [issue #38](https://github.com/gsornsen/anastom/issues/38) consumes this projection after the M4 event model stabilizes. It remains outside workflow authority.

## Failure and control semantics

Pause or cancel applies to the whole run. The coordinator records the control once, requests cancellation for every active execution, observes each cleanup result, and reaches the requested run state only after no active attempt remains. Unknown cleanup produces recovery-blocked state naming every unresolved execution.

After coordinator loss, recovery reconciles all prepared, running, or orphaned attempts independently before scheduling any replacement. One ambiguous execution prevents new mutation but does not erase confirmed results from siblings. Replacement attempts consume their authored budgets and use fresh contexts.

One task failure exhausts its node budget, blocks dependents, cancels still-active siblings, and fails the run after cleanup. M4 does not repeatedly replan, automatically relax scopes, or ask another model whether to ignore a failed verifier.

## Package boundaries

| Area                         | Responsibility                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anastom/core`              | Feature and methodology documents, normalized plan/expansion contracts, schemas, validation, and canonical digests.                                      |
| `@anastom/engine`            | Expanded event/state/reducer contracts, deterministic ready selection, bounded concurrent orchestration, evidence/live projections, and recovery policy. |
| `@anastom/workspaces`        | Run-scoped worktree topology, exact scoped-diff validation, deterministic Git integration preparation/application/reconciliation, and ownership checks.  |
| `@anastom/persistence`       | Existing fenced event/snapshot authority; schema changes only if evidence proves event payloads and snapshots cannot carry the new state safely.         |
| `@anastom/runtime-contract`  | Existing one-attempt runtime boundary plus the public live observation types needed by projections; no scheduler policy.                                 |
| runtime adapters             | Execute one explicit attempt with correct mutation policy and public observations; no planning, fan-out, integration, or review authority.               |
| `@anastom/cli`               | Feature/method/runtime selection, service composition, streaming output, controls, inspection, and stable exit behavior.                                 |
| `methodologies/sdlc/default` | Versioned prompts, roles, schemas, defaults, and documentation composed from generic control-plane primitives.                                           |

## Implementation stack

1. Close M3 status language and record this brief, ADR, issue, and terminal-experience boundary.
2. Prove model-free graph expansion, concurrent execution/recovery, and deterministic Git integration/recovery against disposable repositories.
3. Add strict Feature, methodology, plan, review, expansion, and projection contracts with schemas and focused validation tests.
4. Extend workspaces for run-scoped integration and task worktrees, mutation-scope enforcement, and prepared Git integration.
5. Extend events, reducers, snapshots, scheduling, control, and crash recovery for expanded graphs and multiple active attempts.
6. Add the evidence ledger and live-event projection; stream it through a TTY-aware and pipe-safe CLI renderer.
7. Add the checked-in `sdlc/default` package and compose Feature execution through the production CLI.
8. Run the deterministic full workflow and process-level crash matrix, including parallel completion orders, controls, stale fences, integration interruption, review rejection, verifier failure, and source cleanliness.
9. Run the unchanged Feature through owner-authenticated Pi and Codex selections, retain integration branches and evidence, and write `docs/M4_EVIDENCE.md`.
10. Audit and delete superseded source, wrappers, tests, fixtures, exports, dependencies, and current documentation; update package READMEs/changelogs, root README/changelog, architecture, roadmap, Changesets, and API docs.

The stack remains reviewable as focused PRs targeting the M4 feature branch. It is consolidated into one main-targeting feature branch only after deterministic and live evidence is complete.

## Required deterministic evidence

- strict Feature and methodology parsing, canonical snapshots, path confinement, and digest stability;
- plan bounds, ID/scope validation, cycle rejection, disjoint-ready-scope enforcement, and deterministic expansion replay;
- scheduler capacity, dependency waves, different completion orders, sibling failure cancellation, and serialized event mutation;
- two or more active execution identities, pause/cancel fan-in, crash reconciliation, stale fencing, orphan accounting, and no replacement under ambiguity;
- unique owned worktrees, exact bases, protected-path enforcement, retained diffs, deterministic integration commits, compare-and-swap refusal, and interrupted-integration recovery;
- fresh reviewer contexts, read-only enforcement, structured rejection, independent verifier authority, and evidence-ledger derivation;
- bounded live output, dropped-message accounting, reconnect equivalence, non-TTY rendering, and absence of private sentinels;
- complete fake `sdlc/default` success from a Feature brief to a retained integration branch;
- Linux and macOS CI, typecheck, lint/JSDoc, formatting, hygiene, dead-code passes, API docs, DCO, dependency review, and CodeQL.

## Required live evidence

Use one fresh controlled fixture whose feature requires at least two genuinely independent implementation tasks. Run the unchanged Feature and methodology through:

```bash
--runtime pi
--runtime codex --provider openai --model <owner-selected-model>
```

The Pi selection may use its configured provider/model; both effective identities must be recorded. Codex requires an explicit model and reasoning effort. Each run must show at least two overlapping active worker intervals, deterministic integration, independent structured reviews, passing operator-authored verification, a clean source checkout, a retained reviewable integration branch, complete bounded artifacts, and no credential or private-reasoning persistence.

## Explicitly deferred

- M5 repeated-failure fingerprints, token/cost budgets, diagnostics, and repair/escalation loops;
- M6 hypothesis entities and experiments;
- M7 role-specific runtime/model configuration and delegated TDD;
- human approval gates beyond existing operator pause/cancel/resume;
- automatic merge into or reset of an operator branch;
- provider-session adoption or transcript continuation;
- distributed workers, remote queues, and multi-host leases;
- arbitrary loops, nested methodologies, and general expressions;
- overlapping same-wave mutation scopes or automatic semantic conflict resolution;
- a full-screen TUI, web UI, or hosted service.
