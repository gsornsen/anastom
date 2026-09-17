# @anastom/execution-host changelog

## Unreleased

- Remove unused direct exports for the runtime resolver and serialized-command assertion while preserving the documented host and protocol entry points.
- Add the shared local POSIX execution host with two-phase launch authorization, explicit pre-launch readiness, private digest-bound control records, bounded authenticated Unix-socket IPC, isolated runtime reconstruction, command execution, public observation relay, parent-death cleanup, and fail-closed inspection.
- Add checked-in model-free process fixtures and conformance across Pi, Codex, Claude Code, and command execution, including success, cancellation, coordinator death, supervisor loss, protocol tampering, and retained-log pressure.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
