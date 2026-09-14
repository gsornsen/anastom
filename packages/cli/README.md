# @anastom/cli

Expose local operator commands for validation, graph rendering, execution, status, and durable evidence inspection.

## Public API

`runCli(args, options)` returns an exit code with injectable IO. YAML fake workflows retain process-local storage. Markdown task execution creates SQLite state and filesystem artifacts under the selected state directory; separate processes can inspect the resulting run ID.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api cli`; output is in `.generated/api/cli/` and is not committed.

## Boundaries and invariants

Task runs require an explicit runtime. Fake execution requires an explicit scenario; Pi supports an optional paired provider/model selection and normal operator authentication. Local task and schema filenames are operator-controlled, not a remote authorization boundary. Run IDs and artifact locations are not access credentials.

## Development

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test packages/cli
pnpm typecheck
pnpm lint
```

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code/contract changes; maintainers review SemVer plans and generate versioned entries in the [package changelog](CHANGELOG.md). Packages remain private at `0.0.0` until the first reviewed versioning step. Package versions and IR/schema versions are separate compatibility boundaries.

## Current scope

Single-worker task execution is delivered. Parallel graphs, approvals, durable worker recovery, and additional runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
