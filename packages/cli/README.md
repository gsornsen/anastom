# @anastom/cli

Expose local operator commands for validation, graph rendering, execution, status, and durable evidence inspection.

## Public API

`runCli(args, options)` returns an exit code with injectable IO. Run Anastom from a directory containing the authored Task, Feature, or Workflow source tree: CLI-selected files and workflow schema references must remain inside its current directory after physical resolution. `--repo` can target a separate Git checkout for a Task; a Feature must live inside its selected target repository so its policy and verifier definitions remain protected. Direct core loaders remain available for trusted local callers with their own file authorization. YAML workflows use the deterministic fake runtime and process-local persistence. Pi, Codex, and Claude Code Task and Feature runs use the fenced store, shared execution host, exact descriptor registry, workspace checkpoints, and artifact store. A Feature run snapshots `sdlc/default`, creates one run-owned integration branch, and delegates expanded task workspaces through the coordinator. Each committed public observation streams as concise colored text when stdout is a TTY or one schema-valid JSON value per line when stdout is piped. Separate processes can inspect events, the derived evidence ledger, lease, pending-control, and snapshot evidence or issue `pause`, `cancel`, and `resume` with a printed UUIDv4 operation ID.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api cli`; output is in `.generated/api/cli/` and is not committed.

## Boundaries and invariants

Task and Feature runs require an explicit supported runtime. Feature runs additionally require `--method sdlc/default`; the method is selected by an exact Allow List and snapshotted before durable state. Pi supports an optional paired provider/model selection and normal operator authentication. Codex requires `--runtime codex --provider openai --model <id>` and accepts `--reasoning-effort <level>`. Claude Code requires `--runtime claude-code --provider anthropic --model <id> --auth-source subscription|api-key` with no implicit billing-source fallback. The CLI resolves a credential-free descriptor before durable creation, then reruns the selected adapter's executable, authentication, managed-policy, and capability preflight under ownership before scheduling an attempt. The package [guide](../runtime-claude-code/README.md) documents its safe/restricted profile and bare API-key Read/Edit limitation. Mixed or incomplete selections fail without a runtime fallback. `status` and `inspect` read SQLite, process identity, lease, controls, and snapshot provenance without acquiring ownership, contacting a runtime, or starting a worker. Incomplete ownership or runtime records are corrupt store data and fail closed. Local authored filenames are operator-controlled, not a remote authorization boundary. Run IDs and artifact locations are not access credentials.

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

Single-worker Task execution and `sdlc/default` Feature execution are available through Pi, Codex, and Claude Code with durable operator controls, crash recovery, bounded live output, and later-process evidence inspection. Feature runs retain their run-owned integration and implementation branches for review; automatic merge into the operator branch is outside this command. Deterministic YAML workflows use the fake runtime. The production-shaped Feature process matrix passes; paired live Pi/Codex evidence remains before defined-SDLC completion. Interactive terminal controls, approval gates, and further runtime integrations remain roadmap work; see [milestones](../../docs/MILESTONES.md).

License: [AGPL-3.0-only](../../LICENSE).
