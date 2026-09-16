# M3 durable-execution feasibility

## Status

Process-ownership phase implemented and passing on the owner macOS host on 2026-09-16. Linux and clean macOS CI remain acceptance gates for this phase. SQLite lease/idempotency contention, exact workspace checkpoints, snapshot fallback, and a production-shaped supervisor IPC protocol remain later feasibility phases before public M3 APIs are frozen.

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

## Contract refinement from this phase

The evidence rejects two narrower designs:

1. **Persist the existing runtime handle.** It has no cross-process OS meaning and becomes unavailable with the adapter map.
2. **Persist the direct native leader PID.** It cannot authenticate a surviving group after that leader exits.

The next feasibility phase will use this candidate boundary:

- The engine creates an execution ID and persists it with the attempt checkpoint before any execution-side effect.
- A shared Anastom attempt supervisor, rather than each vendor adapter, owns the OS lifecycle for agent and command attempts.
- Launch is a two-phase handshake: the supervisor first writes a validated run-owned identity record and waits; the fenced coordinator records that identity and then authorizes worker start.
- The supervisor monitors the verified coordinator identity and owns bounded group cleanup on parent death.
- Pi must execute through an out-of-process runtime host so its tool descendants have the same ownership boundary as CLI adapters and commands.
- Codex and Claude Code keep their protocol/profile logic, while their duplicated group-lifecycle code becomes a candidate for the shared supervisor.
- Recovery trusts neither a launcher PID nor an unverified manifest. It checks host/boot identity, a production-grade process identity, process group, supervisor-issued execution capability, execution ID, lease generation, run-owned path, and manifest schema before requesting cleanup.
- If both supervisor and authenticated execution leader are absent but a group may remain, recovery reports `unknown` and pauses. It never signals a bare numeric group.

No public signature is fixed by this phase. The next prototype must relay bounded public events and terminal results for Pi, Codex, Claude Code, and commands; prove cancel and parent-death races; and place the manifest beneath the existing owned state boundary before `RuntimeAdapter.recover()` is removed or replaced.

## Security and evidence limits

- The probe records only process metadata, public fixture owner names, and boolean outcomes. It does not retain prompts, runtime frames, tool inputs, environment snapshots, credentials, or authentication metadata.
- A SHA-256 boot-identity digest is emitted to demonstrate same-boot binding without printing the source boot identifier. It is temporary console evidence and is not checked into the repository.
- The probe's `ps` start token distinguishes ordinary PID reuse on the same identified host boot, but macOS exposes that value only to one-second precision. It is evidence for this experiment, not sufficient production authority. The production protocol must combine the strongest portable process identity available with a supervisor-issued random execution capability and host/boot binding, and it must fail closed when those cannot authenticate the intended process. Cross-host recovery remains rejected by ADR 0017.
- The local run used synthetic adapter/session doubles and a generic supervisor worker. It proves lifecycle mechanics, not provider-session behavior or model quality.
- macOS results do not establish Linux portability. The same Vitest boundary is added to the existing Ubuntu and macOS jobs; both must pass before this phase is accepted.
- The probe intentionally leaves SQLite fencing, snapshot correctness, workspace checkpoints, runtime-descriptor reconstruction, and complete pause/cancel/resume semantics unproved.

## Next feasibility gates

1. Build a production-shaped supervisor protocol with an engine-generated execution ID, supervisor-issued random execution capability, two-phase start authorization, run-owned atomic manifest, bounded framed IPC, cancellation, parent-death cleanup, and fail-closed restart inspection.
2. Exercise that protocol through model-free Pi, Codex, Claude Code, and command owners on Linux and macOS.
3. Prove SQLite lease acquisition, fencing, idempotent mutation keys, and control-request contention across real processes.
4. Prove exact workspace checkpoints across tracked, untracked, staged, committed, binary, and symlink changes.
5. Prove snapshot-plus-tail equality and corrupt/unknown snapshot fallback to full event replay.
6. Revise ADR 0017 and the M3 build brief if any later evidence contradicts the shared-supervisor candidate.
