# @anastom/runtime-fake changelog

## Unreleased

- Keep scenario implementation shapes and validation errors internal while retaining the documented scenario parser, loader and adapter API.
- Resolve scenario `fromFile` references through the shared existing-child policy without changing Fake's stricter relative-input grammar.
- Preserve M0 fake behavior while adding declared workspace-mode capabilities, defensive scenario/request/result ownership, immutable terminal outcomes, and shared adapter conformance coverage.
- Support authorized deterministic workspace edits for worker task demonstrations.
- Allow file references relative to the scenario directory alongside inline text.
- Validate scenario assets with a versioned schema and reject unsafe source or target paths.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
