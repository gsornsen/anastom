# M2 Codex feasibility audit

Status: offline research complete for the paths below; **M2 is not complete**. [ADR 0012](adr/0012-codex-discovery-and-authentication-profile.md) proposes a profile refinement for review in [issue #14](https://github.com/gsornsen/anastom/issues/14). The owner approved the original CLI direction in PR #11 at `ecd5ba5`, merged as `8659117`.

## Inspected identities

- Official npm package: `@openai/codex@0.154.0`, with its published platform package; native version `codex-cli 0.154.0`.
- Package installation used a separate temporary directory; this proposal adds no repository dependency or lockfile change.
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

It retains temporary directories containing synthetic files and a whitelisted `probe-summary.json`. These paths are printed for inspection. Native diagnostics and provider request bodies are not persisted by the committed probe. Remove only the printed synthetic directories when finished.

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

These initial results do not close all M2 feasibility gates:

- synthetic subscription refresh must update the original linked file without an additional credential copy; normal owner authentication must remain available;
- keyring-only/missing authentication must fail before worktree/state creation;
- bounded discovery must cover project/ancestor roots, symlinks, explicit mentions, bundled resources, and managed configuration conflicts;
- accumulated-context and SSE exhaustion must fail the bounded attempt without hidden compaction or retry;
- the native/provider path must either accept the exact report schema or expose a classified unsupported-schema failure;
- owned descendants must stop on normal completion, cancellation during startup/execution, and SIGTERM resistance within the accepted limits;
- framing, event pressure, late results, output validation, public-data filtering, identity/usage mapping, replay, and paired live evidence require the actual adapter and shared conformance suite.

No M2 live model call, production adapter, or M2.5 implementation has been performed. The approved [M2 brief](M2_BUILD_BRIEF.md) requires review of an unproven profile refinement before live integration; the proposed narrower profile remains subject to owner review.
