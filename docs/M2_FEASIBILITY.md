# M2 Codex feasibility audit

Status: exact-release offline fixtures and the M2 adapter implementation are complete; paired live and CI proof is in [M2_EVIDENCE.md](M2_EVIDENCE.md). [ADR 0012](adr/0012-codex-discovery-and-authentication-profile.md) was approved in PR #15 and merged as `c5ba209`, closing [issue #14](https://github.com/gsornsen/anastom/issues/14). [ADR 0013](adr/0013-codex-client-compaction-profile.md) was approved in PR #18 and merged as `e9217e5`. The owner accepted [ADR 0014](adr/0014-codex-managed-policy-preflight.md)'s managed-policy gate before live integration. The owner approved the original CLI direction in PR #11 at `ecd5ba5`, merged as `8659117`.

## Inspected identities

- Official npm package: `@openai/codex@0.154.0`, with its published platform package; native version `codex-cli 0.154.0`.
- Initial package research used a separate temporary installation. The M2 implementation pins the same package in the repository dependency and lockfile.
- Upstream source tag: `rust-v0.154.0`, annotated tag `36eab01061df3cde5f95ec20a526777b430091ba`, commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`.
- Inspected source paths include `codex-rs/config/src/config_toml.rs`, `codex-rs/config/src/skills_config.rs`, `codex-rs/codex-home/src/instructions/mod.rs`, `codex-rs/ext/skills/src/extension.rs`, `codex-rs/login/src/auth/storage.rs`, `codex-rs/model-provider-info/src/lib.rs`, and `codex-rs/exec/src/event_processor_with_jsonl_output.rs`.
- Inspection material stayed in temporary storage. No upstream implementation was copied into Anastom.
- Local probe environment: Node.js `26.4.0`, pnpm `11.9.0`, Darwin `25.2.0` / arm64. Routine CI remains on Node.js 24; this explicit native probe was run locally on macOS.

Current official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample), and [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode) explain public controls. Native observations and source inspection establish the release-specific limits below; configuration documentation alone is not feasibility proof.

## Reproduce without a model

Create a temporary npm project with `@openai/codex` pinned to `0.154.0`, then install it with pnpm. Run from Anastom with the installed package directory as the explicit argument:

```bash
pnpm exec tsx scripts/probe-codex-feasibility.ts /absolute/temporary/project/node_modules/@openai/codex
```

The [probe](../scripts/probe-codex-feasibility.ts) verifies package identity/version, uses a local HTTP/SSE fixture, creates fake authentication and planted instructions/skills, owns a POSIX process group, and bounds request/stdout capture and wall time. Both service URLs are explicitly constrained to loopback. It does not consult real owner credentials, inherit the parent's provider configuration, or use a global Codex executable. Local server binding and subprocess sandboxing may require execution outside an enclosing agent sandbox.

It retains temporary directories containing synthetic files and an allowlisted `probe-summary.json`. These paths are printed for inspection. Native diagnostics and provider request bodies are not persisted by the committed probe. Remove only the printed synthetic directories when finished.

## Observed outcomes

| Profile                                 | Synthetic response                  | Provider requests                               | Ambient sentinel inherited | Native outcome                |
| --------------------------------------- | ----------------------------------- | ----------------------------------------------- | -------------------------- | ----------------------------- |
| Original discovery settings             | Successful SSE report               | 1 HTTP request, after native WebSocket fallback | Yes                        | Success                       |
| Candidate isolated directories/provider | Successful SSE report               | 1                                               | No                         | Success                       |
| Candidate isolated directories/provider | Successful SSE report without usage | 1                                               | No                         | Success, native counters zero |
| Candidate isolated directories/provider | HTTP 503                            | 1                                               | No                         | Failed                        |
| Candidate isolated directories/provider | HTTP 400 `context_length_exceeded`  | 1                                               | No                         | Failed                        |

All successful synthetic responses carry the unchanged worker-report schema, including `summary.minLength=30`. The ordinary fixture returns input 100 (cached subset 20), output 30 (reasoning subset 10), total 130, and **no cache-write counter**. Native completed-turn events nevertheless contain `cache_write_input_tokens: 0`. The additional missing-usage fixture omits the entire provider usage object, but native completed-turn events contain zero counters. A native zero alone is therefore insufficient evidence of reported zero. Omit ambiguous native zeros, including cache-write placeholders; preserve genuine zero when the interface establishes its provenance. Audit positive-counter semantics during implementation rather than assuming every native value is provider-reported.

The final five-case reproduction retained synthetic summaries under the task-specific temporary directories ending `OVbteF`, `BwgjSh`, `OJAfPh`, `hSE0ts`, and `wZCYeo`, respectively. All five assertions passed; each candidate case made exactly one provider HTTP request and excluded the ambient sentinel. These temporary paths are local research artifacts, not durable M2 run evidence.

The original settings include `--ignore-user-config`, `--ignore-rules`, `project_doc_max_bytes=0`, and the inspected experimental host-discovery flag. Global AGENTS.md and user/project skill content still entered the synthetic provider request. Disabling user configuration is insufficient to exclude other discovery sources. Directly overriding `model_providers.openai.request_max_retries=0` returned a reserved-provider configuration error before execution.

The candidate links synthetic `auth.json` into a fresh Codex directory and uses a fresh child home, explicitly disables bundled/catalog skills, and disables its project skill by canonical document path. A native explicit skill reference in the fixture prompt does not inject that disabled document. The candidate uses adapter-owned `anastom-openai` configuration with normal OpenAI auth required, Responses transport, retries zero, and WebSockets false. The local base URL is a test transport; arbitrary production endpoints are outside the proposed contract.

## Gates still required

These initial results did not close all M2 feasibility gates:

- synthetic subscription refresh must update the original linked file without an additional credential copy; the offline fixture and a model-free check of normal owner file-backed authentication now pass, while live proof remains;
- keyring-only/missing authentication must fail before worktree/state creation;
- bounded discovery must cover project/ancestor roots, symlinks, explicit mentions, bundled resources, and managed configuration conflicts; the managed gate is accepted in ADR 0014;
- accumulated-context and SSE exhaustion must fail the bounded attempt without hidden compaction or retry;
- the native/provider path must either accept the exact report schema or expose a classified unsupported-schema failure;
- owned descendants must stop on normal completion, cancellation during startup/execution, and SIGTERM resistance within the accepted limits;
- framing, event pressure, late results, output validation, public-data filtering, identity/usage mapping, replay, and paired live evidence require the actual adapter and shared conformance suite.

The owner accepted ADR 0014 before M2's live calls. A production adapter and deterministic doubles are implemented on the M2 feature branch, but do not alone constitute completion evidence. The approved [M2 brief](M2_BUILD_BRIEF.md) still requires the paired demonstration and all completion evidence. No M2.5 implementation has been performed.

## Accumulated-context follow-up

The immediate provider context error does not prove the native context-window threshold is disabled. The exact source clamps automatic compaction to model-window metadata and independently triggers compaction at the full usable window. An added synthetic tool turn with 500,000 input tokens reproduced three Responses requests, including a schema-free compaction request. An owned supported model catalog with unknown context-window metadata produced two schema-preserving requests instead. [ADR 0013](adr/0013-codex-client-compaction-profile.md) documents the accepted control and its consequences. All other M2 gates remain required.

The opt-in commands append `context` (reproduce the failure) or `catalog` (test the candidate) to the previously documented pinned-package invocation. No real provider authentication is consulted, and both provider endpoint configurations remain explicit loopback URLs.

Finalized early regression runs retained `anastom-codex-feasibility-J2tuXg` (three requests under ADR 0012) and `anastom-codex-feasibility-Io9q1T` (two schema-preserving requests with the accepted catalog). The original five cases passed again, retaining `nJsBrG`, `USGGju`, `Q2qT9X`, `dlswLW` and `IZ3TwW` summaries under the same system temporary root. These are synthetic local evidence, not provider billing or model-quality comparisons.

## Exact adapter profile and managed-policy follow-up

The opt-in `adapter-profile` mode now runs the project-resolved direct native executable with the actual adapter-owned profile. Six deterministic outcomes passed: a schema-valid report, missing provider usage, HTTP 503, immediate HTTP 400 context exhaustion, SSE `response.failed` context exhaustion, and a 500,000-token synthetic tool continuation. The first five outcomes made one Responses request each; the accumulated tool case made two schema-preserving requests. None inherited the planted ambient instruction. Local allowlisted summaries end `4hSrwo`, `Vp4Zyx`, `gmBi8W`, `OlI73O`, `aetGVD`, and `uplgfl`, respectively. The separate `debug prompt-input` command is offline discovery evidence only: it does not use the cloud loader and creates an ephemeral debug thread.

The opt-in `adapter-refresh` mode used a synthetic stale ChatGPT Plus file-backed store. The direct native executable reached a loopback refresh endpoint, wrote a new synthetic access token through the profile symlink into the original fake `auth.json`, then made one schema-constrained model request with the unchanged bounded instructions. This proves the release's file-store refresh path with synthetic bytes; live owner-authenticated execution still requires the reviewed gates. The product profile also disables Codex analytics to avoid an extra native telemetry request observed during the fake subscription path.

The explicit [owner policy probe](../scripts/probe-codex-owner-policy.ts) resolved the selected exact native package and normal file-backed Codex authentication using metadata only. The short-lived native policy reader reported no managed requirements/configuration and made zero model calls. Its allowlisted output was `{"runtime":"codex","nativeVersion":"0.154.0","authentication":"normal-file-backed","managedPolicy":"absent","modelCalls":0}`. This does not replace the later live demonstration or expose credential material.

The `managed-conflict` mode exposed a critical counterexample: a synthetic ChatGPT business requirement added `ANASTOM_MANAGED_SENTINEL` to the model request while the native turn exited zero with a valid report. A model-free `app-server --stdio --strict-config` policy read exposed that requirement first. The actual adapter policy gate then rejected the same native profile as `policy-violation` before any model request. The `managed-config` mode exposed an `enterpriseManaged` layer without any model request, and the actual gate rejected it too. The `managed-unavailable` mode served five cloud 503 responses; the strict reader exited before complete evidence, which the adapter rejects. Current allowlisted summaries end `nlarNI`, `axXQ6z`, and `2ys6c3`. [ADR 0014](adr/0014-codex-managed-policy-preflight.md) states the accepted conservative policy decision and its limits. Deterministic process doubles verify rejection before starting `codex exec`.

The `adapter-discovery` mode planted a skill in an ancestor `.agents/skills` directory, symlinked it into the workspace `.codex/skills` tree, and explicitly mentioned both that skill and a project skill in the Task objective. The direct native request retained the Task's selector text but excluded the planted skill bodies and AGENTS/config instruction sentinel. The actual profile inventoried the canonical ancestor skill path; local allowlisted summary ends `fmb1Zr`. A broken skill symlink yields a typed policy violation rather than an incomplete selector list.
