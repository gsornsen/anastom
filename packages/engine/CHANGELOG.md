# @anastom/engine changelog

## Unreleased

- Settle retryable dirty failures by cancelling active siblings before pausing the whole run, and preserve exhausted failures as node/run failure even when the failed worker changed its workspace.
- Derive an immutable evidence ledger and bounded reconnect-equivalent live-event stream from authoritative workflow history, including runtime identity, usage, artifacts, workspace patches, integration, review, verification, and exact dropped-log accounting. Notify presentation observers only after durable commit without granting them workflow authority.
- Fold validated planner expansions into the durable graph, run independent attempts concurrently under one serialized event owner, fan controls and recovery across every active execution, assign task workspaces, accept scoped patch artifacts, and prepare/reconcile controller-owned integrations before review and verification.
- Keep event projection and execution terminal detail types internal while retaining the documented run, store, transition-error, and coordination contracts.
- Add `DurableRunCoordinator` with independent lease heartbeat, exact descriptor prevalidation/current preflight, fenced start ordering, runtime and command result handling, bounded control polling, control-plane duration deadlines, restart-safe control precedence, orphan/workspace reconciliation, snapshots, attempt budgets, and typed ownership refusal. Allow current scheduled/prepared attempts to bind immutable context and workspace-diff artifacts before authorization.
- Add the engine-owned `ExecutionHost` prepare/authorize/inspect/terminate boundary, exact digest-bound runtime and command launch plans, sanitized execution observations, and owned result/event handles.
- Add the engine-owned durable run-store contract, stable typed errors, snapshot and rolling-integrity helpers, and an in-memory implementation of production lease, fencing, idempotency, control, and fallback behavior.
- Add exact runtime configuration, prepare/authorize, control, cleanup, orphan, pause, and recovery-blocked events with replayed execution/checkpoint evidence. Apply the same owned-execution transitions to runtime and command attempts.
- Resolve verifier working directories through the shared canonical-root existing-child policy, preserving internal-symlink behavior and rejecting escapes.
- Preflight selected worker capabilities before durable creation; persist versioned negotiation, sanitized identity, and at most one partial/complete usage observation through append-only events and replay.
- Preserve a sanitized typed runtime policy rejection when a worker refuses to start, and stop retrying that attempt.
- Render unavailable and partial counters explicitly while keeping verification and historical event histories independent of telemetry.
- Add fresh frozen contexts, bounded independent verification, timeout diagnostics, and artifact observations.
- Keep orchestration harness-independent and replay validated typed transitions.
- Expose readable evidence rendering and named context construction options.
- Reject inherited object keys when resolving validated node events during replay.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
