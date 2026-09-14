# 0012 — Refine Codex discovery and authentication ownership

- Status: Proposed in [issue #14](https://github.com/gsornsen/anastom/issues/14); requires review before adapter implementation uses this profile
- Date: 2026-09-13
- Refines: [ADR 0011](0011-portable-worker-boundary.md), retaining its CLI direction and M2 completion requirements

## Problem and observed behavior

The approved M2 brief requires offline feasibility evidence before live integration and a reviewed refinement for unproven controls. Published `@openai/codex@0.154.0` experiments found that ignoring user configuration/rules and setting `project_doc_max_bytes=0` still injects global user instructions. The inspected experimental `skip_host_skill_discovery` flag also failed to exclude user/project skill catalogs in this execution path. These findings do not establish that every Codex interface or version has the same limitations.

The CLI rejects overrides under the reserved built-in `model_providers.openai` ID. Its completed-turn usage also emits `cache_write_input_tokens: 0` when the synthetic provider has supplied no cache-write counter. The originally proposed settings and avoidance of SDK zero fill are insufficient.

[M2_FEASIBILITY.md](../M2_FEASIBILITY.md) records the exact package/source identities, reproducible probe, observed outcomes, and remaining gates. The probe exercises native execution against a synthetic local endpoint with fake authentication. It does not call a real model or inspect owner credentials.

## Proposed refinement

Keep the reviewed CLI pin and public selection `--runtime codex --provider openai --model <owner-selected-model>`. Own a private, fresh child-process home and Codex discovery directory per attempt. Do not mutate the parent's environment. Link only the normal file-backed `auth.json`; do not link user configuration, AGENTS.md, rules, skills, plugins, or environment registries.

Anastom must not read, copy, serialize, log, or persist credentials. The pinned native client reads and refreshes the original authentication file through the link. Source inspection shows its file-storage write uses an ordinary truncating open, which follows the symlink, rather than replacing it atomically. Implementation must confirm this behavior with synthetic auth-refresh tests and detect drift when changing the pin.

This initial profile supports file-backed Codex authentication. Keyring-only and unsupported stores fail preflight with an actionable typed diagnostic before a run/worktree is created. Do not automatically change a user's credential store, bridge keyrings, copy credentials, or fall back to another billing/authentication mode. Keyring lookup depends on canonical Codex-home identity in this release, so a fresh directory cannot transparently preserve it.

Use an adapter-owned `anastom-openai` provider configuration with `requires_openai_auth=true`, Responses transport, zero request/stream retries, and WebSockets disabled. Let the native authentication-aware default select the normal OpenAI API or subscription service endpoint. Production must not inherit arbitrary base URLs, auth-command integrations, or provider overrides. This changes the internal configuration ID rather than exposing additional provider selection. Public metadata records configured OpenAI service/model identity; any internal profile ID is explicitly configured evidence, not reported resolution.

Disable bundled skills and automatic catalogs with `skills.bundled.enabled=false` and `skills.include_instructions=false`. Disable hooks, plugins, MCP, memories, model-side web access, and other extra integrations as required by the bounded worker profile. Project/ancestor skill documents also need disabling through a bounded path-only scan with canonical document selectors, without reading their bodies. Reject an incomplete or oversized discovery scan. Test explicit skill mentions, not only catalog absence, because catalog suppression alone does not disable explicit invocation.

Omit Codex cache-write counters in this inspected path because reported zero and native placeholder zero cannot be distinguished. An entirely absent provider usage object also produces native zero counters: omit zeros with unestablished provenance, preserve genuine zero when provenance is established, and audit positive counters against provider/source semantics. Preserve established input/output cache/reasoning inclusion semantics, missing values, safe-integer validation, and partial coverage. This is a mapping correction and does not justify invented zero values in Pi or other adapters.

## Evidence and limits

The candidate isolated profile excluded the planted global/project/user skill sentinel, used linked synthetic file authentication, and completed one synthetic provider request. Synthetic HTTP 503 and HTTP context-exhaustion variants each made one request and terminated unsuccessfully, without a compaction endpoint request. The reproduction includes an explicit native skill reference to test suppression of its fixture document.

Those observations prove only the tested paths. They do not prove subscription refresh, every managed configuration source, accumulated-context or SSE exhaustion, malformed-schema classification, hostile process isolation, or descendant termination. All original feasibility and shared-conformance requirements remain mandatory before a live call. The independent command verifier, owned process group, stream bounds, worktree retention, Task/report schema, and historical replay contract remain unchanged.

## Alternatives and consequences

Keeping normal discovery directories inherits global instructions. Editing user files or copying credentials violates the accepted ownership boundary. Allowing native retry policy would relax the approved bounded worker contract. The proposed configuration keeps the native OpenAI authentication mechanism and retry controls while narrowing store support and increasing discovery/cleanup responsibilities.

SDK reconsideration remains [blocked in #12](https://github.com/gsornsen/anastom/issues/12). Claude Code support remains [M2.5 in #13](https://github.com/gsornsen/anastom/issues/13), after M2 and before M3; its subscription authentication needs a separate official-interface investigation.

## Compatibility and review

This proposal changes no production adapter, public runtime type, SQL, Task schema, package version, or stored run. It adds an explicit offline reproduction and documents findings. The implementation still requires the Changeset and compatibility evidence in the M2 brief. Review the narrowed file-auth support, credential-link ownership, internal provider profile, and retained feasibility gates before using this refinement in production code.
