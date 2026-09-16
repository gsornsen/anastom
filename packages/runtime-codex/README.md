# @anastom/runtime-codex

Adapt the exact-pinned Codex CLI to Anastom's single-worker runtime contract. One filesystem agent attempt owns one fresh `codex exec --json` POSIX process group. Routine tests use synthetic executable and provider doubles; they require no owner credentials or model calls.

## Public API

`CodexRuntimeAdapter` requires an explicit `openai` provider and model ID, with an optional reasoning effort. `codexRuntimeDescriptorCodec` validates and reconstructs its exact versioned public selection with fixed file-store authentication ownership; executable and auth-directory overrides never enter the descriptor. The adapter declares supported workspace modes, checks the effective native policy before a model call, starts a bounded execution process, emits sanitized public lifecycle/identity/partial-usage observations, validates the final report, and confirms process cleanup before success. `validateSelection` checks selection before creating state.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api runtime-codex`; output is in `.generated/api/runtime-codex/` and is not committed.

## Boundaries and invariants

The project dependency and matching native platform package must be `@openai/codex@0.154.0`; a global executable is never substituted. Supported process ownership is Linux/macOS on x64/arm64. Normal file-backed Codex authentication remains in the operator's store; the adapter uses a temporary link and never reads, copies, or logs its bytes. Auth-file resolution requires a regular `auth.json` under the normal home-rooted Codex directory; test overrides are confined to the temp root. A short-lived native app-server policy read rejects managed requirements/configuration or unavailable policy evidence before `codex exec`. Each attempt uses owned discovery roots, explicit bounded instructions and output schema, a narrow model catalog, read-only or workspace-write sandboxing, disabled worker command network access, and no interactive approvals. The independent verifier remains in Anastom's control plane. The policy refinement was accepted in [ADR 0014](../../docs/adr/0014-codex-managed-policy-preflight.md).

The process decoder caps native JSONL frames at 1 MiB and private stderr capture at 64 KiB. Only reviewed public summaries enter durable events. Success requires a valid JSON report, completed native turn, exit zero, and confirmed absence of owned descendants. Cleanup inspects live process-group members on Linux and macOS so zombie-only groups do not create false uncertainty, while a bounded failure still prevents safe retry. This trusted-tool process-group profile is not a hostile-process security boundary; Windows and custom Codex providers are outside this package's current scope. Native context handling and normal-auth readiness are covered by the [M2 feasibility record](../../docs/M2_FEASIBILITY.md) and [build brief](../../docs/M2_BUILD_BRIEF.md).

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/runtime-codex
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step.

License: [AGPL-3.0-only](../../LICENSE).
