# M2 build brief — Portable worker

## Status and mission

Proposed contract for owner review. M1 is merged and is the compatibility baseline. This design stage produces the M1 retrospective, this brief, and [ADR 0011](adr/0011-portable-worker-boundary.md); implementation starts after their review.

Build M2 only: execute the same strict Markdown Task through Pi or Codex, negotiate the selected adapter's support, preserve normalized public observations and available token usage, and independently verify and inspect both runs. Portability means the engineering contract survives the harness change.

## Scope decisions to review

| Ambiguity                             | Proposed boundary                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capability negotiation versus routing | Validate the explicitly selected adapter against the fixed worker requirements below. Automatic selection and fallback remain M12.                                                                           |
| Codex integration                     | One owned `codex exec --json` process group per attempt, using exact-pinned `@openai/codex@0.154.0`. ADR 0011 compares SDK and app-server alternatives.                                                      |
| Model defaults and identity           | Codex uses its built-in OpenAI provider with paired explicit provider/model flags. Distinguish configured identity from provider-reported identity; Pi keeps its current defaults and optional paired flags. |
| Unknown telemetry                     | Omit unavailable counters; identify partial coverage and documented inclusion semantics. Token-only observations are not prices or billing records.                                                          |
| Abort versus stopped execution        | Cancellation resolves only after owned execution has stopped. Termination uncertainty prevents retry.                                                                                                        |
| Ambient harness context               | Prove discovery suppression before live integration; inability to do so requires a reviewed contract/interface revision.                                                                                     |

These decisions are proposals, not delivered APIs. Source and feasibility evidence appear in ADR 0011. The implementation must use the reviewed pin, or submit a justified pin update with equivalent evidence.

## Portability demonstration

Create a dependency-free endpoint baseline and two fresh clones sharing its exact commit. Run the unchanged `tasks/add-endpoint.md`, acceptance tests, Task compiler, context builder, worktree manager, and command verifier with explicit runtime selections:

```text
anastom run tasks/add-endpoint.md --runtime pi --provider <pi-provider> --model <pi-model>
anastom run tasks/add-endpoint.md --runtime codex --provider <codex-provider> --model <codex-model>
```

Both demonstrations must independently pass the endpoint acceptance command, preserve a clean source checkout, retain their worktrees, and support later-process `status` and `inspect --json` without provider access. The owner selects the Codex model and confirms normal authentication before its live call. Preserve the already selected Pi provider/model unless the owner changes them or availability requires clarification.

The owner has reported Pi authentication for Anthropic, Codex, and OpenRouter. These are provider options inside the Pi runtime. Codex runtime execution uses the separate executable's normal authentication; Pi login does not establish its readiness. A shared model can be selected for both harnesses if the owner prefers and both expose it, while the two runtime executions remain independent.

The Task and normalized workflow digests must match within the paired demonstration. Run IDs, workspace paths, context bytes, implementation text, usage, duration, and artifact digests may differ. Compare verified behavior and event-contract compliance; byte-identical model output is not required.

## Capability preflight

`capabilities()` describes enabled behavior of the configured adapter, not every feature the underlying harness could support. Validate its snapshot against a committed, versioned schema before using it. It must not create a session, start a model call, or return credentials.

Propose an optional `workspaceModes` array on `RuntimeCapabilities`, using the existing `memory`, `readonly`, and `isolated` values. Absence means unknown. First-party adapters declare their actual supported modes; fake retains memory and existing filesystem support, while real adapters reject memory.

Every Markdown Task requires:

- its requested `readonly` or `isolated` workspace mode;
- `cancellation: true`;
- `structuredOutput: native` or `prompted`, with final engine validation.

Streaming, usage, and operating-system sandboxing are descriptive rather than required. An unsupported requirement yields an actionable typed `policy-violation`; a failed capability probe yields `runtime-unavailable`. Neither can fall back to another runtime or consume an agent attempt.

The CLI obtains one validated snapshot and checks it before creating a worktree or durable run. The engine checks the same decision against the selected adapter and actual workspace before creating worker-mode state. A direct engine caller receives equivalent preflight behavior; a caller-owned workspace remains that caller's responsibility.

Persist the accepted requirements and capability snapshot as a typed `RuntimeNegotiated` event after `RunCreated` and before the first agent attempt. Inspection must use that recorded snapshot, not ask the currently installed runtime. M0's fake workflow execution retains its existing dispatch and behavior.

## Codex adapter

Create `packages/runtime-codex` implementing the existing `RuntimeAdapter` lifecycle. Credentials remain in normal Codex authentication. Resolve the exact project dependency, verify its version, and reject an unsupported platform or missing executable with a typed diagnostic. Do not silently use a global installation.

This Codex slice supports the built-in OpenAI provider with explicit model selection. Reject other provider IDs before state creation; custom Codex provider configuration is deferred. Pi retains its configured provider support.

Use a filesystem agent request and one fresh ephemeral execution per attempt. Set the owned worktree as cwd, use `shell: false`, provide the canonical context-derived prompt on stdin, and supply the exact required output schema through an adapter-owned file. Do not reconstruct a shell command, invoke a runtime-managed worktree, resume a thread, or continue an earlier attempt.

Explicit configuration selects the provider/model, disables user-config and rules inheritance, suppresses discovered instructions/resources and extra integrations, and disables hidden agent-level retries. Harness-native automatic context handling must be audited; automatic compaction must be disabled or exhaust the bounded attempt rather than silently change its context contract.

Use Codex's workspace-write sandbox for isolated attempts and read-only sandbox for readonly attempts, with interactive approvals disabled and sandboxed command network access disabled. Provider communication remains available to the harness. Anastom's independent verifier runs outside the worker sandbox and can exercise the fixture's loopback HTTP behavior. A worker's inability to run that command inside its sandbox does not replace the authoritative verifier.

Managed requirements remain authoritative. If they prevent the requested bounded profile, fail closed with a diagnostic. Full-access or approval bypass flags cannot be introduced as a fallback.

### Feasibility gates before a live call

Use the pinned release and offline fixtures/protocol doubles to prove:

1. the final prompt contains only explicit context and the reviewed bounded system instructions;
2. synthetic user/project instructions, skills, hooks, plugins, and MCP configuration are not inherited;
3. normal authentication can remain available without copying, serializing, or logging credential material;
4. schema-constrained output accepts the current worker-report schema, including its summary constraint, or returns a classified unsupported-schema failure;
5. cancellation and normal finalization stop owned child/descendant execution within the agreed limits;
6. hidden retry and compaction behavior meet the bounded-attempt contract.

Read-only documentation and CLI help are evidence of an interface, not proof of these runtime properties. Document exact configuration and observed limits in the implementation ADR/evidence. An unproven gate blocks the live demonstration and requires a reviewed refinement rather than an implicit relaxation.

### Streams, results, and cleanup

Frame UTF-8 JSONL across chunk boundaries, validating relevant event shapes before mapping. Use a fixed 1 MiB maximum line/frame and a 64 KiB stderr capture cap. Oversized or malformed required frames terminate with a classified failure; raw stderr is not durable evidence. Count truncation for diagnostics without persisting private native bodies.

Normalize only public lifecycle, tool-kind/status summaries, selected identity, and usage. Discard reasoning, transcript bodies, tool arguments/output, tokens, environment values, and provider error payloads. The final assistant report is the intentional structured output, independently parsed and validated before success.

Collect succeeds only after a valid final report, a completed native turn, successful executable exit, and confirmed cleanup of owned execution. A report followed by a process failure is not success. EOF without a terminal outcome is `runtime-unavailable`; invalid reports are `schema-violation`; authentication/provider failures are `model-provider`; unsafe configuration is `policy-violation`. Diagnostics use reviewed public messages rather than copying upstream exception text.

The adapter keeps at most 256 queued public observations. Pressure may discard log observations with an explicit dropped-log count; it must preserve lifecycle, identity, and final usage. Collection returns defensive copies, terminal outcomes are immutable, and cancellation after completion is a no-op. Bound concurrent cancellation through one shared operation.

On cancellation, signal the owned POSIX process group, escalate to SIGKILL after 100 ms if needed, and bound final termination confirmation to 300 ms. This leaves time within the engine's existing 500 ms cancellation grace. Failure to confirm termination rejects `cancel`; the control plane retains timeout and prevents retry. Normal completion also cleans up surviving owned descendants before permitting verification.

Process groups provide lifecycle ownership for the supported trusted-tool profile, not proof that an arbitrary hostile process cannot escape. Unsupported termination behavior fails conformance. Windows execution remains outside the current Linux/macOS support scope.

## Public identity and usage

Keep existing runtime lifecycle variants. Propose optional `source: configured | reported` and `runtimeVersion` fields on metadata events. New adapters identify provenance; absent source on historical records means legacy/unspecified. A Codex CLI model selection is configured identity unless the pinned interface reports its effective resolution.

Propose a `usage` runtime event with attempt scope, `complete` or `partial` coverage, and optional nonnegative integer token counters for input, output, cache read/write, reasoning, and total. Values must be safe integers. Coverage describes the observed calls in the attempt, not availability of every breakdown.

Define input/output totals to include their cache/reasoning subsets where those relationships are documented. Preserve only counters whose inclusion semantics are established for the inspected adapter/provider; omit ambiguous totals. Never fabricate a missing value as zero, add cache subsets twice, infer costs from token counts, or assume two models tokenize equally.

For Pi, aggregate each completed assistant call exactly once in the fresh session using the SDK's available usage/provenance. For Codex, map the completed-turn counters from bounded JSONL without the SDK's missing-counter zero fill. Interrupted or incompletely observed attempts have partial coverage. Fake declares no provider usage and emits none; synthetic streams exercise usage validation without inventing provider work.

Store usage through existing `RuntimeEventObserved` events. Persist validated observations once and derive inspection summaries by replay. Telemetry cannot overwrite structured output, decide success, or implement token/cost routing. Required observations must survive queue pressure; duplicate observations cannot inflate totals.

## Shared conformance suite

Keep reusable, unexported test support in `packages/runtime-contract/src/testing/`. Each adapter supplies a deterministic factory/driver to the same agent suite. Real adapter profiles add filesystem and process/session cleanup checks; fake's profile preserves legacy M0 behavior. Avoid a production dependency on another adapter or a new package solely for test helpers.

The suite must cover:

1. validated capabilities, supported and rejected workspace requirements, and no execution during probing;
2. only agent requests crossing real adapters, with M0 fake node-kind compatibility;
3. immutable request/context ownership and fresh independent state on a second attempt;
4. ordered, finite lifecycle streams with one terminal observation matching collect;
5. schema-valid success, invalid/missing reports, upstream failure, and premature EOF;
6. cancellation during initialization/execution, concurrent requests, late results, and completed-result immutability;
7. pressure and framing limits, preserving required observations while bounding logs;
8. whitelisted identity/usage, missing/zero/partial counters, duplicate prevention, and private-data exclusion;
9. defensive collection and deterministic rejection of unknown handles;
10. session/process/file cleanup and confirmed absence of post-terminal writes.

Add adapter-specific process tests with synthetic children/grandchildren, SIGTERM resistance, split/multibyte frames, oversized native items, and sensitive-looking sentinels. Provider credentials and real model calls must not be required by tests or CI.

## CLI, persistence, and compatibility

Add `--runtime codex` to Markdown Task execution. Reject mixed fake/provider flags, incomplete pairs, unsupported runtime IDs, and missing Codex selection before creating state. Keep existing Pi/fake commands and the unchanged authored Task schema.

`status` and `inspect --json` must reconstruct runtime selection, negotiated capabilities, available identity/token observations, verifier results, and artifact references from SQLite. Inspection works with no Codex/Pi executable or provider authentication. Human output labels unavailable and partial values clearly.

Add versioned runtime-capability/observation validation assets and typed transitions for the new evidence. Update reducer and renderers; keep run/event ordering authoritative. Original event histories and embedded workflow schemas remain readable without rewriting bytes. Older applications may reject newer event variants and must fail closed.

No new SQLite application or metadata table is justified; do not modify applied migration SQL/checksums. A schema change requires separate review and migration evidence. Capability and usage evidence belong in the existing append-only event history.

The implementation includes the new package README/CHANGELOG, affected package documentation, useful JSDoc, a reviewed Changeset reflecting actual compatibility impact, README overview changes, and root changelog entries. Initial versioning stays a separate reviewed PR.

## Checks and completion evidence

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm hygiene`, and `git diff --check`. Generate warning-free API documentation for every affected public entry point. Preserve the original YAML CLI compatibility demo and deterministic cross-process Task tests.

Extend the existing Linux suite with shared conformance and Codex doubles. Add only platform-specific process tests to the macOS portability job; retain the required Linux display name and document ownership in `ENGINEERING.md`. Do not add duplicate full demos or model calls to CI.

M2 is complete only when `M2_EVIDENCE.md` records:

- accepted design/implementation commit identities and exact environment/dependency versions;
- passing existing behavior, shared conformance, Codex process tests, and all required checks;
- feasibility-gate evidence and exact configuration without credentials;
- successful paired live Pi/Codex runs on the same Task and base commit with owner-selected models;
- later-process status/inspection, independent verifier exits and acceptance output;
- durable accepted capabilities and identity provenance for each adapter;
- reported token observations with explicit unknown/partial values and mapping semantics;
- clean source checkouts, retained worktrees/diffs, and independent verification of all artifact digests;
- a comparison explaining common contract behavior and observed runtime differences without claiming comparative model quality;
- representative original M1 stores replaying unchanged through the newer reader.

## Exclusions and stop condition

M2 has one selected worker and one command verifier. Do not implement automatic routing/fallback, crash recovery, leases, snapshots, pause/resume, multiple workers, nested methodologies, human orchestration gates, generalized evidence graphs, cost budgets, UI/server/cloud surfaces, another real adapter, or automatic publication/versioning.

Stop the design stage after this reviewable contract PR. Stop implementation after every listed M2 evidence item is recorded and the owner reviews the implementation PR. Recovery is the subsequent M3 milestone.
