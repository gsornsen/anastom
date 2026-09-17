# M3 durable-execution evidence

Status: **implementation candidate consolidated in PR #24; owner acceptance pending.** The production implementation and deterministic process-level acceptance are complete on the owner macOS host, and the cleanup code candidate passes every required repository check. M3 becomes complete only after the owner reviews the combined branch.

## Reviewed design and implementation identity

The owner accepted the M3 design in [issue #22](https://github.com/gsornsen/anastom/issues/22) and [PR #23](https://github.com/gsornsen/anastom/pull/23). [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md) defines the ownership and recovery boundary. [ADR 0018](adr/0018-m3-production-contract-and-package-boundaries.md) and the [M3 production contract](M3_PRODUCTION_CONTRACT.md) define the exact production records and package APIs.

The model-free feasibility slices established the implementation gates. Their linear commits and the later production slices are now consolidated into [PR #24](https://github.com/gsornsen/anastom/pull/24); the redundant remote branches were removed. The closed slice PRs retain their review history:

| PR                                                 | Evidence                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [#24](https://github.com/gsornsen/anastom/pull/24) | Current-owner process identity, crash survivors, exited-leader gap, and parent-death supervisor                    |
| [#25](https://github.com/gsornsen/anastom/pull/25) | Two-phase supervisor protocol, authenticated bounded IPC, cleanup, supervisor-loss refusal, and start-window crash |
| [#26](https://github.com/gsornsen/anastom/pull/26) | Multi-process SQLite leases, monotonic fences, idempotent mutations, controls, and transaction rollback            |
| [#27](https://github.com/gsornsen/anastom/pull/27) | Exact Git workspace content and ownership checkpoints                                                              |
| [#28](https://github.com/gsornsen/anastom/pull/28) | Snapshot-plus-tail equality, prefix binding, corrupt-cache fallback, and baseline lifecycle shapes                 |

The production work was reviewed in linear slices for schemas/contracts, private paths and workspaces, the durable store, shared execution host, engine recovery coordinator, CLI composition, and acceptance. PRs #25 through #36 now resolve into PR #24's single feature branch so the owner can review and accept one main-targeting diff.

## Reproduce

Run from the repository root on Linux or macOS:

```bash
pnpm verify:m3
```

The corresponding required test boundary is:

```bash
pnpm test scripts/verify-m3-durable-execution.test.ts
```

The command creates disposable Git repositories and real SQLite stores, starts checked-in TypeScript fixture programs with argument vectors, and uses the production `GitWorkspaceManager`, `SqliteDurableRunStore`, `LocalExecutionHost`, `DurableRunCoordinator`, artifact store, process observer, CLI status/inspection, 15-second lease, and verifier command. It calls no provider, reads no authentication store, and reports `modelCalls: 0`.

Attempt-one readiness requires both a private atomic fixture record and durable `AttemptStartAuthorized` state containing the execution identity and workspace checkpoint. The driver verifies that the lease owner's PID is the exact process receiving `SIGKILL`. Every subsequent wait polls a concrete process, record, lease, or run-state condition under a deadline. No assertion infers readiness from a sleep. Executable fixture programs are checked-in files; none is embedded in a string.

The local acceptance ran on 2026-09-16 with Node.js `v26.4.0`, pnpm `11.9.0`, and macOS arm64.

## Clean crash and restart

The accepted local run was `m3-clean`.

| Evidence              | Observed result                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| First execution       | `0990078c-a9d7-443d-be38-93d555d4161e`, fencing generation 1                                              |
| Coordinator crash     | Exact recorded lease-owner process received `SIGKILL` after explicit attempt readiness                    |
| Cross-process status  | Run remained `running`; absent owner was conservatively `unknown` before expiry; no work started          |
| Early replacement     | Refused as `lease-active` before the exact lease expiry                                                   |
| Parent-death cleanup  | Supervisor retained authenticated terminal evidence with `cleanup: confirmed`                             |
| Replacement execution | `363463cd-703c-474b-bb1e-c65b2ccec75a`, fencing generation 2                                              |
| Orphan accounting     | Exactly one `AttemptOrphaned`; attempt one remained numbered and consumed budget                          |
| Fresh retry           | Attempt two used a distinct execution identity and fresh context                                          |
| Independent verifier  | `node --test server.test.mjs` passed; only `server.mjs` changed                                           |
| Terminal state        | `succeeded` after 43 contiguous events                                                                    |
| Stale owner           | A separate process using the generation-one token was rejected as `ownership-conflict`                    |
| Repeated resume       | The same operation ID from another process returned the existing terminal state without changing sequence |
| Source/worktree       | Source checkout remained clean; the owned worktree retained the `server.mjs` diff throughout the audit    |

The fixture's checked-in task permits two attempts. Attempt one deliberately remains active without changing the clean worktree. After takeover, the coordinator confirms execution absence, records the orphan and cleanup evidence, captures the workspace again, compares every checkpoint dimension, reruns current runtime preflight, emits a recovered-ready transition, and schedules attempt two. The command verifier remains independently owned by the control plane.

The pre-expiry status label is `unknown`, rather than `expired`, because an absent process does not authorize takeover while its lease is still valid. After expiry, the same absent-owner observation permits generation two. This is the conservative inspection rule accepted as production-contract decision 22.

## Refusal cases

The same process driver runs two crash cases concurrently in separate repositories:

| Case         | Injected condition                                                                                    | Required outcome                                | Observed result                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `m3-dirty`   | Attempt one changes `server.mjs` before coordinator death                                             | Preserve evidence and pause without attempt two | `paused`; one orphan; differences `diff-digest` and `changed-files`; 592-byte retained diff; no replacement probe |
| `m3-unknown` | The authenticated terminal record is replaced with invalid bytes after confirmed parent-death cleanup | Fail closed without attempt two                 | `recovery-blocked` with `execution-unknown/invalid-record`; no replacement probe                                  |

Both cases first prove pre-expiry `lease-active` refusal and confirmed parent-death cleanup. Both source checkouts remain clean. The dirty case retains the exact post-crash workspace artifact and never resets, accepts, deletes, or retries over it. The unknown case demonstrates that OS absence alone is insufficient when authenticated termination evidence cannot be validated.

## Idempotency, snapshots, and artifacts

Separate coordinator processes create `m3-duplicate-pause` and `m3-duplicate-cancel`. For each, the first control submission reports `replayed: false` and the same operation/action from a later process reports `replayed: true`. Reusing the pause operation ID for cancel is rejected as `control-conflict`. Ordinary recovery reaches `paused` and `cancelled`, respectively. The clean run separately proves repeated terminal resume is sequence-preserving.

Before fault injection, the clean execution loader selected `snapshot-tail` and produced state identical to complete authoritative replay. The driver then corrupts every snapshot state digest for that disposable run through SQLite, reopens the production store, observes `full-replay`, and compares the reconstructed state to the previously retained authoritative state. Events remain authoritative and unchanged.

The clean run referenced 12 artifacts. The audit reopens every artifact through `FileArtifactStore`, verifies existence, ordinary-file and nonsymlink type, current-user ownership, mode `0600`, exact size, and SHA-256 digest. It verifies the command node passed and the retained Git diff names only `server.mjs`. Public JSON inspection contains no `PRIVATE_SENTINEL`, credentials, prompts, reasoning, private tool bodies, or raw provider errors. The owned worktree remains intact until all evidence is collected; the acceptance command then removes its disposable fixture repository.

## Pre-release baseline and scope

Anastom has no external users, supported release, or retained user database. The implementation therefore establishes one durable baseline instead of preserving transitional development paths:

- migration one creates the complete durable schema and rejects nonempty unjournaled databases;
- the superseded `SqliteRunPersistence` adapter and fake Markdown Task path are removed;
- current Task creation records its runtime descriptor, ownership, event integrity, and initial snapshot atomically;
- missing descriptor, lease, or owned-execution records are corrupt durable state and never cause guessed runtime flags;
- snapshots remain disposable caches, and invalid candidates fall back to authoritative full replay;
- baseline process-local lifecycle shapes remain available to deterministic YAML workflows and snapshot feasibility fixtures;
- Pi, Codex, and Claude Code descriptors round-trip only their exact credential-free reconstruction fields;
- the runtime conformance suites use no provider calls or credential-store reads.

M3 does not adopt provider sessions, promise exactly-once external effects, reset orphan workspaces, force takeover, add remote workers, parallel scheduling, human approval, M4 workflows, or another model integration.

## Validation and remaining gates

Local final-code validation completed on the acceptance candidate:

| Check                               | Local result                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm verify:m3`                    | Passed; exact results above                                                                          |
| Focused M3 Vitest boundary          | Passed, 1/1 test                                                                                     |
| `pnpm test`                         | Passed, 48/48 files and 285/285 tests                                                                |
| `pnpm typecheck`                    | Passed                                                                                               |
| `pnpm lint`                         | Passed, including the custom no-inline-script rule                                                   |
| `pnpm format` / `pnpm format:check` | Passed                                                                                               |
| `pnpm hygiene`                      | Passed                                                                                               |
| `pnpm docs:api`                     | Passed for all 12 packages; generated output reviewed and left uncommitted                           |
| Package builds                      | No separate package build scripts exist; repository-wide TypeScript validation is the build boundary |

On cleanup code candidate `59032bf`, Linux and macOS CI, dependency review, DCO, CodeQL analysis, and the CodeQL policy gate all passed. The CodeQL scan remains clear after the earlier candidate closed 15 findings through code changes: test fixtures now use the shared private-path capability, the SQLite store requires a caller-authorized existing parent, persisted-event dispatch uses fixed method selection, inherited object keys are rejected, and public validation stops at its first error.

CodeQL alert 41 (`js/path-injection`) was individually assessed as a false positive at the private-root trust boundary. A local operator explicitly authorizes the state-root path; `ensurePrivatePathRoot()` canonicalizes its existing parent, fixes the leaf, rejects symlinks and non-directories, requires current-user ownership, tightens mode to `0700`, verifies the canonical result, and returns a capability whose child operations accept validated fixed segments and revalidate parents. A future remote caller must authorize the root before invoking this API. The narrow dismissal and rationale are recorded in GitHub; the path-injection query remains enabled.

The final consolidated head must still pass every required repository check. The owner-review/contribution-rights checkbox remains open until the owner reviews the complete branch; standing contribution rights are already confirmed.
