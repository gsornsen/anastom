# Terminal experience completion evidence

## Status

The terminal experience completed on 2026-09-17. The implementation is stacked on the defined-SDLC branch so the user interface tests the production expanded graph, durable ownership, public projection, and controls before that combined stack enters `main`.

`anastom attach` now provides a full-screen interactive run view, plain one-shot snapshots, and JSON Lines following from a later process. The interactive view shows the resolved static or expanded dependency graph, node and attempt state, runtime/model identity, reported usage, bounded public activity, ownership, and pending controls. Pause and cancel enter the existing durable control inbox. Resume launches the existing coordinator command in a separate process. Detach and reconnect never acquire ownership or change run state.

## Deterministic and recorded acceptance

Run the focused acceptance set from the repository root:

```bash
pnpm verify:terminal
```

It covers:

- exact graph order, dependencies, phases, parallel node states, runtime/model identity, partial usage, reasoning tokens, integration, review, and verification presentation;
- the 12-entry activity bound and conservative truncation for narrow and wide terminal text;
- terminal-control and bidirectional-formatting neutralization in human output while structured JSON retains the schema-valid source value;
- ANSI color and reduced-color frames;
- initial paint, resize, durable pause/cancel submission, separate resume launch, operation notifications, detach, terminal restoration, and reconnect-equivalent first frames through a recorded terminal host;
- Node TTY raw-mode and three-state `readableFlowing` restoration, including a nonflowing input that must be paused after detach so the CLI exits;
- rejection of pasted multi-character input as keyboard controls;
- bounded force-termination of an unresponsive adapter, including client/server request time to confirm that the authenticated process group is empty;
- later-process `attach --snapshot` output without terminal control bytes; and
- settled non-TTY attachment as individually parseable public JSON Lines.

The complete model-free process matrix remains:

```bash
pnpm verify:defined-sdlc
```

Both successful expanded-graph completion orders now add two later-process assertions. The plain snapshot included the expanded implementation, integration, review, and verification nodes. The noninteractive replay validated every line through `assertLiveRunEvent`, included committed integration and passing verification, ended in the authoritative run decision, and contained no ANSI bytes. The existing pause/cancel fan-in, failure gates, integration recovery, artifact checks, and clean-source assertions remained unchanged and passed.

## Pi live terminal demonstration

Pi used the owner's normal authentication with explicit `anthropic` / `claude-opus-4-8`; the persisted adapter version was `0.85.1`.

| Evidence                | Observation                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Run                     | `41c9ca69-e1d1-440e-94b2-278dfc10ca97`; succeeded at sequence 197                                     |
| Initial attachment      | Observed analysis/planning while the durable owner remained live                                      |
| Reconnect               | Reconstructed the ten-node expanded graph during integrator execution                                 |
| Detach                  | Restored raw mode, cursor, and alternate screen; exited zero without changing run ownership           |
| Parallel workers        | sequences 63–92 and 67–103; distinct execution IDs; overlapped                                        |
| Independent reviews     | sequences 143–179 and 148–173; distinct execution IDs; overlapped and approved                        |
| Final integration       | `402db12bc84c95d3e5c6e92a5593c9ea1cf95bbe`                                                            |
| Operator verification   | passed; exit 0; 39 stdout bytes; 0 stderr bytes                                                       |
| Plain terminal snapshot | ten succeeded nodes, released owner, reported usage/reasoning where available, passing verification   |
| Artifact/private audit  | 39 references; 36 immutable files; 78,046 bytes; digests, modes, bounds, and private-data checks pass |

The first live detach exposed a Node stream-lifecycle ambiguity: `readableFlowing === null` is neither an already-flowing input nor an explicitly paused one. Restoring from `isPaused()` left the PTY process alive after the screen was repaired. The production host now records the three-state property, resumes only an input that was already flowing, and pauses `null` or `false` input on close. A focused regression test covers all three states. The corrected client detached cleanly and a later attachment reconstructed the expanded graph without affecting the still-running coordinator.

## Codex live terminal demonstration

Codex used the owner's normal file-backed authentication with explicit `openai` / `gpt-5.6-terra` and medium reasoning effort; the persisted native CLI version was `0.154.0`.

| Evidence                | Observation                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Run                     | `6055b9a1-69c1-4429-bf4a-3a8fc78e8811`; succeeded at sequence 184                                     |
| Initial attachment      | Followed analysis/planning into graph expansion and two concurrently running implementation nodes     |
| Reconnect               | Reconstructed the later ten-node graph after one implementation completed                             |
| Detach                  | Restored terminal state and exited zero while the original coordinator continued                      |
| Parallel workers        | sequences 51–76 and 57–88; distinct execution IDs; overlapped                                         |
| Independent reviews     | sequences 128–160 and 135–166; distinct execution IDs; overlapped and approved                        |
| Final integration       | `114963b29c699bc030b9309fa6d2b829a103f8eb`                                                            |
| Operator verification   | passed; exit 0; 39 stdout bytes; 0 stderr bytes                                                       |
| Plain terminal snapshot | ten succeeded nodes, released owner, exact available partial/reasoning usage, passing verification    |
| Artifact/private audit  | 39 references; 36 immutable files; 66,271 bytes; digests, modes, bounds, and private-data checks pass |

Both live runs used the unchanged committed parallel-normalizers fixture and the production CLI/runtime/coordinator/storage/workspace/artifact stack. The checked-in auditor reproduced later-process inspection and projections, verified the retained integration branch and exact protected inputs, re-read every artifact through `FileArtifactStore`, and found no credential patterns or private fields. Authentication remained in each harness's owner-controlled store.

## Live pause acceptance

An additional owner-requested Pi run exercised pause through the interface setup rather than allowing the workflow to settle. The first attempt, run `6095b3a3-90f4-4551-8281-b4016a5a6492`, exposed a supervisor timing defect: Pi did not settle its adapter cancellation within the five-second grace period, the client and server used the same five-second request deadline, and terminal publication classified the force-killed runtime host as cleanup-unknown even after process-group removal. Anastom correctly failed closed as `recovery-blocked`, but could not complete the requested pause.

The execution host now gives termination a separate bounded request deadline and synchronizes terminal publication with graceful/forced process-group cleanup. A checked-in `unresponsive-cancel` runtime fixture reproduces the real behavior without a provider call. Fresh owner-authenticated Pi run `c5c72ab7-d0ea-45c0-a0f0-2d555db0b572` then recorded `ControlRequestObserved`, confirmed cleanup, immutable diff/workspace evidence, a paused analysis node, and `RunPaused` at sequence 30. Later-process status reported `paused`, released ownership generation 2, snapshot-tail sequence 30, zero pending controls, and the exact operator pause operation.

## Contract findings

The interface pressure test changed four implementation surfaces without adding a UI-specific event or state schema:

- The existing engine graph resolver is now exported as the exact static-or-expanded topology API. The terminal no longer needs to duplicate expansion ordering or dependency rules.
- Human terminal renderers neutralize control and bidirectional formatting characters from public text. JSON Lines preserve the original schema-valid value because JSON encoding, rather than terminal interpretation, is its boundary.
- Durable stores now validate a new pause/cancel request against event-derived state inside the write transaction. This prevents a stale terminal or CLI observation from stranding an unacknowledgeable control after settlement while retaining the original receipt for an already accepted operation ID.
- The execution supervisor now distinguishes an expected force-terminated runtime host from an unexplained nonzero exit, waits for the authenticated process group to become empty, and lets termination requests outlive the graceful cancellation interval. This preserves fail-closed behavior when absence is still uncertain while allowing a confirmed cleanup to finish pause/cancel.

`LiveRunEvent`, `RunState`, the durable control record, lease semantics, and coordinator resume behavior required no schema or migration change. The terminal view remains a disposable projection. Complete-history reads are integrity checked and acceptable for the initial local MLP client; a measured tail-read optimization can replace that read shape later without changing the terminal contract.

## Completion gates

The implementation passes the focused terminal set, complete Vitest suite, typecheck, ESLint/JSDoc, formatting, contributor hygiene, whole-repository and strict-production dead-code analysis, generated API documentation, the expanded-graph process matrix, and both owner-authenticated live audits. The pull request's Linux, macOS, dependency-review, DCO, and CodeQL results are recorded in the pull request before merge.
