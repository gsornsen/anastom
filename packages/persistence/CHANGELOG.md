# @anastom/persistence changelog

## Unreleased

- Add the M3 SQLite durable store and additive migration with transaction-time leases, exact absent-owner takeover, fenced idempotent mutations, deduplicated controls, rolling event integrity, snapshot fallback, and byte-preserving legacy upgrades.
- Create artifact parent directories through the shared private-state root and atomically publish synced immutable artifact files without replacement.
- Add durable canonical workflow snapshots, append-only events, and optimistic concurrency checks.
- Add versioned transactional SQLite migrations with checksummed history, schema validation, and safe legacy adoption.
- Store confined immutable filesystem artifacts with private permissions and SHA-256 verification.
- Reject run-owned symlinked artifact parents and nonordinary files during later-process reads.
- Require an existing caller-authorized database parent, and keep the production SQLite busy timeout while allowing the internal contention test to fail immediately and deterministically.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
