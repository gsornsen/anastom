# M2.5 Claude Code feasibility — design-stage evidence

Status: **partial, model-free design audit.** No Claude Code adapter, live model call, or subscription integration is delivered. [ADR 0015](adr/0015-claude-code-worker-profile.md) proposes the interface; [issue #13](https://github.com/gsornsen/anastom/issues/13) requires owner review before implementation.

## Official interface and authentication findings

- Anthropic documents `claude -p` as a programmatic interface with JSON/JSONL output and schema-constrained final output. [Programmatic guide](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-usage).
- `--bare` skips normal OAuth/keychain credentials and requires API credentials; `--safe-mode` preserves authentication but disables ordinary customizations. Administrator-managed policy still applies. [Programmatic guide](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-usage), [settings precedence](https://code.claude.com/docs/en/configuration).
- The Agent SDK overview says third-party products need prior approval to offer claude.ai login or rate limits. The more specific Claude Code legal guide allows end users to sign in to an unmodified binary with their own subscription, including when hosted, but forbids third-party login flows, credential routing on users' behalf, token intermediation, and resale. The June 15, 2026 Agent SDK credit change was paused; the current help-center notice says existing SDK, `claude -p`, and third-party subscription usage continues under subscription limits. These sources support considering a local-direct, end-user-authenticated CLI mode while leaving the "on behalf of" automation interpretation for review. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [pause notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- Print mode can select an ambient `ANTHROPIC_API_KEY` ahead of a subscription login. Explicit source selection and source checking are needed to prevent silent API billing. [Authentication](https://code.claude.com/docs/en/team).
- Managed policy outranks CLI flags; server-managed settings can apply from cache or refresh after startup. A native policy gate remains unresolved. [Configuration](https://code.claude.com/docs/en/configuration), [server-managed settings](https://code.claude.com/docs/en/server-managed-settings).

These are source findings and a stated design inference, not a blanket legal determination. Anastom can design explicit subscription and API-key selections using each end user's separately installed CLI; the proposal needs owner review of the remaining third-party boundary before either mode is claimed as delivered.

## Exact local audit

On 2026-09-15 the owner's macOS arm64 native Claude Code CLI reported `2.1.268 (Claude Code)` and resolved to `~/.local/share/claude/versions/2.1.268`, a 193 MiB Mach-O binary. The local binary SHA-256 was `06a96d5423f83770f120859f1c58e60d7252cc4c122aa13043b7e7cd716bc76a`. The official npm package `@anthropic-ai/claude-code@2.1.268` exists; the [setup guide](https://code.claude.com/docs/en/setup) says its platform package installs the same native binary. The exact npm metadata archive SHA-512 was `0d24545406d1447ed66879bdf4e12b4f814940391b84851bf2621a7af705ad7b4a099c00f5498a639f923855a6832784523d94875a45c34464fe061f7e650453` and matched registry `dist.integrity`; the local native executable still needs platform-package provenance attestation before live use. The archive's `LICENSE.md` declares use subject to Anthropic's [legal agreements](https://code.claude.com/docs/en/legal-and-compliance), not AGPL; Anastom must not relabel or bundle that executable as AGPL code. The local `claude auth status --json` and `claude --safe-mode auth status --json` both reported `loggedIn:false` and `authMethod:none`. Pi's Anthropic login is a separate runtime credential and does not establish Claude Code readiness. No credential values were opened, copied, or printed.

The checked-in [probe](../scripts/probe-claude-cli.ts) creates an isolated temporary workspace/configuration and a local HTTP endpoint. It passes only a synthetic API key and loopback `ANTHROPIC_BASE_URL` to the exact binary; it does not use the owner's normal authentication or a real provider. Run it with an exact installed binary path:

```bash
pnpm exec tsx scripts/probe-claude-cli.ts /absolute/path/to/claude-code-2.1.268
```

The successful structured-output run returned this whitelisted shape (private prompts, full native frames, and synthetic key are intentionally omitted):

```json
{
  "release": "2.1.268",
  "exitCode": 0,
  "modelCalls": 2,
  "requestRoutes": ["HEAD /api/hello", "POST /v1/messages", "POST /v1/messages"],
  "hookRan": false,
  "resultType": "result",
  "resultSubtype": "success",
  "resultHasUsage": true,
  "resultHasStructuredOutput": true
}
```

Both local model requests named the synthetic selection `claude-sonnet-4-6`, carried one user message and four tools (`Glob`, `Grep`, `Read`, `StructuredOutput`), included a schema output configuration, contained the fixture prompt, and omitted `AMBIENT_SENTINEL`. The project `SessionStart` hook did not write its marker. An earlier text-only fixture result produced `error_max_turns`; the native final report expects the `StructuredOutput` tool protocol in this profile. Two local message POSTs occurred even with one allowed agentic turn, but the fixture does not establish why or whether a real provider would see the same sequence. Do not use `--max-turns` as a model-request or billing cap.

The probe does not prove mutating file-tool confinement, malformed-stream behavior, cancellation and descendant cleanup, subscription login, managed-policy exclusion, authoritative usage semantics, or live Task acceptance. Those are implementation feasibility gates in the [build brief](M2_5_BUILD_BRIEF.md). The loopback base URL also bypasses server-managed policy delivery by documented behavior, so it cannot stand in for a managed subscription account.

## SDK archive comparison

The registry reported `@anthropic-ai/claude-agent-sdk@0.3.273` during this audit. Its official package archive had SHA-512 `058f8e8f31da9fc2ca74a37ac96e1ffea9ea5a50453b52c779b6da031101f48183825375a6f5374318cf18036edb409a52dea51e3ebb382efd67bb4c2de2acd1`; base64 matched registry `dist.integrity` exactly. Inspection occurred in `/private/tmp` without installing a project dependency or running the SDK. Published declarations expose a custom `spawnClaudeCodeProcess` seam, `AbortController`, `Query.close()`, structured output, and an alpha `resolveSettings()` that does not execute `policyHelper` or fetch fresh server-managed settings by itself. Its metadata declares bundled Claude Code `2.1.273`. The [official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) documents these boundaries. The CLI preference in ADR 0015 is therefore about keeping process/JSONL ownership direct in this slice, not an assertion that the SDK cannot satisfy the contract after further evidence.
