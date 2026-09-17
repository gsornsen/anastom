# @anastom/core changelog

## Unreleased

- Remove unused direct exports for implementation-only schema shapes, status constants, and duration normalization while retaining the documented compiler and loader contracts.
- Add scoped Task/Workflow source loaders that confine authored files and local schema references to a caller-authorized root while preserving trusted direct loaders.
- Add strict Markdown Task compilation with a worker and independent command verifier.
- Store authored and normalized contracts in versioned JSON Schema assets; require descriptive worker summaries.
- Preserve existing Workflow IR validation, deterministic normalization, and canonical evidence digests.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
