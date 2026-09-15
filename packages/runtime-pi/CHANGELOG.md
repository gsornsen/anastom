# @anastom/runtime-pi changelog

## Unreleased

- Declare supported filesystem modes and accumulate available assistant-call usage once per attempt, retaining partial coverage and configured/reported identity provenance without persisting private SDK bodies.
- Make concurrent cancellation and terminal results immutable under bounded event-queue pressure.
- Add fresh ephemeral Pi sessions with explicit context, model selection, bounded events, and cancellation.
- Normalize public provider/model identity while keeping credentials and private reasoning out of events.
- Pin and document the Pi SDK boundary; support injectable deterministic lifecycle tests.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
