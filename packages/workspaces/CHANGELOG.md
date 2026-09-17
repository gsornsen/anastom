# @anastom/workspaces changelog

## Unreleased

- Keep checkpoint capture and comparison result shapes reachable through their functions without redundant direct type re-exports.
- Add exact double-captured workspace checkpoints with bounded binary diffs, streamed ignored-content identity, canonical Git ownership evidence, staging preservation, and field-classified comparison.
- Store and validate isolated and readonly workspace ownership manifests through the fixed-segment private-state root.
- Create run-owned Git worktrees and explicit readonly source references.
- Capture tracked, untracked, and committed changes without changing worker staging.
- Retain work by default and enforce conservative idempotent cleanup.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
