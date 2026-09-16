# @anastom/runtime-claude-code

Adapt an end-user-installed, unmodified Claude Code CLI to Anastom's one-worker `RuntimeAdapter` contract. Anastom selects one explicit Anthropic model and one explicit authentication source; Claude Code itself owns sign-in, credentials, provider requests, and billing. Routine tests use committed process doubles and localhost fake model responses, with no real provider calls.

## Setup and API

Install Anthropic's official native Claude Code `2.1.268` release separately using its [setup guide](https://code.claude.com/docs/en/setup). This package does not depend on or redistribute Anthropic's proprietary binary. The adapter resolves the native installer path in the operator's home directory, checks ordinary-file/executable metadata, and compares its SHA-256 with the signed release manifest before every attempt. Process ownership is supported on Linux/macOS arm64/x64.

`ClaudeCodeRuntimeAdapter` requires `provider: "anthropic"`, an explicit model ID, and `authSource: "subscription" | "api-key"`. The [source entry point](src/index.ts) and [M2.5 build brief](../../docs/M2_5_BUILD_BRIEF.md) define its selected capability preflight, request snapshot, bounded JSONL/public-event handling, schema-valid report, and confirmed process-group cleanup. The engine independently validates final output and runs the Task verifier. Generate optional API documentation with `pnpm docs:api runtime-claude-code`; generated HTML is not committed.

For `subscription`, log in to the official Claude Code CLI in your own terminal (`claude auth login`). Model-free preflight requires a first-party Claude.ai Pro/Max login and rejects an ambient `ANTHROPIC_API_KEY`, custom provider/base URL, or custom Claude configuration directory. The native invocation uses `--safe-mode --restricted`; it exposes Read, Glob, Grep, Write, and Edit in an isolated worktree, and read tools only in readonly mode.

For `api-key`, set your own `ANTHROPIC_API_KEY` in the environment. Native `--bare` mode does not use a Claude.ai subscription or OAuth/keychain credentials; the adapter never persists or prints the key. In the pinned CLI release, bare mode exposed only Read and Edit under the restricted profile. It can read and edit existing workspace files, but does not expose Write, Glob, or Grep, so new-file creation and file discovery through those tools are unavailable in this mode. That limitation is part of the reviewed initial profile, not an automatic fallback to subscription billing. An API-billed live demonstration requires a separate owner choice.

The CLI selection is:

```bash
pnpm anastom run examples/demo-repos/health-endpoint/tasks/add-endpoint.md \
  --runtime claude-code --provider anthropic --model YOUR_CLAUDE_MODEL \
  --auth-source subscription --repo YOUR_FRESH_FIXTURE
```

Use `--auth-source api-key` only for Tasks that the available Read/Edit surface can perform. The control plane creates an isolated Git worktree for mutating Tasks and retains its evidence.

## Boundaries

Both modes use `--restricted`, `--strict-mcp-config`, `dontAsk`, no session persistence, an explicit built-in tool allowlist, a schema-constrained final report, and one owned POSIX process group per attempt. The model-free policy gate rejects endpoint-managed Claude Code files and the effective macOS managed-preference domain or matching managed-preference files. Subscription mode admits Pro/Max accounts only; Anthropic's documented server-managed settings require Team/Enterprise accounts. If effective policy evidence is unavailable, preflight rejects. Safe mode cannot suppress policy-configured hooks, so this gate is a necessary part of the profile.

Native tool bodies, thinking, transcripts, raw errors, account identity metadata, and credentials never enter public events. Reported model identity must match configured selection. Anthropic result-level usage is mapped to inclusive input/cache/output counters with partial coverage; it is neither a billing record nor an execution-success signal. JSONL frames are limited to 1 MiB and total stdout to 16 MiB; public logs are bounded and droppable while required observations remain. Cancellation and terminal acceptance require confirmed group cleanup, including descendants and zombie-only groups. The native CLI may make multiple model requests within one allowed turn; Task duration and process cancellation are the authoritative limits.

Anthropic's [legal guidance](https://code.claude.com/docs/en/legal-and-compliance) allows end users to sign in to an unmodified Claude Code binary with their own subscription, but restricts third-party login, credential routing on users' behalf, intermediation, and resale. The local-direct interpretation and its remaining automation ambiguity are recorded in [ADR 0015](../../docs/adr/0015-claude-code-worker-profile.md); this adapter offers no Anastom login or request proxy. [M2.5 feasibility](../../docs/M2_5_FEASIBILITY.md) records exact native and synthetic evidence. A provider-backed demonstration and owner implementation review remain milestone completion gates.

## Development

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test packages/runtime-claude-code
pnpm typecheck
pnpm lint
```

Run `pnpm exec tsx scripts/probe-claude-preflight.ts` for the owner-platform model-free gate and `NODE_ENV=test pnpm exec tsx scripts/probe-claude-adapter.ts` for the native localhost synthetic profile. These are opt-in scripts; ordinary CI does not require Claude Code or credentials. Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) and the [engineering standards](../../docs/ENGINEERING.md). License: [AGPL-3.0-only](../../LICENSE) for Anastom code; Anthropic's separately installed executable has its own terms.
