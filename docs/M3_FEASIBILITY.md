# M3 durable-execution feasibility

## Status

Process-ownership phase implemented and passing on the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI in [PR #24](https://github.com/gsornsen/anastom/pull/24) on 2026-09-16. The next production-shaped supervisor-protocol phase passes locally on the owner macOS host and awaits its stacked Linux/macOS CI result. SQLite lease/idempotency contention, exact workspace checkpoints, and snapshot fallback remain later feasibility phases before public M3 APIs are frozen.

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

No public signature is fixed by this phase. Bounded public event/result relay and cancel/parent-death behavior now pass for Pi, Codex, Claude Code, and commands in the temporary run-owned boundary. Cross-platform CI, final state-layout placement, and the other M3 feasibility tracks remain gates before `RuntimeAdapter.recover()` is removed or replaced.

## Security and evidence limits

- The probe records only process metadata, public fixture owner names, and boolean outcomes. It does not retain prompts, runtime frames, tool inputs, environment snapshots, credentials, or authentication metadata.
- A SHA-256 boot-identity digest is emitted to demonstrate same-boot binding without printing the source boot identifier. It is temporary console evidence and is not checked into the repository.
- The probe's `ps` start token distinguishes ordinary PID reuse on the same identified host boot, but macOS exposes that value only to one-second precision. It is evidence for this experiment, not sufficient production authority. The production protocol must combine the strongest portable process identity available with a supervisor-issued random execution capability and host/boot binding, and it must fail closed when those cannot authenticate the intended process. Cross-host recovery remains rejected by ADR 0017.
- The local run used synthetic adapter/session doubles and a generic supervisor worker. It proves lifecycle mechanics, not provider-session behavior or model quality.
- The first Vitest boundary passed on Ubuntu 24.04 and macOS 15 in PR #24. That establishes portability of the process-ownership prototype on the supported CI hosts; the production-shaped supervisor protocol must pass both again before its cross-platform gate is recorded complete.
- The probe intentionally leaves SQLite fencing, snapshot correctness, workspace checkpoints, runtime-descriptor reconstruction, and complete pause/cancel/resume semantics unproved.

## Next feasibility gates

1. Confirm the production-shaped supervisor protocol through model-free Pi, Codex, Claude Code, and command owners on both Linux and macOS CI.
2. Prove SQLite lease acquisition, fencing, idempotent mutation keys, and control-request contention across real processes.
3. Prove exact workspace checkpoints across tracked, untracked, staged, committed, binary, and symlink changes.
4. Prove snapshot-plus-tail equality and corrupt/unknown snapshot fallback to full event replay.
5. Resolve production process identity, socket placement/path length, and bounded operational-record loading before promoting the prototype into package contracts.
6. Revise ADR 0017 and the M3 build brief if any later evidence contradicts the shared-supervisor candidate.
