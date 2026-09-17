# 0010 — Enforce contributor hygiene and version database schemas

- Status: Accepted and implemented; final revision `1dde54d` approved and PR #9 merged as `af8eb87`
- Date: 2026-09-13

The unversioned-database adoption decision below was superseded before the first supported release by [ADR 0018](0018-m3-production-contract-and-package-boundaries.md), which consolidates the complete durable schema as migration one and rejects unjournaled databases.

## Context

Owner review of the single-worker implementation identified compressed code and tests, undocumented APIs, embedded schemas, unversioned initialization SQL, and missing package development conventions. These concerns apply to existing code as well as new packages. The owner explicitly requested implementation before approval and merge.

## Decision

Use Prettier for formatting, standard ESLint readability and modified complexity rules, and the JSDoc plugin for public APIs. Document every package with a README and CHANGELOG. Generate optional per-package HTML through TypeDoc; validate meaningful exported declarations and methods while relying on TypeScript for ordinary property types. Generated documentation remains untracked.

Use Changesets for reviewed SemVer plans and manual version/changelog generation, including private packages. A repository hygiene gate checks metadata, package documents, and release plans for changed package code. No automatic publication or tags are enabled. Do not duplicate standard ESLint rules with custom rules.

Keep authored and normalized schemas in versioned assets. The unreleased worker summary contract requires at least thirty non-whitespace characters; this rejects blank/padded reports but does not prove truthful introspection. Deterministic verification continues to decide acceptance. Existing run snapshots retain their embedded schema contracts.

Move initial run-store SQL into an immutable numbered migration with a manifest. Add a checksummed metadata journal and user_version. Validate complete schema history and schema objects, apply pending steps in one immediate transaction, and roll back DDL/journal changes on failure. Adopt the exact original unversioned schema without rewriting workflow/event bytes. Reject drift, gaps, changed applied SQL, and databases newer than the application. Backup-based recovery replaces destructive automatic down migrations. This metadata table is an owner-requested refinement of the initial two-application-table scope.

Allow fake file contents to use `{ fromFile: "./relative-source.mjs" }`, confined to the scenario directory including resolved symlinks. Resolve and materialize sources at scenario load time before execution; preserve inline contents. Use capability names for executable fixtures, tests, and CI. Keep historical milestone documents and original evidence identities. Consolidate duplicated durable fake demos into actual cross-process CLI test coverage.

## Consequences

`buildContext` takes named options rather than six positional parameters; this is an unreleased API refinement covered by tests and package docs. New worker definitions embed the stronger schema, so their digests differ from historical runs. Existing normalized snapshots and event histories remain inspectable. Startup validates migrations even for status/inspection; incompatible or damaged databases fail closed. The optional API generator and standards are tooling, not new worker orchestration capabilities. The owner reviewed the final lint correction and authorized merge; PR #9 is merged.

The [engineering standards](../ENGINEERING.md) contain test conventions, CI ownership, UUIDv4 rationale, and release/migration procedures.
