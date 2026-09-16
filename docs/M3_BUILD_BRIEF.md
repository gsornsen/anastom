# M3 build brief — Durable execution

## Status and mission

**Accepted by the owner on 2026-09-16 under [issue #22](https://github.com/gsornsen/anastom/issues/22) and [PR #23](https://github.com/gsornsen/anastom/pull/23).** [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md) records the accepted boundary. The recovery semantics are approved; exact runtime and persistence API shapes remain gated on the feasibility evidence below and must revise this brief if that evidence contradicts it.

Make a durable Task run survive abrupt coordinator termination. A later Anastom process must reconstruct the run, reject stale ownership, account for the interrupted attempt, preserve its evidence, and either continue as a fresh bounded attempt or stop with a precise reason why continuation is unsafe.

M3 extends control-plane durability. It does not add another model integration, provider-session adoption, distributed workers, parallel scheduling, a human-approval UI, or M4 workflow behavior.

## Decisions to challenge in review

| Question                          | Proposed M3 boundary                                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does `resume` recover?       | Workflow control and a safe scheduling point. It never continues under the old attempt identity and does not promise provider-session reattachment.                                                                                                             |
| When may ownership transfer?      | After lease expiry and proof that the recorded local owner process identity is absent. A fencing generation rejects every later write from the old owner.                                                                                                       |
| What happens to partial edits?    | Preserve and capture them, then pause. Automatic retry requires the worktree to match its exact pre-attempt checkpoint. Ordinary resume never resets a worktree.                                                                                                |
| Does a crash consume an attempt?  | Yes. An orphan remains a numbered attempt and counts against `maxAttempts`; otherwise repeated coordinator failure could create unbounded model calls.                                                                                                          |
| Are snapshots authoritative?      | No. Events remain authoritative. Versioned, checksummed snapshots are rebuildable caches whose state must equal full replay.                                                                                                                                    |
| How are runtime flags restored?   | A sanitized adapter-owned descriptor records only public reconstruction fields. Credentials stay in the user's existing tool-owned stores, and preflight runs again.                                                                                            |
| How do controls reach a live run? | A deduplicated SQLite control request can be submitted without stealing the run lease. The owner records and processes it; a replacement owner handles it after a crash.                                                                                        |
| What does idempotency cover?      | Anastom transition batches and control requests. It does not claim exactly-once model, tool, command, filesystem, or network side effects.                                                                                                                      |
| Which runtimes are resumable?     | Only adapters whose model-free process-ownership probe can identify and stop an execution after coordinator death. Every current adapter must report its evidence-backed status; unsupported recovery fails closed rather than inheriting a generic capability. |

## Demonstration contract

The checked-in demonstration uses a deterministic runtime fixture and a temporary Git repository. It makes no provider request and reads no authentication store.

1. Start a durable Task whose worker budget permits two attempts.
2. Wait for an explicit fixture signal proving the first attempt has started and its execution identity and workspace checkpoint are durable.
3. Send `SIGKILL` to the Anastom coordinator while the fixture worker is active. Do not infer readiness from a sleep.
4. Show that status from another process reports the running attempt and its expired-or-live ownership state without starting work.
5. Before expiry, prove another process cannot acquire the run. After expiry, prove it can acquire only after the old process identity is absent.
6. Run:

   ```bash
   anastom resume <run> --state-dir <repo>/.anastom
   ```

7. Reconcile the old execution, record one orphaned attempt, verify the workspace equals its checkpoint, and schedule attempt two with fresh context.
8. Complete the independent command verifier and inspect the successful run from a third process.
9. Prove the first fencing generation cannot append after takeover, all event sequences remain contiguous, snapshot-plus-tail equals full replay, and all referenced artifacts pass digest checks.

A second deterministic case changes the worktree before coordinator death. Resume must retain and capture the diff, record a typed workspace conflict, and pause without starting attempt two. A third case leaves the old execution's termination state unknown; it must also stop without a replacement worker.

The process-level demonstration belongs in a repository script and ordinary fixture files. It must not embed executable programs as multiline strings, call a real model, depend on fixed sleeps, or require network access.

## Proposed state and transition model

The implementation may refine event names during review, but it must represent these concepts explicitly and validate them before persistence:

- a sanitized runtime descriptor selected before the first attempt;
- a stable execution ID persisted before runtime side effects;
- a pre-attempt workspace checkpoint;
- ownership acquisition or takeover generation where it affects history;
- pause/cancel request and cleanup outcome;
- an orphaned attempt with the lost ownership generation and classified reason;
- preserved post-crash workspace evidence;
- run resumption or typed refusal to resume.

`AttemptStatus` gains an orphaned terminal state. Orphaning is valid only for the current running attempt after the caller owns a later fencing generation and execution absence is confirmed. It may happen once. It does not rewrite the attempt as failed or cancelled.

A replacement uses the next attempt number. The scheduler emits the existing resumed-ready meaning only after orphan and workspace reconciliation. It then applies the authored `maxAttempts` exactly as it does for ordinary attempts.

Run projections must expose enough public state for `status` and `inspect` to distinguish:

- owned and progressing;
- paused by request;
- cancellation requested but cleanup not yet confirmed;
- waiting for lease expiry;
- old owner still alive;
- orphan execution absent and safe to retry;
- execution state unknown;
- workspace conflict;
- attempt budget exhausted;
- terminal cancellation.

Diagnostics may include public IDs, generations, times, and classified reasons. They may not include credentials, environment dumps, prompts, private runtime frames, reasoning, tool inputs, or raw provider errors.

## Ownership and persistence contract

### Lease rules

The durable store adds an ownership interface separate from read-only inspection. A lease token contains the run ID, opaque owner ID, and fencing generation. The backing row also records an opaque local host/boot identity, PID, and process-start identity, but those values confer no authority by themselves.

- Creating a durable run acquires generation one before scheduling work.
- Only the current token may renew or release its lease.
- Every execution-changing append presents the token; read-only status/inspect requires none.
- A token whose owner or generation differs fails with a typed ownership error before event validation.
- Takeover increments the generation atomically and never reuses one.
- Expired plus live owner means no takeover.
- Expired plus absent owner permits takeover and subsequent execution reconciliation.
- Unknown liveness fails closed.
- A released lease may be acquired without waiting for its former expiry, while the generation still increases.

The production clock uses UTC epoch time from the local host. Tests inject time. A forward or backward wall-clock jump cannot authorize concurrent work because owner-liveness and fencing checks remain mandatory.

### Idempotent append rules

Every fenced mutation has a unique mutation ID and canonical payload digest. In the same transaction as its events, SQLite records the ID, digest, and resulting sequence range.

- First use validates the complete transition, appends the batch, and records the range.
- Same ID and same digest returns that range without another append.
- Same ID and different digest is a conflict.
- A stale fencing generation is rejected even when its event sequence happens to match.
- Ordinary optimistic expected-sequence validation remains in force.

The in-memory store implements the same observable rules for focused engine tests. SQLite multi-process tests establish the production transaction behavior.

### Snapshot rules

Snapshots are canonical JSON projections with a snapshot schema/reducer version, event sequence, and SHA-256 digest. The SQLite migration is additive; existing run and event rows remain unchanged.

The engine writes snapshots at initial scheduling, attempt-terminal transitions, completed pause/cancel transitions, and terminal run completion. It may coalesce a snapshot with the transition transaction. Runtime log, metadata, and usage observations do not each create one.

The execution loader may use the newest compatible valid snapshot and replay later events. The inspection loader can still return the complete history. Unknown versions, digest mismatch, malformed state, a sequence beyond the event tail, or a tail transition that contradicts the snapshot causes the loader to ignore it and perform full replay. A fenced owner may replace the cache later; read-only status and inspection do not mutate it. Corrupt events still fail, so a bad snapshot cannot turn them into a valid run.

Compatibility tests open an M1, M2, and M2.5 fixture database, replay it without a snapshot, build one, reopen it, and obtain the same projection and definition digest.

### Control request rules

`pause` and `cancel` submit an operation ID and action to a unique per-run inbox; SQLite assigns the recorded request time. A duplicate ID with the same action returns the existing request; another action conflicts. The row contains no arbitrary message or environment data.

The current owner notices the request while an adapter or command is active, appends the corresponding typed intent under its lease, and requests cleanup once. If the owner dies, takeover processes the oldest pending request before orphan retry. Event state, rather than a mutable request status, decides whether the operation completed.

`resume` is an ownership operation rather than a message to an active owner. It rejects a live owner, acquires a resumable paused/released/expired run, and uses an operation ID for its transition batches.

The model-free SQLite contention phase implements these rules in a temporary checked-in schema without changing the production migration or package contract. On the owner macOS host, pairs of real processes under `BEGIN IMMEDIATE` produced exactly one initial owner, one expired takeover winner, and one post-release generation-three owner. Current renewal succeeded while stale renewal and release failed. Concurrent identical mutation IDs returned one physical append and the same sequence range; a changed digest conflicted; wrong expected sequence left no partial event; and both pre-takeover and post-release generations were fenced from later appends. Duplicate control ID/action pairs returned one SQLite-assigned timestamp and row, while competing actions for one ID produced one winner and one conflict. Linux and clean macOS CI remain required for this phase.

The probe confirms that process liveness remains an input to takeover rather than a fact inferred from SQLite. After an external `absent` conclusion, the transaction still compares the observed owner, generation, expiry, and release state. Fence validation occurs before idempotent mutation replay, so an earlier generation cannot reuse a successful operation ID. The exact schema, error classes, and TypeScript signatures remain gated on workspace and snapshot evidence.

## Runtime and process-ownership contract

Before public TypeScript signatures are frozen, a feasibility probe must exercise Pi, Codex, Claude Code, and command execution with model-free doubles. For each adapter it records:

- the point at which an engine-generated execution ID becomes durable;
- whether any provider or command side effect can occur before that point;
- coordinator, direct child, process-group, and descendant identity on Linux and macOS;
- behavior after `SIGTERM`, `SIGKILL`, timeout, and coordinator loss;
- how a later process distinguishes active, absent, and unknown without PID-reuse mistakes;
- whether termination confirmation covers descendants and how long bounded cleanup takes.

The first process-ownership probe is recorded in [M3 feasibility](M3_FEASIBILITY.md). It rejects persisting the current adapter handle or direct native leader PID as the complete recovery boundary: every current owner left a descendant after coordinator `SIGKILL`, and a separate leader-exit case retained a live group that its former leader identity could no longer authorize. A shared parent-death supervisor prototype cleaned a TERM-resistant leader and descendant on the owner macOS host and on Ubuntu 24.04/macOS 15 CI in PR #24.

The second production-shaped probe implements that shared attempt supervisor without cementing vendor-specific `inspectExecution()` methods or exporting its temporary types. It uses an engine-shaped execution UUID, run-owned atomic manifest, separate private random capability, two-phase start handshake, verified coordinator/boot identity, fence binding, and bounded framed IPC. Pi runs inside the supervisor process, which provides its out-of-process host relative to the coordinator. Across the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI in stacked PR #25, all four owners pass successful relay, authenticated inspection, cancellation, and coordinator-death cleanup. Tampered control data fails closed. Deliberate supervisor `SIGKILL` leaves an active command group and correctly produces `unknown`, so a replacement start remains forbidden. A gated launch test also persists `starting` before the first possible side effect and proves that supervisor loss in that state is unknown; this closes the launch-before-`active` publication race conservatively. Exact public names remain gated, but later implementation may not weaken these outcomes:

- the execution ID is known and persisted before side effects;
- a supervisor identity is recorded under the current fence before worker launch is authorized;
- inspection is model-free and does not read credential values;
- `absent` is affirmative evidence, not a missing in-memory map entry;
- `terminate` resolves only after the owned execution tree is gone;
- `unknown` prevents retry;
- a runtime advertises recovery support only after its concrete lifecycle passes the probe.

Pi's SDK and the two external CLIs may need different runtime-host protocol code, but OS ownership stays in the shared supervisor. Vendor process layouts do not enter the engine. A bare numeric PID, process-group ID, or low-resolution `ps` start time is never enough: authority combines same-host/boot identity, the strongest portable process identity available, a supervisor-issued random execution capability, execution ID, fence, and run-owned manifest. Recovery fails closed if that evidence cannot authenticate the intended process.

The capability is operational authority. Store it only in a private run-owned control record and put its digest in sanitized manifests and start authority. A confirmed terminal record proves absence only when its execution ID and fence match, its cleanup result is confirmed, and the authenticated supervisor is absent. An active manifest with a missing supervisor remains `unknown`; fencing alone cannot make another external execution safe.

Command execution follows the same ownership rule. A verifier that survived its coordinator is an external effect boundary and must be stopped or classified unknown before it can be run again.

## Runtime reconstruction contract

The CLI registry reconstructs an adapter from a versioned sanitized descriptor stored before attempts begin:

```text
runtimeId + descriptorVersion + adapter-owned public configuration
```

Expected public fields include explicitly selected provider/model, Codex reasoning effort, and Claude Code authentication-source mode. Pi must persist the effective selected provider/model even when it originally came from Pi's default configuration. A descriptor cannot use ambient defaults during resume.

The CLI validates the descriptor schema before lease acquisition. After acquiring ownership, it runs the adapter's full current preflight before scheduling an attempt. Missing installed binaries, changed managed policy, missing authentication availability, incompatible adapter versions, or weaker capabilities produce a typed paused/blocked result under the current fence with no attempt start.

Fake scenario file paths are not durable runtime configuration. The M0 YAML fake demo remains process-local. Durable tests that need scripted recovery use checked-in test fixtures whose entire behavior is part of the test setup, not a user run reconstructed from an arbitrary source path.

## Workspace checkpoint contract

Immediately before an attempt enters the running state, Anastom captures its owned workspace with the existing temporary-index approach. The checkpoint records:

- current `HEAD` commit;
- SHA-256 of the binary-capable diff relative to the run base;
- ordered changed-file names;
- a durable diff artifact reference when the workspace is not clean.

The scheduling transition persists the attempt identity, execution ID, and checkpoint before runtime start. An artifact body written before that transaction but left unreferenced by a crash is never treated as evidence and may be collected later.

Recovery captures the workspace by the same algorithm. Exact equality permits a replacement attempt. Any different head, diff digest, file set, ownership manifest, worktree registration, branch, symlink boundary, or repository identity produces `workspace-conflict` and retains the worktree.

M3 provides no automatic reset or acceptance of orphan edits. Documentation shows how to inspect the checkpoint and current diff. A future checkpoint-to-new-worktree operation requires its own design because it changes evidence and Git ownership semantics.

## Pause, cancel, and resume semantics

### Pause

- At a scheduling boundary, pause the run while preserving each node's ready or pending status.
- During an attempt, persist pause intent, terminate the execution, confirm absence, mark that attempt cancelled for the operator request, pause the node, and pause the run.
- If cleanup is unknown, do not record completed pause; expose the pending operation and prevent new work.
- Resuming a scheduling-boundary pause preserves the prior dependency state. Resuming a node whose active attempt was cancelled makes that node ready for a fresh attempt subject to its remaining budget.

### Cancel

- Persist cancel intent before cleanup.
- Terminate and confirm any active execution.
- Cancel the active attempt and every nonterminal node, then record terminal run cancellation.
- Once terminal, resume is rejected and later cancel requests are semantic no-ops.
- Unknown cleanup prevents terminal cancellation from being claimed.

### Resume after crash

- Reject a live owner and any terminal run.
- Acquire a released lease or take over an expired lease with absent owner identity.
- Process pending pause/cancel before considering retry.
- Reconcile an active attempt's execution, orphan it once, and compare the workspace checkpoint.
- If safe and budget remains, make the node ready and continue.
- Otherwise pause with a typed reason and retained evidence.

Explicit pause cancellation and crash orphaning are distinct attempt outcomes. Inspection must not report one as the other.

## Implementation order and gates

1. **Feasibility evidence:** add deterministic process-identity, descendant-cleanup, SQLite contention, and workspace-checkpoint probes. Record results in `docs/M3_FEASIBILITY.md`. Revise this brief and ADR if evidence contradicts the proposed contract.
2. **Schemas and compatibility:** define event/projection additions, sanitized runtime descriptors, typed ownership/control errors, and old-history compatibility tests. Add Changesets for every affected package contract.
3. **Persistence:** add versioned migrations for leases, mutation keys, control requests, and snapshots; implement fenced/idempotent transactions and full-replay fallback.
4. **Runtime ownership:** implement the evidence-backed common outcome contract and model-free conformance coverage for each current adapter and command execution.
5. **Engine recovery:** checkpoint before execution, heartbeat ownership, poll control requests, reconcile orphans, and enforce pause/cancel/resume transitions and attempt budgets.
6. **CLI:** add durable commands, operation IDs, reconstruction from sanitized descriptors, stable exit behavior, and useful status/inspection output.
7. **Process-level acceptance:** run the deterministic clean, dirty-workspace, unknown-execution, stale-fence, duplicate-operation, and corrupt-snapshot cases from separate processes.
8. **Completion evidence:** write `docs/M3_EVIDENCE.md`, update the README, roadmap, architecture, package docs/changelogs, and root changelog, then obtain owner review and green required checks.

Do not combine public contract design and implementation in one review step. The design issue and docs PR gate the feasibility work; feasibility gates the final API shapes; deterministic evidence gates milestone completion.

## Required deterministic coverage

- lease acquire, renew, release, expiry, generation monotonicity, live-owner refusal, absent-owner takeover, unknown-owner refusal, and stale-fence rejection;
- idempotent same-mutation replay, mismatched-payload conflict, sequence conflict, and atomic rollback;
- duplicate pause/cancel/resume operation handling across process restarts;
- pause and cancel at a scheduling boundary, during an agent fixture, and during a command fixture;
- confirmed, failed, and unknown cleanup outcomes with no second worker on uncertainty;
- orphan transition uniqueness, fresh attempt identity, attempt-budget exhaustion, and old-run compatibility;
- exact workspace checkpoint match plus tracked, untracked, staged, committed, binary, symlink, ownership, and branch-conflict cases;
- snapshot creation, tail replay, version mismatch, digest corruption, state corruption, rebuild, and equality with full replay;
- sanitized descriptor round-trip for Pi, Codex, and Claude Code, including rejection of credential-like and unknown fields;
- process-level `SIGKILL` recovery with readiness handshakes and bounded polling on Linux and macOS;
- public inspection free of prompts, reasoning, private tool bodies, raw provider errors, credentials, and private fixture sentinels;
- full runtime conformance with no provider calls or credential-store reads.

Tests must use injectable clocks or explicit synchronization. A passing test cannot depend on a narrow sleep window. Fixture executables live in files and are invoked by argument vectors without shell interpolation.

## Completion evidence

M3 is complete only when one reviewed evidence document records all of the following:

- the design issue and accepted ADR/build brief;
- feasibility commands and results for local process identity and every current execution owner;
- the exact process-level crash/restart command and run ID;
- first and replacement attempt identities, ownership generations, orphan transition, verifier result, terminal state, and event sequence;
- stale-owner append rejection and duplicate-operation results;
- clean-resume, dirty-workspace pause, and unknown-execution refusal cases;
- snapshot/full-replay equality and corruption fallback;
- artifact existence, size, digest, ownership, and private-sentinel scan;
- source-checkout cleanliness and retained worktree evidence;
- compatibility results for pre-M3 histories;
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, package builds, API-documentation review, and `pnpm hygiene`;
- Linux and macOS CI, CodeQL, dependency review, DCO, and every other required repository check;
- reviewed package Changesets and owner acceptance of the implementation and evidence.

No provider-backed run is required for M3 acceptance. The milestone tests orchestration durability, and making it depend on model variability would weaken the crash evidence.

## Explicitly deferred

- provider-session or transcript reattachment;
- automatic acceptance, merge, reset, or deletion of orphan workspace changes;
- exactly-once external side effects;
- force takeover of a live or unidentifiable owner;
- remote hosts, distributed leases, queues, servers, or worker fleets;
- parallel nodes, integration branches, and the M4 defined SDLC;
- M5 cost budgets, repeated-failure fingerprints, and general circuit breakers;
- human approval gates, TUI/API control surfaces, and web dashboards;
- cleanup or retention policy for completed run history beyond existing owned-worktree rules.
