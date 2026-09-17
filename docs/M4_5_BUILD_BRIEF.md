# Terminal experience build brief

## Status and mission

Status: complete on 2026-09-17. This document defines the terminal-experience work tracked by [issue #38](https://github.com/gsornsen/anastom/issues/38). It is stacked on the completed defined-SDLC implementation so the interface tests the production run model before that stack enters `main`. See [completion evidence](M4_5_EVIDENCE.md).

Anastom must let a developer attach to a durable run, understand the current graph and bounded public activity, issue whole-run controls, detach without affecting execution, and reconnect to the same projected state. The terminal is an observer and control client. It never becomes workflow authority and never reads provider-private transcripts, reasoning, credentials, hidden tool bodies, or unbounded process output.

## User contract

The command is:

```bash
anastom attach <run-id> [--state-dir <path>] [--snapshot]
```

On an interactive terminal, `attach` opens a full-screen run view. `p` submits a durable pause request, `c` submits a durable cancel request, `r` launches the existing durable resume command in a separate coordinator process, and `d`, `q`, or `Ctrl-C` detaches the display. Detaching does not pause, cancel, release, acquire, or otherwise mutate run ownership.

The view shows:

- run status, durable sequence, and conservative ownership state;
- the resolved static or expanded dependency graph in stable node order;
- node phase, lifecycle status, active/latest attempt, and dependencies;
- bounded public runtime messages, provider/model identity, and attempt usage including reasoning tokens when reported;
- integration, review, verification, pending-control, and terminal-state evidence represented by the public projection; and
- explicit keyboard help and the latest local control notification.

When stdout is not a TTY, `attach` emits the same schema-valid JSON Lines used by live execution and follows new observations until the run reaches a settled state. `--snapshot` emits one deterministic, plain-text frame and exits. `NO_COLOR` disables color without disabling interaction. Narrow terminals render a reduced frame rather than wrapping hidden content or failing.

## Projection boundary

The view model is deterministic presentation state derived from three existing durable products:

1. the immutable normalized workflow definition;
2. the event-derived `RunState`, including any validated graph expansion; and
3. the bounded `LiveRunEvent` replay.

The engine's graph resolver is promoted through the package entry point so clients do not duplicate expansion rules. The CLI selects only presentation-safe fields from that graph and the public live events. Ownership and pending controls come from the existing read-only operational inspection. The terminal view model is not persisted and cannot be used to authorize scheduling or transitions.

Reconnect initially uses the integrity-checked complete-history read already required for inspection. Rendering advances by durable sequence and skips unchanged frames. A future tail-read optimization may replace this read shape without changing the terminal contract; no second cursor, database, or UI-specific event stream is introduced here.

## Control and process ownership

Pause and cancel retain their existing meaning: submitting the request does not require the run lease, and the current or recovering coordinator observes and acknowledges it. The terminal prints the UUIDv4 operation ID and request result in its local notification area.

A new pause/cancel request is accepted only if it can affect the event-derived state in the same store transaction. A previously accepted operation ID remains replayable with its original receipt. This prevents a client observation racing with terminal settlement from leaving a request that no coordinator can acknowledge.

Resume requires a coordinator. The terminal launches the existing `resume` command as a detached child with an explicit state directory and operation ID. This keeps the display outside workflow authority and lets the user detach while the coordinator continues. The child inherits the current Node execution profile but no terminal streams. No shell is involved, and no credential is copied into arguments or terminal state.

## Safety and bounds

- Only `LiveRunEvent` messages enter the activity pane; its existing per-message and per-attempt bounds remain authoritative.
- The view retains a small fixed number of recent messages and renders only rows that fit the current terminal.
- Provider/model and token fields are public adapter observations. Missing usage is rendered as unavailable rather than estimated.
- Raw durable events, artifact bodies, prompts, result bodies, exception text, and environment values are excluded.
- Terminal setup and restoration are paired through one session boundary. Normal detach, command failure, and `Ctrl-C` restore raw mode, cursor visibility, and the alternate screen.
- Every spawned command uses an argument vector and the current executable profile, never a shell or inline script.

## Acceptance and completion evidence

Completion requires all of the following:

- pure projection tests covering static and expanded graphs, parallel attempts, review/integration/verification states, bounded messages, usage, and absent optional evidence;
- recorded-terminal tests covering initial paint, resize, reduced color, pause, cancel, resume launch, detach, reconnect, and terminal restoration;
- process-level noninteractive tests proving schema-valid JSON Lines and deterministic `--snapshot` output from a later process;
- unchanged deterministic defined-SDLC acceptance and all repository checks;
- owner-authenticated Pi and Codex defined-SDLC demonstrations followed through the terminal, including detach/reconnect and sanitized evidence audits;
- current README, package README/changelog, root changelog, milestone status, Changeset, and semantic dead-code/documentation audit; and
- no unresolved CodeQL alert introduced by the stack.

The live demonstrations use the already selected Pi Anthropic `claude-opus-4-8` profile and Codex OpenAI `gpt-5.6-terra` with medium reasoning effort unless the owner changes them. Authentication remains in each CLI's normal user-owned store and never enters repository evidence.

## Excluded work

This work does not add a web dashboard, hosted control plane, collaborative editing, terminal emulation of provider UIs, arbitrary artifact browsing, model routing, approval policy, or circuit-breaker decisions. Those capabilities require their own contracts. The terminal may expose their future public states, but it does not anticipate or implement them.
