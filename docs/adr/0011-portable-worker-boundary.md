# 0011 — Portable worker boundary

- Status: Accepted in PR #11 at `ecd5ba5`, merged as `8659117`; feasibility gates remain required before live integration
- Date: 2026-09-13

## Context

M1 proves the single-worker contract through Pi. M2 must demonstrate the same Task through Codex and make runtime differences observable. The milestone calls for capability negotiation, but architecture wording also mentions routing, which the roadmap places in M12. Current public events lack usage, and a successful abort request alone is insufficient to authorize retry.

## Accepted decision

Use the documented `codex exec --json` interface behind `packages/runtime-codex`, with the official `@openai/codex` executable package pinned to the inspected `0.154.0` baseline. Own one process group per attempt on Linux/macOS, frame and validate bounded JSONL, whitelist public observations, and validate the final report with Anastom's schema. The process seam is injectable for deterministic tests.

Keep runtime/model selection outside authored Tasks. Codex uses its built-in OpenAI provider and requires explicit paired `--provider` and `--model` selections in this slice so ignoring user configuration does not select an unrecorded default. Pi's existing configured providers and selection behavior remain compatible. Record whether identity is configured or reported; a configured model name must not be represented as provider-confirmed identity.

Negotiate the explicitly selected worker adapter against a fixed Task requirement: the requested filesystem workspace mode, cancellation, and native or prompted structured output. Add optional workspace-mode declarations to capabilities; missing declarations are unknown and cannot satisfy the requirement. Persist the accepted snapshot before the agent attempt. Selection has no fallback or optimization policy. Automatic routing remains M12.

Add attempt-scoped token observations where available, including completeness and counter semantics. Missing values remain absent; cached/reasoning subsets are not counted twice. Costs and billing estimates are outside this token-only slice. Telemetry remains evidence and does not decide acceptance or alter retry budgets.

Keep `RuntimeAdapter`'s lifecycle and the Task/worker-report schemas. Add shared agent conformance tests in runtime-contract test support, with explicit memory/legacy-fake and real-filesystem profiles. Prove cancellation, terminal immutability, bounded observation pressure, fresh context, report validation, and private-data exclusion across implementations.

## Evidence for the integration choice

Official documentation describes JSONL and schema-constrained final responses for [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode). The [command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documents ephemeral execution and ignoring user configuration while retaining normal authentication. Local `codex exec --help` confirms those controls on `codex-cli 0.154.0`.

The [SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) recommends its TypeScript library for automation. Inspection of the published `@openai/codex-sdk@0.154.0` declarations and implementation found an AbortSignal, but no public ephemeral/user-config flags or process-group ownership. It buffers stderr without a cap and does not expose a termination escalation seam. The archive's SHA-512 matched registry metadata; inspection took place in a temporary directory without installing project dependencies or making a model call.

The [app-server documentation](https://learn.chatgpt.com/docs/app-server) provides explicit interruption and richer events, but marks the interface experimental. Locally generated non-experimental `0.154.0` bindings confirm ephemeral-thread and output-schema fields. That transport introduces a larger protocol surface than this Task slice needs.

This is an engineering choice inferred from the documented interfaces and inspected release, not an OpenAI recommendation to bypass the SDK.

The owner accepted the CLI as the supported interface in [review](https://github.com/gsornsen/anastom/pull/11#discussion_r4002124447). [SDK reconsideration](https://github.com/gsornsen/anastom/issues/12) is blocked until independent evidence disproves the inspected limitations, a future version closes them, or upstream contributions become a justified priority. [M2.5](https://github.com/gsornsen/anastom/issues/13) adds Claude Code CLI and/or SDK support after M2, with supported subscription authentication investigated before interface selection.

Initial offline execution exposed limits not established by help/schema inspection. [ADR 0012](0012-codex-discovery-and-authentication-profile.md) was accepted through owner review of PR #15 and merged as `c5ba209`, with [reproducible evidence](../M2_FEASIBILITY.md). The accumulated-context follow-up was accepted in [ADR 0013](0013-codex-client-compaction-profile.md), and the managed-policy gate in [ADR 0014](0014-codex-managed-policy-preflight.md). The completed Codex implementation and paired proof are recorded in [M2 evidence](../M2_EVIDENCE.md).

## Alternatives and tradeoffs

The SDK would reduce event/client plumbing, but its inspected public boundary cannot enforce all accepted freshness, output, and termination requirements. Relying on private SDK fields or modifying upstream code would create a brittle dependency.

App-server could support richer future integrations, at the cost of request correlation, initialization, server-request handling, and an experimental protocol. M2 needs neither conversation management nor interactive approvals.

Direct execution gives Anastom explicit lifetime and stream limits, while making it responsible for framing, sanitization, and process cleanup. Pinning and executable conformance tests must detect interface drift. A feasibility gate must prove suppression of ambient instructions, skills, hooks, plugins, and MCP before a live call. If the CLI cannot meet that requirement, revise this proposal before choosing another interface.

## Compatibility and review

New readers must accept original histories without rewriting their definitions or artifacts. New event variants and optional capability/identity fields require versioned validation assets and focused replay tests. Older readers may reject newer events and must fail closed; this is not downgrade compatibility. No additional SQLite tables are justified.

The design PR adds no adapter, package dependency, executable API, or model call. Review the integration tradeoff, fixed preflight requirements, explicit Codex model selection, token semantics, and freshness/termination feasibility gates in [M2_BUILD_BRIEF.md](../M2_BUILD_BRIEF.md) before implementation. Release levels must follow the actual compatibility impact under the engineering standards.
