# @anastom/runtime-pi changelog

## Unreleased

- Strengthen the machine-readable final-response instruction and allow one format-only structured-output correction in the same attempt before returning a schema violation.
- Use the descriptor codec as the sole public parsing boundary instead of also exporting its implementation parser.
- Add an exact versioned descriptor codec that freezes explicit or ambient provider/model selection without persisting Pi authentication, session state, prompts, or test factories.
- Declare supported filesystem modes and accumulate available assistant-call usage once per attempt, retaining partial coverage and configured/reported identity provenance without persisting private SDK bodies.
- Make concurrent cancellation and terminal results immutable under bounded event-queue pressure.
- Add fresh ephemeral Pi sessions with explicit context, model selection, bounded events, and cancellation.
- Normalize public provider/model identity while keeping credentials and private reasoning out of events.
- Pin and document the Pi SDK boundary; support injectable deterministic lifecycle tests.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
