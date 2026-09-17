# @anastom/engine changelog

## Unreleased

- Add `DurableRunCoordinator` with independent lease heartbeat, exact descriptor prevalidation/current preflight, fenced start ordering, runtime and command result handling, bounded control polling, control-plane duration deadlines, restart-safe control precedence, orphan/workspace reconciliation, snapshots, attempt budgets, and typed ownership refusal. Allow current scheduled/prepared attempts to bind immutable context and workspace-diff artifacts before authorization.
- Add the engine-owned `ExecutionHost` prepare/authorize/inspect/terminate boundary, exact digest-bound runtime and command launch plans, sanitized execution observations, and owned result/event handles.
- Add the engine-owned M3 durable run-store contract, stable typed errors, snapshot and rolling-integrity helpers, and an in-memory implementation of production lease, fencing, idempotency, control, and fallback behavior.
- Add exact M3 runtime configuration, prepare/authorize, control, cleanup, orphan, pause, and recovery-blocked events with replayed execution/checkpoint evidence. Preserve exact legacy lifecycle shapes and apply the same owned-execution transitions to runtime and command attempts.
- Resolve verifier working directories through the shared canonical-root existing-child policy, preserving internal-symlink behavior and rejecting escapes.
- Preflight selected worker capabilities before durable creation; persist versioned negotiation, sanitized identity, and at most one partial/complete usage observation through append-only events and replay.
- Preserve a sanitized typed runtime policy rejection when a worker refuses to start, and stop retrying that attempt.
- Render unavailable and partial counters explicitly while keeping verification and historical event histories independent of telemetry.
- Add fresh frozen contexts, bounded independent verification, timeout diagnostics, and artifact observations.
- Keep orchestration harness-independent and replay validated typed transitions.
- Expose readable evidence rendering and named context construction options.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
