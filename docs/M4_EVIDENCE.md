# M4 defined-SDLC evidence

## Status

The production-shaped model-free process matrix passes on the owner macOS arm64 host. It uses the same Feature compiler, durable coordinator, SQLite store, execution supervisor, artifact store, Git workspace topology, prepared integration path, evidence projection, and later-process CLI inspection as a provider-backed run. It makes no model call and reads no provider authentication.

M4 is not complete yet. The unchanged controlled Feature must still pass through the owner-authenticated Pi and Codex selections, and the final implementation candidate must pass Linux/macOS CI and repository policy gates. This document will record those results when they exist.

Run the deterministic process evidence from the repository root:

```bash
pnpm verify:defined-sdlc
```

## Process matrix

The accepted run on 2026-09-17 used Node.js `v26.4.0` on Darwin arm64.

| Case                                           | Observed result                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Left task completes first                      | Run succeeded; workers overlapped; retained integration branch; 39 artifact digests re-read successfully                                                                                                           |
| Right task completes first                     | Run succeeded with the opposite completion order and the same deterministic integration result; 39 artifact digests re-read successfully                                                                           |
| Pause with two active workers                  | Both owned executions reported confirmed cancellation before the run became `paused`                                                                                                                               |
| Cancel with two active workers                 | Both owned executions reported confirmed cancellation before the run became `cancelled`                                                                                                                            |
| One worker fails                               | The still-active sibling was cancelled and the run failed without changing the source checkout                                                                                                                     |
| Independent review rejects                     | The run failed and the operator verifier never started                                                                                                                                                             |
| Operator verifier exits nonzero                | The run failed and retained exact exit code `7`                                                                                                                                                                    |
| Coordinator dies after integration preparation | A later process observed the original owner absent, waited for the real lease boundary, committed the prepared integration exactly once, rejected the stale fence with `ownership-conflict`, and completed the run |

Both successful runs were inspected from a later CLI process. Each retained two deterministic integration records, three accepted patch identities, a clean operator checkout, a reviewable `anastom/<run-id>--integration` branch, and a passing operator-authored verifier. The protected acceptance program remained byte-identical. Every case left the operator checkout clean.

## Contract findings

Process acceptance exposed two contract gaps before live calls:

- Verifier inputs could be described as protected in the design, but the Feature had no explicit field. `policies.protectedPaths` now carries normalized repository-relative policy inputs into the immutable Feature snapshot and run topology. Command arguments remain opaque and are never guessed to be paths.
- Expanded node IDs contain dots, and those IDs already participate in artifact identity. Workspace checkpoints now accept the same dotted artifact grammar as the producer and store.

The acceptance fixture also found a test lifecycle defect: a deliberately held adapter awaited an unresolved promise without retaining an event-loop handle, allowing Node to exit before a later control request. The fixture now owns an explicit handle until settlement, and every captured coordinator wait is bounded so a recurrence fails with a useful timeout instead of hanging.

## Remaining completion evidence

The final M4 record must add:

- one unchanged Feature run through Pi with its effective provider/model identity;
- one unchanged Feature run through Codex using the owner-selected Terra model at medium reasoning effort;
- overlapping worker intervals, deterministic integration, independent structured reviews, passing authored verification, clean source checkouts, retained integration branches, complete bounded artifacts, and private-data audits for both live runs;
- final Linux and macOS CI, typecheck, lint/JSDoc, formatting, hygiene, whole-repository and strict-production dead-code analysis, API documentation, DCO, dependency review, and CodeQL results; and
- the consolidated main-targeting feature branch and owner review.
