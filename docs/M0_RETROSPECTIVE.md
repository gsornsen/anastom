# M0 Retrospective

## Delivered boundary

M0 implements the five-package TypeScript workspace described in the bootstrap brief:

- `core` parses YAML, validates the v0 document and graph, resolves local JSON Schema references, and produces normalized workflow types;
- `runtime-contract` defines a harness-neutral adapter lifecycle and typed requests, results, capabilities, failures, and events;
- `runtime-fake` selects deterministic results by node ID and attempt number;
- `engine` derives state from an append-only typed event stream, schedules dependency-ready nodes, applies retry policy, validates structured output, evaluates verifier results, and reloads runs from persistence;
- `cli` implements `validate`, `graph`, `run --fake-scenario`, and process-local `inspect`.

There are no model calls, harness integrations, worktrees, loops, fan-out, nested workflows, dynamic routing, SQLite, or UI code.

## Final IR decisions

The accepted document version is deliberately narrow: `anastom.dev/v1alpha1`, `Workflow`, metadata, an input map, an optional default attempt budget, and a node map. Unknown fields and node kinds are rejected so misspellings cannot silently become prompt-only policy.

Every node has one `output.schema` reference. Normalization resolves that reference relative to the workflow file and embeds the validated JSON Schema in the internal definition while preserving the authored reference. This gives every execution request the same structured-output boundary without introducing the artifact and state-mapping model that belongs after M0.

`agent` nodes require `role`. `command`, `gate`, and `verifier` nodes reject it because their M0 meaning is deterministic orchestration rather than a model capability profile. The normalized runtime request consequently adds `nodeKind` and makes `role` optional. This differs from the provisional request in `ARCHITECTURE.md`, which required a role for every execution.

Dependencies are node IDs in `needs`. Validation rejects missing nodes, self-dependencies, duplicates, and cycles. Declaration order is retained as `nodeOrder` and is the stable scheduling tie-breaker when several nodes are ready. M0 executes one ready node at a time.

The attempt policy supports `maxAttempts` and normalizes `maxDuration` to milliseconds. `maxAttempts` controls fake-run retries. The duration is carried into the runtime request but does not need an observable timeout in M0 because the fake adapter completes synchronously; timeout and cancellation races need a deliberate policy before a real adapter is connected.

Verifier output first passes the node's JSON Schema and must then contain a boolean `passed`. `false` is a typed `verification` failure and consumes an attempt. Other nodes succeed when the adapter succeeds and their output passes the declared schema.

Run and node state is reconstructed by replaying events. Event sequence numbers are the only ordering metadata in M0; wall-clock timestamps were omitted so identical inputs produce byte-for-byte equivalent event values. Persistence stores the immutable normalized workflow beside the event stream and uses optimistic sequence checks on append.

## Assumptions

Each declared input is required and unknown input names are rejected. JSON Schema governs the value itself. A later IR revision may need an explicit optional/default input policy.

The engine uses fail-fast behavior after retry exhaustion: the failed node becomes `failed`, every unexecuted node becomes `blocked`, and the run completes as `failed`. A runtime `blocked` result blocks the run without converting it to failure.

All four M0 node kinds cross the fake runtime boundary. This lets tests exercise the complete scheduler and adapter contract without prematurely defining shell execution, human approval, or verifier plugins.

`inspect` uses the in-memory persistence object and is therefore useful within one process or through the exported CLI function. A separate shell invocation cannot inspect a prior `run` command. This is the explicit process-local compromise allowed by the build brief; SQLite in M1 should make the command durable across invocations.

## Rejected alternatives

A second TypeScript-first validation model was rejected because it would duplicate the serialized IR contract. JSON Schema validation plus a small semantic graph pass keeps the authored boundary strict and the normalized types straightforward.

Snapshots and direct status writes were rejected. The reducer validates every event during live execution and replay, so corrupt or impossible histories fail at the same transition boundary.

Generic status-change events were rejected in favor of events such as `AttemptStarted`, `AttemptFailed`, and `NodeSucceeded`. The specific events retain the reason for each state change and permit tighter transition checks.

Artifact repositories, routing layers, command executors, gate providers, workspace abstractions, and model configuration were rejected for M0. None are needed to prove parsing, scheduling, adapter isolation, output validation, retry behavior, replay, or reload.

## M1 review resolution

The M1 contract review resolved these questions in `ARCHITECTURE.md`, `WORKFLOW_IR.md`, `docs/adr/`, and `M1_BUILD_BRIEF.md`.

`ExecutionRequest` includes the node kind and keeps role optional. A real runtime adapter executes agent nodes only. Deterministic command verification belongs to the control plane; general verifier and gate providers remain deferred.

The single schema-validated node output remains authoritative in M1. Diffs, worker reports, context envelopes, and command output are named artifacts rather than additional workflow outputs. Optional inputs, defaults, workflow state slots, and child mappings remain deferred with nested workflows.

M1 does not implement executable human gates. The fake runtime retains gate coverage only for M0 transition tests.

The control plane owns attempt deadlines. Timeout requests cancellation, consumes an attempt, and wins over a late result for authoritative state.

SQLite stores immutable normalized workflow JSON with a digest beside append-only events. Event sequence remains the transition ordering authority. M1 durability supports later-process inspection, while live-attempt recovery remains M3.
