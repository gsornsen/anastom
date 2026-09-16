# M3 durable-execution feasibility

## Status

Process-ownership phase implemented and passing on the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI in [PR #24](https://github.com/gsornsen/anastom/pull/24) on 2026-09-16. The production-shaped supervisor-protocol phase also passes on the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI in stacked [PR #25](https://github.com/gsornsen/anastom/pull/25). The SQLite lease, fencing, idempotency, and control-inbox contention phase passes on the same local/CI platforms in stacked [PR #26](https://github.com/gsornsen/anastom/pull/26), and the exact workspace-checkpoint phase passes there in stacked [PR #27](https://github.com/gsornsen/anastom/pull/27). The snapshot-plus-tail and corrupt-snapshot fallback phase passes locally on the owner macOS host; Linux and clean macOS CI are pending on its stacked change. Public M3 APIs remain unfrozen.

The accepted [M3 build brief](M3_BUILD_BRIEF.md) and [ADR 0017](adr/0017-durable-execution-ownership-and-recovery.md) require evidence before choosing an execution-recovery interface. This document records that evidence. The process probe makes no provider request, reads no real authentication store, and changes no production runtime contract.

## Reproduce

From the repository root on Linux or macOS:

```bash
pnpm probe:m3:process
```

The command uses the real Pi adapter with an injected model-free session, the real Codex and Claude Code adapters with their existing native process doubles, and the real command executor with a checked-in fixture. It creates isolated temporary directories, waits on explicit readiness records, sends `SIGKILL` to the verified coordinator identity, inspects POSIX process identities, performs bounded cleanup, and removes its temporary data.

The corresponding Vitest boundary is:

```bash
pnpm test scripts/probe-m3-process-ownership.test.ts
```

The production-shaped protocol phase is independently reproducible with:

```bash
pnpm probe:m3:supervisor
pnpm test scripts/probe-m3-supervisor-protocol.test.ts
```

It uses the same model-free adapter seams and no authentication store. The command runs four owners through successful result relay, explicit cancellation, and coordinator death, then kills the command supervisor to prove the uncertain-recovery boundary. Its Vitest boundary has a 120-second outer limit; the local matrix currently completes in about 13 seconds.

The SQLite contention phase is independently reproducible with:

```bash
pnpm probe:m3:sqlite
pnpm test scripts/probe-m3-sqlite-contention.test.ts
```

It creates a temporary database from a checked-in feasibility schema, releases pairs of real worker processes through explicit round barriers, uses injected logical time for lease expiry, and removes the database afterward. Its Vitest boundary has a 60-second outer limit; every internal readiness and completion wait is bounded, and the local 12-round matrix currently completes in about 3.2 seconds.

The workspace-checkpoint phase is independently reproducible with:

```bash
pnpm probe:m3:workspace
pnpm test scripts/probe-m3-workspace-checkpoint.test.ts
```

It creates temporary source and clone repositories plus owned Git worktrees. It captures the same rich workspace twice, tests exact restoration after content and ownership changes, and removes both repositories afterward. The probe invokes no runtime or model and reads no authentication store. Its Vitest boundary has a 60-second outer limit; the local matrix currently completes in about 5.5 seconds.

The snapshot phase is independently reproducible with:

```bash
pnpm probe:m3:snapshot
pnpm test scripts/probe-m3-snapshot.test.ts
```

It creates a temporary current SQLite run store, writes four deterministic lifecycle histories, closes and reopens it, and removes it afterward. It then exercises feasibility-local snapshot records and a checked-in folded-state schema without adding a production migration or package API. The probe invokes no runtime or model and reads no authentication store. Its Vitest boundary has a 30-second outer limit; the local matrix currently completes in under one second.

The test has a 45-second outer limit. Every internal wait is bounded and driven by a file or process-state condition. No assertion infers readiness from a fixed sleep. Fixture programs are checked-in files; none is embedded in a string. Child fixtures accept only fixed behavior names, use their inherited canonical working directory as the authorized record root, and publish readiness JSON by atomic rename so readers cannot observe partial records.

## Current contract audit

The engine records `AttemptStarted` before calling a worker, but `ExecutionRequest` has no engine-generated execution ID. Current adapter handles are generated inside `start()` and remain in process-local maps. The engine does not persist them. Command execution returns one promise and exposes no execution handle at all.

| Owner       | Current OS ownership                                                                                      | Durable recovery identity |
| ----------- | --------------------------------------------------------------------------------------------------------- | ------------------------- |
| Pi          | The SDK session runs inside the coordinator. Tool descendants may outlive coordinator death.              | None                      |
| Codex       | The adapter starts one detached native process group and retains its child object in a process-local map. | None                      |
| Claude Code | The adapter starts one detached native process group and retains its child object in a process-local map. | None                      |
| Command     | The executor starts one detached process group and retains the child only inside its pending promise.     | None                      |

`RuntimeAdapter.recover()` has no implementation and its `PersistedExecutionRef` contains only an adapter ID and opaque handle ID. That shape cannot identify or authenticate an OS process after the map that issued the handle is gone.

## Coordinator-crash observations

For each owner, the probe waits until its direct execution and descendant are both established, persists their PID, process-group ID, start token, and the coordinator identity in fixture-only evidence, then kills the verified coordinator PID. `ps` runs under the C locale. Zombies are not treated as live execution.

Observed locally with Node.js `v26.4.0` on Darwin arm64:

| Owner       | Coordinator absent | Direct execution leader after crash | Descendant after crash | Group after crash | Current product reference sufficient |
| ----------- | ------------------ | ----------------------------------- | ---------------------- | ----------------- | ------------------------------------ |
| Pi          | Yes                | Absent because it was in-process    | Alive                  | Alive             | No                                   |
| Codex       | Yes                | Alive                               | Alive                  | Alive             | No                                   |
| Claude Code | Yes                | Alive                               | Alive                  | Alive             | No                                   |
| Command     | Yes                | Alive                               | Alive                  | Alive             | No                                   |

The probe subsequently removed every observed fixture process. Codex, Claude Code, and command cleanup succeeded when the probe used its out-of-band leader identity. Pi required the descendant's own identity because its only possible leader was the dead coordinator. These cleanup results demonstrate OS capability, not current Anastom recovery: the product does not persist those fixture identities.

The experiment also caught a launcher boundary. `tsx` returned a wrapper PID while the executed coordinator recorded a different PID in the next process. Killing the launcher's PID left the coordinator alive. The corrected probe kills the self-reported PID plus start token and waits for the launcher to reap it. M3 cannot treat the first PID returned by an arbitrary launcher as proof of the process that owns side effects.

## Why a leader PID is still insufficient

A separate fixture starts a detached group leader, records its verified identity, spawns a descendant, and then lets the leader exit. The descendant remains live in the original process group.

The result is deliberate:

```text
leader absent: true
descendant alive: true
group still alive: true
leader identity can authorize cleanup: false
```

Signalling the numeric process-group ID at that point would be unsafe. The recorded leader identity no longer exists, and a later process cannot rule out numeric ID reuse merely because another member still reports that group. Persisting only the native leader PID, start token, and group therefore closes the common crash case but not the exit-before-cleanup race.

## Parent-death supervisor candidate

The probe includes a shared supervisor prototype. The coordinator starts it as a separate owned process and supplies the coordinator's self-reported PID, group, and start token. The supervisor starts a TERM-resistant worker group with a descendant, stays alive while that group exists, and watches both its parent pipe and the recorded coordinator identity. When the coordinator is killed, it terminates the worker group, confirms no live member remains, records a bounded cleanup outcome, and exits.

The observed result was:

```text
coordinator absent: true
supervisor observed parent death: true
supervisor absent after cleanup: true
execution absent after cleanup: true
descendant absent after cleanup: true
```

This makes a shared supervisor feasible on the observed platform. It is not production code. Its temporary JSON records are neither run-owned manifests nor atomic durable state; it does not carry a lease fence, proxy runtime events, reconstruct adapters, or survive its own `SIGKILL`. Those are explicit next gates.

## Production-shaped supervisor protocol

The second probe advances the shared candidate without changing a package API. A coordinator first atomically publishes an attempt plan containing its verified process identity, the boot-identity digest, an engine-shaped execution UUID, and fence. The supervisor validates that record and the live coordinator, generates a random 256-bit control capability, opens a user-only local socket, and atomically publishes two separate records:

- a private control record containing the capability; and
- a sanitized manifest containing only its digest, the execution/fence identity, verified supervisor identity, boot binding, plan digest, owner, socket name, and lifecycle state.

The coordinator validates that handshake and proves the fixture has produced no execution side effect. It then atomically publishes start authority bound to the plan, capability digest, supervisor identity, and fence before sending an authenticated `authorize` request. The supervisor persists `starting` before the first possible worker side effect and publishes `active` only after it owns the execution. Only the supervisor can start the selected owner after both authorization checks pass. The records are durable across the process-crash boundary under test; this probe does not claim power-loss durability for temporary fixture files.

IPC uses a Unix-domain socket with one length-prefixed JSON frame per half-closed connection. The maximum frame is 131,072 bytes, and an incomplete connection has a five-second lifetime. The supervisor tracks every accepted socket and destroys it during shutdown, so an idle same-user client cannot hold cleanup open. Requests and responses reject unknown fields, an oversized length, malformed JSON, the wrong execution ID, a stale fence, and the wrong random capability. Public runtime events are schema-validated and capped at 256 before terminal publication. The capability never enters the sanitized manifest, terminal evidence, or console evidence.

The probe exercises the real Pi adapter with an injected session, the real Codex and Claude Code adapters with checked-in native doubles, and the command executor with a checked-in process fixture. It observed the following on Darwin arm64 with Node.js `v26.4.0`:

| Case                         | Pi  | Codex | Claude Code | Command |
| ---------------------------- | --- | ----- | ----------- | ------- |
| success and public relay     | Yes | Yes   | Yes         | Yes     |
| authenticated active inspect | Yes | Yes   | Yes         | Yes     |
| explicit cleanup confirmed   | Yes | Yes   | Yes         | Yes     |
| coordinator-death cleanup    | Yes | Yes   | Yes         | Yes     |
| later inspection absent      | Yes | Yes   | Yes         | Yes     |

Each cancellation case also rejected a wrong capability, wrong fence, tampered persisted control record, and oversized frame while leaving the supervisor available for the authorized cancellation. It held a second connection idle and proved terminal release still closed that connection and the supervisor. Each coordinator-death case wrote terminal evidence before reporting confirmed cleanup, then left the supervisor and all observed worker processes absent.

The deliberate supervisor-loss case has a different result. Killing the authenticated supervisor while its TERM-resistant command group is active leaves that group alive. The persisted manifest says `active`, but no process remains that can authenticate or confirm the owned tree. Inspection therefore returns `unknown`, and the recovery rule does not permit a replacement start. The probe then uses fixture-only out-of-band identities to clean up. This is an expected fail-closed boundary, not evidence that supervisor loss is recoverable.

A separate gated-start case closes the launch-publication race. It kills the supervisor after durable authority and the `starting` manifest but before the fixture's first side effect. Inspection still returns `unknown`, replacement remains forbidden, and the test confirms no side effect occurred in that particular run. The same state covers the harder crash after launch but before `active`: recovery cannot know which side of the side-effect boundary the supervisor reached, so it must not infer absence.

The protocol phase establishes that one shared OS-ownership boundary can serve all four current execution owners on the observed platform. It also refines the design in three ways:

1. The random capability is operational authority and belongs in a private run-owned record; only its digest belongs in public durable evidence.
2. A normal terminal record proves absence only when it matches the execution and fence, records confirmed cleanup, and the supervisor is itself absent. Missing, malformed, mismatched, or active evidence yields `unknown`.
3. `awaiting-start` is the only preterminal state that can prove no worker existed after supervisor loss. Once `starting` is durable, absence of the supervisor is unknown until matching confirmed terminal evidence exists.
4. A production runtime host can share lifecycle and framing while adapters retain their protocol/profile logic. The probe does not justify vendor-specific recovery methods.

Exact package types remain deliberately unfrozen. The temporary protocol uses POSIX local sockets and a fixture `ps` start token; socket path-length strategy, a stronger production process identity, placement beneath the final state layout, SQLite fencing integration, and bounded operational-record reads still need resolution before this becomes product code.

## SQLite contention protocol

The third probe isolates SQLite transaction behavior before the production migration and persistence API are chosen. A checked-in schema represents four distinct concerns: one mutable lease row, immutable append-only events, immutable mutation receipts, and immutable deduplicated control requests. Every lease or mutation operation opens the same WAL database from another process, sets a five-second busy timeout, and runs under `BEGIN IMMEDIATE`.

Twelve two-process rounds established the following on Darwin arm64 with Node.js `v26.4.0`:

| Boundary                                  | Observed result                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| initial acquire                           | exactly one generation-one owner                                                                  |
| renew                                     | current owner extended expiry; wrong owner rejected                                               |
| expired takeover                          | `alive` and `unknown` refused; two absent-owner contenders produced one generation-two owner      |
| concurrent identical mutation             | both calls returned sequence 1–2; one append and one replay produced one physical mutation        |
| changed payload / wrong expected sequence | both rejected without partial events                                                              |
| stale fenced append                       | generation one rejected after takeover; generation two rejected after release and reacquisition   |
| duplicate control request                 | same ID/action returned one SQLite timestamp and one row                                          |
| conflicting control request               | same ID with `pause` versus `cancel` produced one accepted row and one idempotency conflict       |
| release and reacquire                     | current generation released; stale release rejected; two contenders produced generation three     |
| final immutable history                   | sequences 1–4 contiguous with generations `2,2,2,3`; three mutation receipts and two control rows |

The experiment refines the persistence contract in four ways:

1. Process liveness is established outside SQLite. An absent-owner takeover transaction must still compare the exact observed owner, generation, released flag, and expiry; another takeover or renewal that wins first invalidates the observation.
2. Fence validation precedes mutation-ID replay. A stale generation cannot recover an old successful range by resubmitting the same operation ID.
3. A current token cannot renew or append after its expiry. It may release while it remains the exact current row; a simultaneous takeover serializes first and makes that release stale.
4. Control submission needs no lease. SQLite owns its recorded time, and `(run_id, operation_id)` deduplicates the inbox; the same action replays the original row while another action conflicts.

The probe also rejects unsafe integer overflow in clock arithmetic, generations, and event sequences, validates exact worker request/response shapes, and caps append batch size. Its schema is feasibility support, not a migration proposal: it does not yet integrate existing run/event validation, snapshots, schema compatibility, or final error names. Those remain part of the reviewed persistence implementation after all evidence phases complete.

## Exact workspace checkpoint protocol

The fourth probe exercises the existing temporary-index capture without changing the production workspace package. Its fixture combines a worker commit after the run base, tracked unstaged and staged edits, untracked text, binary bytes, a symlink whose target is outside-looking but never followed, an ignored file, and an ignored empty directory. The capture preserves the real staging index and produces the same binary-capable diff and ordered changed-file list after the staged edit is moved back to unstaged state. Staging arrangement is therefore not retry identity; the complete content relative to the run base is.

Git's binary diff does not include ignored material, which can still affect a replacement worker. The candidate checkpoint therefore adds a bounded fingerprint of ignored directories, ordinary files, file modes, content, and symlink target bytes. Unsupported filesystem entry types, invalid UTF-8 paths, more than 4,096 ignored entries, or more than 64 MiB of ignored content fail closed instead of silently weakening equality. The filesystem itself rejects the invalid-byte fixture on macOS; platforms that permit the path must reject it during decoding. Capturing twice rejects a workspace that changes during observation.

The checkpoint also binds the workspace ID and base commit to its current `HEAD`, diff digest, changed-file list, and canonical ownership evidence: repository root/common Git directory, worktree path/Git directory, branch, ownership-manifest digest, and worktree-registration digest. The probe changed each relevant boundary independently and observed refusal or a classified mismatch:

| Boundary                                           | Observed result                                           |
| -------------------------------------------------- | --------------------------------------------------------- |
| identical repeated capture                         | exact match                                               |
| staged versus unstaged arrangement, same content   | exact match; real staging index preserved                 |
| tracked, untracked, binary, or symlink-target edit | diff mismatch                                             |
| ignored-file edit                                  | ignored-content mismatch                                  |
| `HEAD` changed with the same tree                  | head mismatch                                             |
| branch, manifest, or symlinked owned path          | capture rejected                                          |
| moved Git worktree registration                    | capture rejected while the expected physical path existed |
| cloned repository with identical Git content       | repository identity mismatch                              |
| complete content and ownership restoration         | exact match; source checkout remained clean               |

This refines the accepted contract in three ways. The durable checkpoint needs an explicit schema version, workspace/run identity, base commit, ignored-content digest/counts, and canonical ownership fields in addition to the already proposed `HEAD`, diff digest, changed-file list, and diff artifact. A later attempt may ignore staging layout only because the temporary-index capture proves the same complete content. Any unrepresentable path, over-limit ignored tree, unstable double capture, or ownership ambiguity must pause recovery rather than authorize retry.

The types and limits remain feasibility-local. Production code should stream bounded ignored-file reads rather than retain them in memory, use the shared path-policy vocabulary when that API is extracted, persist the diff as a verified artifact, and integrate capture atomically with the fenced attempt-start transition.

## Snapshot and authoritative replay protocol

The fifth probe folds reopened M1-shaped, M2-shaped, M2.5-shaped, and pause/resume/cancel histories at valid lifecycle boundaries. For every shape, applying later events to the validated snapshot produces the same canonical state as replaying the complete event stream. A snapshot at the event tail also matches full replay, and a newer unknown-version record does not prevent the loader from selecting an older compatible valid candidate. Loading does not mutate the candidate records.

The accepted design proposed a schema/reducer version, event sequence, canonical state bytes, and state digest. The probe found that these fields alone are insufficient: a schema-valid change in an authoritative event before the snapshot could be hidden by tail-only reduction. The candidate therefore also binds the snapshot to the immutable workflow-definition digest and a SHA-256 digest of the exact canonical event prefix. Until production events carry an incrementally verified history digest, loading a snapshot may avoid reducer work but must still validate the complete event envelope and recompute the prefix digest.

The matrix rejects or skips each untrusted snapshot boundary, then performs full replay when no valid candidate remains:

| Boundary                                                    | Observed result                                      |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| absent snapshot                                             | full replay                                          |
| unknown snapshot or reducer version                         | full replay                                          |
| malformed/extra record fields                               | full replay                                          |
| wrong run or workflow-definition digest                     | full replay                                          |
| future event sequence                                       | full replay                                          |
| state over the 4 MiB feasibility limit                      | full replay                                          |
| state digest mismatch                                       | full replay                                          |
| malformed, noncanonical, schema-invalid, or wrong-ID state  | full replay                                          |
| event-prefix digest mismatch                                | full replay reflects the changed authoritative event |
| schema-valid snapshot state contradicted by its event tail  | full replay                                          |
| invalid event shape or sequence gap                         | load rejected before snapshot selection              |
| semantically corrupt event hidden behind a snapshot attempt | fallback replay rejects the history                  |

This preserves the trust hierarchy: events remain authoritative; the workflow definition remains immutable identity; snapshots are disposable derived caches. A corrupt snapshot cannot validate a corrupt event stream, and read-only loading never repairs storage. The temporary schema is exact for the current `RunState`; later M3 state fields require a reviewed reducer/schema version rather than permissive acceptance.

The candidate numeric limit, rejection names, and TypeScript shapes remain unfrozen. Production design must decide whether to store a rolling event-history digest transactionally, how to read bounded snapshot bytes from SQLite, which stable transitions create snapshots, and how a fenced writer replaces a rejected cache without letting inspection mutate data.

## Contract refinement from this phase

The evidence rejects two narrower designs:

1. **Persist the existing runtime handle.** It has no cross-process OS meaning and becomes unavailable with the adapter map.
2. **Persist the direct native leader PID.** It cannot authenticate a surviving group after that leader exits.

The production-shaped protocol confirms this candidate boundary on the observed platform:

- The engine creates an execution ID and persists it with the attempt checkpoint before any execution-side effect.
- A shared Anastom attempt supervisor, rather than each vendor adapter, owns the OS lifecycle for agent and command attempts.
- Launch is a two-phase handshake: the supervisor first writes a validated run-owned identity record and waits; the fenced coordinator records that identity and then authorizes worker start.
- The supervisor monitors the verified coordinator identity and owns bounded group cleanup on parent death.
- Pi must execute through an out-of-process runtime host so its tool descendants have the same ownership boundary as CLI adapters and commands.
- Codex and Claude Code keep their protocol/profile logic, while their duplicated group-lifecycle code becomes a candidate for the shared supervisor.
- Recovery trusts neither a launcher PID nor an unverified manifest. It checks host/boot identity, a production-grade process identity, process group, supervisor-issued execution capability, execution ID, lease generation, run-owned path, and manifest schema before requesting cleanup.
- If both supervisor and authenticated execution leader are absent but a group may remain, recovery reports `unknown` and pauses. It never signals a bare numeric group.

No public signature is fixed by this phase. Bounded public event/result relay and cancel/parent-death behavior now pass for Pi, Codex, Claude Code, and commands in the temporary run-owned boundary. Workspace identity has cross-platform evidence and snapshot fallback has local evidence, but snapshot cross-platform CI, final state-layout placement, and remaining production concerns remain gates before `RuntimeAdapter.recover()` is removed or replaced.

## Security and evidence limits

- The probe records only process metadata, public fixture owner names, and boolean outcomes. It does not retain prompts, runtime frames, tool inputs, environment snapshots, credentials, or authentication metadata.
- A SHA-256 boot-identity digest is emitted to demonstrate same-boot binding without printing the source boot identifier. It is temporary console evidence and is not checked into the repository.
- The probe's `ps` start token distinguishes ordinary PID reuse on the same identified host boot, but macOS exposes that value only to one-second precision. It is evidence for this experiment, not sufficient production authority. The production protocol must combine the strongest portable process identity available with a supervisor-issued random execution capability and host/boot binding, and it must fail closed when those cannot authenticate the intended process. Cross-host recovery remains rejected by ADR 0017.
- The local run used synthetic adapter/session doubles and a generic supervisor worker. It proves lifecycle mechanics, not provider-session behavior or model quality.
- The process, supervisor, SQLite, and workspace boundaries passed on Ubuntu 24.04 and macOS 15 in stacked PRs #24–#27.
- The workspace probe hashes ignored content in bounded feasibility memory; the production implementation must stream bounded reads and retain the same fail-closed outcomes.
- Snapshot code is a repository-level candidate with a temporary state schema and no production migration. Runtime-descriptor reconstruction, production integration, and complete pause/cancel/resume semantics remain unproved.

## Next feasibility gates

1. Confirm the snapshot matrix on Ubuntu 24.04 and clean macOS 15 CI.
2. Resolve production process identity, socket placement/path length, bounded operational-record loading, and rolling event-prefix integrity before promoting the prototypes into package contracts.
3. Propose exact schemas and package APIs in a separate review step; do not combine that contract review with production implementation.
4. Revise ADR 0017 and the M3 build brief if any later evidence contradicts the accepted boundaries.
