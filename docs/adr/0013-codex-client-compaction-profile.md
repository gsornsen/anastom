# ADR 0013: Codex client compaction profile

Status: Accepted after the owner's approval of [PR #18](https://github.com/gsornsen/anastom/pull/18), merged as `e9217e5`. Other M2 feasibility gates still block a live call.

## Problem

The exact `@openai/codex@0.154.0` executable clamps `model_auto_compact_token_limit` to 90% of the model's resolved context window. Its turn loop also compacts when the full usable context window is exhausted. Setting the threshold to the maximum signed 64-bit integer therefore does not disable client compaction for a known model. The earlier HTTP context-error fixture proved only that an immediate provider error stopped without retries; it did not exercise an accumulated tool conversation.

The new offline fixture starts with a synthetic `gpt-5.5` tool turn reporting 500,000 input tokens, then returns the required report. With ADR 0012's discovery/authentication/provider profile, the CLI made **three** Responses requests: the tool turn, a compaction request lacking the report schema, and the continuation. Exit zero does not satisfy Anastom's bounded context contract when hidden compaction occurred.

## Decision

Keep the executable pin, public OpenAI provider/model selection, original-file authentication symlink, retry limits, discovery suppression, sandbox and process ownership from ADR 0012. Add an adapter-owned model catalog using the supported `model_catalog_json` configuration. It contains only the explicitly selected model, Anastom's bounded instructions, a conservative text/tool profile, and **unknown** client context-window metadata (`context_window: null`, `max_context_window: null`). Continue setting the client compaction threshold to the maximum signed 64-bit integer. This removes the native model-window clamp and full-window compaction trigger for the physically bounded attempt; it does not enlarge the real provider's context window or claim the provider accepts unlimited input.

The catalog is an execution profile, not provider-reported model metadata. Do not inherit or copy a user's model catalog or publish invented context limits. The provider remains authoritative: exceeding its actual context window fails the attempt with a sanitized `model-provider` diagnostic rather than changing context through client compaction. Native `new_context_window`/experimental context tools and token-budget defaults must remain disabled. Any observed compaction is a policy violation and cannot yield accepted success.

The profile uses unified execution and the CLI's ordinary patch tool, bounded tool-output truncation, no apps/skills/plugins usage instructions, and no experimental model tools. Explicit reasoning effort is supplied outside the Task; the owner's live Codex selection is **`gpt-5.6-terra` at `medium`**. Selected identity remains `source: configured`; catalog membership is not evidence that a provider actually resolved the requested model.

With the owned catalog, the same synthetic fixture made **two** Responses requests, both retaining the current report schema including `summary.minLength: 30`: the tool turn and its continuation. The CLI exited zero. This is evidence for the accepted control, not completion of M2's other gates.

## Alternatives and consequences

Retaining native window metadata silently violates the accepted contract. Raising `model_context_window` alone is clamped by native maximum-window metadata. Runtime token budgets, a new protocol integration, private SDK changes, or a new executable pin would expand or change the accepted slice. They remain separate decisions if this supported catalog control proves insufficient.

The adapter now owns a conservative model/tool profile and must reject unsupported model/schema combinations through classified failures. Catalog schema and native behavior require exact-pin drift tests and renewed audit on a version change. This deliberately gives up provider-catalog tuning and hidden native context management in exchange for preserving the explicit bounded attempt. No pricing, billing, routing, fallback, or public context-window promise is added.

Before a live call, prove accumulated-context continuation and provider context exhaustion under this exact profile, SSE failure without stream retries, managed requirement conflicts, complete discovery suppression including explicit skill mentions, synthetic subscription refresh through the original-file symlink, schema handling, and owned descendant cleanup. Preserve all original M2 conformance, compatibility and paired demonstration evidence requirements.

## Evidence and sources

Run the opt-in [feasibility probe](../../scripts/probe-codex-feasibility.ts) with its exact installed package directory and an additional `context` or `catalog` argument. All provider URLs are explicit loopback endpoints and authentication is synthetic; Anastom's real authentication is never read.

The profile-only accumulated-context run retained summary `anastom-codex-feasibility-tdxwtC`; the catalog candidate retained `anastom-codex-feasibility-GiPTa1`, both under the local system temporary directory. Their allowlisted JSON summaries contain request paths, schema presence, native event types and counters, without provider request bodies or native diagnostics. Re-run after finalizing the probe and record the resulting identities in [M2 feasibility](../M2_FEASIBILITY.md).

Official configuration: [model catalog, compaction and context-window reference](https://learn.chatgpt.com/docs/config-file/config-reference). Exact upstream tag `rust-v0.154.0`, source commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`: `codex-rs/models-manager/src/model_info.rs`, `codex-rs/protocol/src/openai_models.rs`, `codex-rs/core/src/session/context_window.rs`, and `codex-rs/core/src/session/turn.rs`. Source inspection stayed in temporary storage; this proposal copies no upstream implementation.
