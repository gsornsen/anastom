# Engineering standards

These standards apply to existing code and every new pull request. They are maintained with the implementation, not treated as a one-time setup checklist. Maintainers review their usefulness whenever architecture, execution environments, or package boundaries change.

## Readability and API discovery

Use descriptive capability names in production code, fixtures, tests, and CI. Names such as `health-endpoint`, `Durable task execution`, and `macOS filesystem and process portability` remain useful beyond a planning milestone. Package source, comments, JSDoc, identifiers, filenames, fixture values, and test names must stand on their own without labels such as `M1`, `M2`, or `M3`. Historical roadmaps, build briefs, evidence, retrospectives, ADR context, and changelog entries keep milestone identities when they explain project history.

Prefer one statement per line, named options over long positional argument lists, explicit control flow, and named helpers for separate decisions or output sections. Prettier owns formatting. ESLint enforces braces, no nested ternaries, at most four nested blocks, three nested callbacks, four parameters, and modified cyclomatic complexity at most twenty. The modified measure counts a switch as one branch so exhaustive typed event dispatch remains readable without an arbitrary handler framework. These are review guardrails, not a reason to split coherent logic into meaningless functions.

Public functions, classes, methods, interfaces, type aliases, exported constants, and exported object capabilities need useful JSDoc. Describe purpose, side effects, ownership, defaults, invariants, errors, and security boundaries where they affect callers. Use `@remarks`, `@throws`, `@returns`, and examples when helpful; TypeScript owns type information, so avoid redundant JSDoc types. Private helpers need documentation when their rationale or behavior is not evident from their name. Documentation must explain the behavior, not paraphrase the identifier.

ESLint requires a description on every JSDoc block, including classes, interfaces, type aliases, and constants. Reviewers assess whether that description is useful; the lint rule catches empty documentation.

Every workspace package has a README and CHANGELOG. Package READMEs describe purpose, public entry point, supported behavior, boundaries, and development commands. Update them when their contract changes. Optional `pnpm docs:api <package>` generates HTML from exported TypeScript and JSDoc under `.generated/api/<package>/`; omit the package to generate all workspace packages. Generated documentation stays untracked and is not published automatically. `pnpm docs:api core` is a useful API review check when changing core contracts.

Standard ESLint rules and the JSDoc plugin cover current readability needs. The repository-specific `pnpm hygiene` gate checks package metadata, documentation, release plans, and milestone-independent package source language. Add a custom ESLint rule only for a concrete recurring AST-level mistake that existing rules cannot express; include positive and negative cases. Avoid maintaining custom duplicates of standard checks.

The hygiene gate is structural. It does not decide whether prose or JSDoc is accurate and useful, whether a test protects meaningful behavior, whether a proposed SemVer level matches the contract change, or whether a migration may be edited after release. ESLint, TypeDoc, focused behavior checks, version history, and reviewer judgment own those questions. Root README and changelog accuracy remain pull-request requirements rather than filename-change quotas.

Executable process doubles live in checked-in files. The `anastom/no-inline-scripts` ESLint rule rejects script shebangs embedded in strings and source passed through interpreter evaluation flags. Its file-backed positive and negative AST fixtures run as part of `pnpm lint`; ordinary paths and messages remain allowed.

## Definition of done for implementation

An implementation or refactor is complete only after its replacement boundary has been audited, not merely after the new path works. Inspect the changed capability and its callers, then delete source files, exports, types, dependencies, commands, options, wrappers, fixtures, and configuration that no current supported path needs. Delete or rewrite tests whose subject or expected behavior was superseded. Review the README, package documents, current architecture and contract documents, examples, and local links for claims that the change made stale. Retain historical evidence, build briefs, retrospectives, and decision records when they explain the project history; label superseded conclusions instead of rewriting history.

Run `pnpm dead-code` as part of that audit. Knip parses TypeScript and JavaScript imports and exports and checks workspace dependencies twice: the complete repository pass finds unused files, exports, types, dependencies, and test support; strict production mode also finds implementation reachable only from tests and verifies direct workspace dependency ownership. Dynamically launched file-backed executables are listed as exact entry points in `knip.json`. Do not replace those entries with broad directory allowances, because a broad entry would make an abandoned fixture appear live.

An exported symbol with no in-repository production caller needs an explicit reason. Use `@public` only for a deliberate package contract described in that package's README. Use `@internal` only when a production module boundary or focused test requires an export that is not part of the package entry point. Review these tags when the contract or test seam changes; do not use them to silence uncertain findings. Static reachability cannot determine whether a reachable test still protects supported behavior or whether prose is still true, so the pull-request review must record that semantic audit.

During MLP development, remove superseded paths in the same change that replaces them. Compatibility code remains justified only by a current supported caller, an already released contract, or retained user data. A future possibility is not a current use case.

## Contributor-friendly tests

Name tests for observable behavior and the failure being protected against. Explain non-obvious fixture starting conditions, then keep setup, execution, and assertions easy to distinguish. Use typed transport shapes and named helpers such as `createdRunId`, `inspectInNewProcess`, and `evidence`, rather than dense casts, nested regular expressions, or unexplained non-null assertions.

The HTTP fixture starts with a server that returns 404 and a failing health acceptance test. Deterministic acceptance support supplies the endpoint implementation from a separate JavaScript file. The engine's verifier runs the fixture tests independently. Process-level durable acceptance launches the actual CLI in later processes so process-local memory cannot satisfy persistence assertions. Shared fixture setup lives in `packages/engine/src/testing/fixture.ts`; it is test support, not a package export.

Tests should protect observable behavior and material failure paths. Add meaningful migration, confinement, validation, cancellation, and supported-compatibility tests when changing those boundaries. Avoid tests that merely assert formatting or repeat implementation details. Run focused checks while iterating; run the complete required checks before requesting review.

## Versioning and compatibility

Before the first supported release, replace superseded internal APIs and data paths directly. Delete transitional wrappers, duplicate implementations, and compatibility-only tests once all current call sites migrate. Retain compatibility code only for a current supported caller, an already released contract, or user data the project has committed to preserve; name that concrete boundary instead of calling it merely “legacy.” Record the decision when compatibility has a material maintenance cost.

Use SemVer for every package. Add a new Changeset to the PR for changed package code or contracts, selecting patch for compatible fixes, minor for compatible additions, and major for incompatible public APIs. Explain compatibility for persisted data and IR/schema versions separately. Initial private development manifests remain 0.0.0; this PR plans the initial 0.1.0 feature release. A SemVer plan is reviewed before it becomes a release.

`pnpm hygiene` requires useful README/CHANGELOG files, valid canonical SemVer, the expected package identity and license, and a new or changed release plan for affected packages. Test-only and documentation-only changes do not require one. Use `ANASTOM_HYGIENE_BASE=<ref>` for an intentional alternative comparison base; the default is `origin/main`. The gate inspects committed changes plus staged, unstaged, and untracked work. CI fetches history so the base exists. A versioning PR may instead contain changed manifest versions and package changelog entries after Changesets consumes the plans. Humans still assess whether the selected release level is correct.

Maintainers run `pnpm version:packages` in a reviewed release PR and refresh the lockfile with `pnpm install`. Changesets applies package versions and prepends generated changelog entries. Private packages are versioned; automatic tags and publication are disabled. Review dependency compatibility, required checks, and README/root changelog updates before approving a release.

Versioned JSON Schemas are committed assets. Changing an unreleased schema is permissible with explicit evidence; once released, incompatible changes require a new contract version and compatibility decision. Stored normalized definitions contain their original schema snapshots, not whatever schema is current at inspection time.

## SQLite migrations and recovery

Numbered SQL and `migrations/manifest.json` define immutable schema history after the first supported release. Before that release, consolidate the initial schema instead of accumulating migrations for unreleased compatibility. A checksummed `schema_migrations` journal and SQLite `user_version` track applied steps. Startup validates known schema objects, foreign keys, integrity, and applied checksums before executing pending migrations under one immediate transaction. Any failure rolls back all pending DDL and journal entries. A nonempty database without migration history fails closed.

Before a schema upgrade, make a consistent SQLite backup using SQLite's backup facilities or stop writers before copying the database and its WAL. Test the upgrade against representative evidence. A database from a newer application, a missing migration, altered checksum, or schema drift fails closed. Restore a verified backup or use an application compatible with that schema; automatic destructive down migrations would endanger retained run evidence and are excluded.

## Identifier rationale

Run and Pi execution IDs use [`node:crypto.randomUUID()`](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptorandomuuidoptions), which generates UUIDv4 using a cryptographic pseudorandom generator. UUIDv4 has 122 random bits after version and variant bits. Node may cache entropy for up to 128 UUIDs; that is an efficiency mechanism, not deterministic seeding. These IDs provide independent identity with negligible accidental collision risk; they are not credentials or authorization tokens. Event sequences determine order rather than UUID sort order. Do not substitute `Math.random` or test statistical randomness in unit tests.

## Check ownership and CI evolution

| Check               | Purpose                                                                            | Placement          |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| Full Vitest suite   | Behavior, contracts, failure paths, and actual cross-process durable CLI execution | Required Linux job |
| TypeScript          | Type and package-boundary compatibility                                            | Required Linux job |
| ESLint + JSDoc      | Readability and typed correctness                                                  | Required Linux job |
| Prettier            | Consistent formatting across TS, JS, JSON, YAML, and Markdown                      | Required Linux job |
| Dead-code gate      | AST reachability, export surface, dependency ownership, and production-only use    | Required Linux job |
| Hygiene gate        | Package source terminology, docs, metadata, and reviewed SemVer plans              | Required Linux job |
| YAML CLI demo       | Source CLI launcher smoke check and original workflow compatibility                | Required Linux job |
| macOS focused tests | Platform-dependent Git, SQLite, path, and process termination behavior             | Separate macOS job |
| Dependency review   | New dependency vulnerabilities and license review signal                           | PR workflow        |
| CodeQL              | Static security analysis; individually triage findings without disabling queries   | Security workflow  |
| DCO                 | Contribution provenance on every commit                                            | PR workflow        |

The required Linux display name remains `Test, types, lint, and demo` to preserve its branch protection identity. The redundant durable fake demo step was removed: durable CLI tests already execute that complete boundary. macOS repeats only behavior whose filesystem or process implementation differs by platform; Codex's native-install/auth-link profile and process-group cleanup tests join that focused job. No live model call or provider credential belongs in routine CI.

For each proposed CI check, identify its unique failure boundary, owner, platforms, cost, and relation to existing coverage. Consolidate duplicates and remove obsolete checks when capabilities or environments change. Reassess this inventory with every new runtime, storage backend, platform, package, or release process. New checks use capability names; milestone evidence remains in historical milestone documents.
