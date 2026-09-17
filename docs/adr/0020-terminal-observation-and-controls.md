# ADR 0020: Terminal observation and controls

Status: accepted and implemented on 2026-09-17. See the [completion evidence](../M4_5_EVIDENCE.md).

## Context

Long-running Task and Feature runs now have durable state, fenced ownership, whole-run controls, expanded dependency graphs, an evidence ledger, and a bounded public event projection. The line stream proves that events can be observed, but it does not let a developer quickly understand parallel node state or operate a run from the interface they will use day to day.

A terminal client creates several architectural risks. It could reimplement graph expansion, treat rendered state as authoritative, expose private runtime material, couple run ownership to the lifetime of a screen, or make detach equivalent to cancellation. Polling a UI-specific database or persisting a second view would also create competing truth.

## Decision

Add `anastom attach` as a durable observer and control client. Its view is a disposable projection over the immutable workflow, event-derived `RunState`, bounded `LiveRunEvent` history, lease observation, and pending controls. The engine exports its existing graph resolver through the package boundary so the client uses the same static/expanded graph interpretation as scheduling and evidence projection.

Interactive rendering uses a small terminal-host capability with size, byte writes, key input, and resize notification. The pure view projection and frame renderer know nothing about Node streams. The production host owns raw mode and alternate-screen lifecycle, which recorded tests can replace without terminal emulation dependencies.

Pause and cancel submit the existing idempotent durable controls without acquiring ownership. Resume launches the existing foreground coordinator command in a detached child process. The terminal never runs the coordinator inside its own display lifecycle; therefore detach remains an observation-only action while resumed execution continues.

The store validates a new control against the event-derived run state inside the same write transaction that would persist it. This closes the race between a client's last observation and terminal settlement without weakening operation-ID replay: a previously accepted operation still returns its original receipt.

An explicit termination may outlast the ordinary supervisor request deadline when an adapter does not settle cancellation cooperatively. The termination request therefore has a separate bounded deadline covering the graceful interval, force-kill fallback, process-group absence check, and terminal-record publication. A forced runtime-host exit may discard its partial result, but an empty authenticated process group is sufficient to confirm cleanup and complete the durable control.

Non-TTY attach emits the existing JSON Lines contract. A one-shot plain snapshot provides deterministic logs, support output, and process-level acceptance without ANSI control bytes. `NO_COLOR` affects styling only.

## Consequences

- The event and control contracts stand without a UI-specific event family; control submission now makes its actionable-state invariant atomic.
- Live pause remains fail-closed, while an adapter that does not settle cancellation can no longer turn confirmed forced process-group cleanup into a permanent recovery block.
- The graph resolver becomes a documented engine package API because terminal and future clients need exact expanded topology.
- Reconnect has one source of truth and reproduces bounded public activity from durable history.
- Full-history inspection is acceptable for the initial local MLP client and preserves integrity validation. A measured tail-read optimization can be added behind the same view contract if long-run evidence shows it is needed.
- The terminal remains usable in tests and noninteractive environments without adding a terminal framework dependency.
- A resume key depends on launching the installed Anastom entry point with the current Node execution profile. Failure to launch is a visible local notification and does not mutate run state.

## Rejected alternatives

### Put terminal state in the durable store

Window size, selected rows, and paint cursors are presentation details. Persisting them would mix client state with workflow evidence and complicate reconnect with no scheduling benefit.

### Give the terminal its own coordinator

If the display acquired ownership, detaching or losing a terminal could interrupt execution. Reusing the foreground resume command in a separate process preserves the ownership contract and independent lifetimes.

### Render raw durable events

Durable events include control-plane evidence that is unsuitable as a stable public interface. The existing `LiveRunEvent` projection already enforces disclosure and output bounds.

### Add a full terminal framework

The first view needs deterministic layout, resize handling, key controls, color reduction, and cleanup. Node streams and ANSI control sequences cover that boundary with a much smaller dependency and security surface. A framework may be reconsidered when a measured interaction need exceeds this host contract.
