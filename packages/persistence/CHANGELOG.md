# @anastom/persistence changelog

## Unreleased

- Create artifact parent directories through the shared private-state root and atomically publish synced immutable artifact files without replacement.
- Add durable canonical workflow snapshots, append-only events, and optimistic concurrency checks.
- Add versioned transactional SQLite migrations with checksummed history, schema validation, and safe legacy adoption.
- Store confined immutable filesystem artifacts with private permissions and SHA-256 verification.
- Reject run-owned symlinked artifact parents and nonordinary files during later-process reads.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
