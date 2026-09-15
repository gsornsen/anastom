# @anastom/engine changelog

## Unreleased

- Preflight selected worker capabilities before durable creation; persist versioned negotiation, sanitized identity, and at most one partial/complete usage observation through append-only events and replay.
- Preserve a sanitized typed runtime policy rejection when a worker refuses to start, and stop retrying that attempt.
- Render unavailable and partial counters explicitly while keeping verification and historical event histories independent of telemetry.
- Add fresh frozen contexts, bounded independent verification, timeout diagnostics, and artifact observations.
- Keep orchestration harness-independent and replay validated typed transitions.
- Expose readable evidence rendering and named context construction options.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
