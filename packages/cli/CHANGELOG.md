# @anastom/cli changelog

## Unreleased

- Compose process-independent Feature topology loading, task workspace creation, scoped patch capture, and prepared integration recovery behind the durable coordinator boundary.
- Keep CLI inspection and injected-output helper types internal to their actual source modules instead of advertising unused entry-point exports.
- Compose the fenced store, shared execution host, exact runtime registry, workspace checkpoints, and artifact store for recoverable Pi, Codex, and Claude Code Task runs. Add `pause`, `cancel`, and `resume`, operation IDs, operational status/inspection, snapshot provenance, typed ownership diagnostics, and exit-code `2` for invalid usage or missing runs. Remove the superseded fake Task path while retaining deterministic fake YAML workflows.
- Scope authored Task/Workflow/schema reads to the CLI's current source directory, rejecting absolute, traversal, and symlink escapes; run from the containing source tree when using an external Task file.
- Add explicit Claude Code provider/model/subscription-or-API-key selection with source/native preflight before run state, and reject incompatible or incomplete selections.
- Add explicit Codex CLI provider/model/reasoning selection and selected-runtime capability preflight before worktree or durable state creation.
- Reconstruct recorded negotiation, provider/model provenance, and available partial token usage in later-process status/inspection without provider authentication.
- Add explicit runtime selection for Markdown tasks and durable cross-process status/inspection.
- Preserve process-local YAML fake workflows and deterministic validation/graph commands.
- Document CLI boundaries and contributor-readable durable execution tests.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
