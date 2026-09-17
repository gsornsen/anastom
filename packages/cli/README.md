# @anastom/cli

Expose local operator commands for validation, graph rendering, execution, status, and durable evidence inspection.

## Public API

`runCli(args, options)` returns an exit code with injectable IO. Run Anastom from a directory containing the authored Task/Workflow source tree: CLI-selected Task/Workflow files and workflow schema references must remain inside its current directory after physical resolution. `--repo` can still target a separate Git checkout. Direct core loaders remain available for trusted local callers with their own file authorization. YAML fake workflows and Task runs selected with arbitrary fake scenario paths retain the earlier nonrecoverable execution path. Pi, Codex, and Claude Code Task runs use the M3 fenced store, shared execution host, exact descriptor registry, workspace checkpoints, and artifact store. Separate processes can inspect the run's event state beside lease, pending-control, and snapshot evidence or issue `pause`, `cancel`, and `resume` with a printed UUIDv4 operation ID.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api cli`; output is in `.generated/api/cli/` and is not committed.

## Boundaries and invariants

Task runs require an explicit runtime. Fake execution requires an explicit scenario and does not claim restart reconstruction. Pi supports an optional paired provider/model selection and normal operator authentication. Codex requires `--runtime codex --provider openai --model <id>` and accepts `--reasoning-effort <level>`. Claude Code requires `--runtime claude-code --provider anthropic --model <id> --auth-source subscription|api-key` with no implicit billing-source fallback. The recoverable path resolves a credential-free descriptor before durable creation, then reruns the selected adapter's current executable, authentication, managed-policy, and capability preflight under ownership before scheduling an attempt. The package [guide](../runtime-claude-code/README.md) documents its safe/restricted profile and bare API-key Read/Edit limitation. Mixed or incomplete selections fail without a runtime fallback. `status` and `inspect` read SQLite, process identity, lease, controls, and snapshot provenance without acquiring ownership, contacting a runtime, or starting a worker. Old histories stay inspectable; `resume` records `history-incompatible` instead of guessing absent descriptor or execution flags. Local task and schema filenames are operator-controlled, not a remote authorization boundary. Run IDs and artifact locations are not access credentials.

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

Single-worker task execution and three source adapters are delivered through M2.5. The M3 review stack now includes CLI composition and operator commands; its final process-level crash/recovery acceptance remains before milestone completion. Parallel graphs, approvals, and further runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
