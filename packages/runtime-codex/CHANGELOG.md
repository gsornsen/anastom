# @anastom/runtime-codex changelog

## Unreleased

- Narrow the package entry point to the adapter, descriptor codec and documented public types; prompt, selection, version and parser helpers remain implementation details.
- Give each bounded process-table inspection 500 ms while preserving the one-second group reap window, preventing spurious cleanup uncertainty under concurrent load.
- Add an exact versioned descriptor codec for OpenAI model, optional reasoning effort, and file-store auth ownership while excluding executable and auth-directory overrides.
- Add the exact-pinned native Codex CLI adapter for one fresh owned filesystem agent attempt, with explicit OpenAI model selection, capability preflight, bounded discovery/context profile, and normal file-backed authentication ownership.
- Add a model-free native effective-policy inspection before Codex execution; managed requirements/configuration and unavailable policy evidence fail closed without starting the model.
- Normalize native lifecycle, configured identity, and partial token usage while dropping private transcript, tool, reasoning, and provider-error bodies.
- Require schema-valid final reports, successful native exit, and confirmed process-group/descendant cleanup before success; add deterministic process and shared conformance doubles.
- Confine auth-file resolution to supported home/temp roots and regular `auth.json` files; inspect live Darwin group members when group-wide `kill(0)` returns `EPERM`, while preserving bounded cleanup rejection on uncertainty.
- Inspect live process-group members on Linux and macOS, exclude zombie-only groups, and allow a bounded one-second reap window before declaring Codex cleanup uncertain.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
