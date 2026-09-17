# M4 defined-SDLC evidence

## Status

The defined-SDLC implementation and its required deterministic and live acceptance evidence completed on 2026-09-17. One strict Feature and the checked-in `sdlc/default` methodology passed unchanged through owner-authenticated Pi and Codex runs. Both runs used the production CLI, durable coordinator, SQLite store, shared execution host, runtime adapter, artifact store, run-scoped Git topology, controller-owned integration, independent reviews, operator verifier, evidence projection, and later-process inspection.

The controlled fixture is checked in at [`examples/demo-repos/parallel-normalizers`](../examples/demo-repos/parallel-normalizers). It requires exactly two independent source changes and protects its Feature, acceptance program, and repository instructions. `pnpm fixture:defined-sdlc` creates a fresh initialized copy. `pnpm audit:defined-sdlc-live -- <repository> <run-id> <runtime> <provider> <model> [reasoning-effort]` replays and audits a completed live run without contacting a provider.

## Deterministic process matrix

Run the model-free evidence from the repository root:

```bash
pnpm verify:defined-sdlc
```

The accepted run on 2026-09-17 used Node.js `v26.4.0` on Darwin arm64.

| Case                                           | Observed result                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Left task completes first                      | Run succeeded; workers overlapped; retained integration branch; 39 artifact references re-read successfully                                                                                                        |
| Right task completes first                     | Run succeeded with the opposite completion order and the same deterministic integration result; 39 artifact references re-read successfully                                                                        |
| Pause with two active workers                  | Both owned executions reported confirmed cancellation before the run became `paused`                                                                                                                               |
| Cancel with two active workers                 | Both owned executions reported confirmed cancellation before the run became `cancelled`                                                                                                                            |
| One worker fails                               | The still-active sibling was cancelled and the run failed without changing the source checkout                                                                                                                     |
| Independent review rejects                     | The run failed and the operator verifier never started                                                                                                                                                             |
| Operator verifier exits nonzero                | The run failed and retained exact exit code `7`                                                                                                                                                                    |
| Coordinator dies after integration preparation | A later process observed the original owner absent, waited for the real lease boundary, committed the prepared integration exactly once, rejected the stale fence with `ownership-conflict`, and completed the run |

Both successful runs were inspected from a later CLI process. Each retained two deterministic integration records, three accepted patch identities, a clean operator checkout, a reviewable `anastom/<run-id>--integration` branch, and a passing operator-authored verifier. The protected acceptance program remained byte-identical. Every case left the operator checkout clean.

## Live fixture identity

Both provider-backed runs used the same committed fixture bytes:

| Input            | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `feature.md`     | `a8d46ea67a1bd79b70fb3117d9912b3f8e4ca73a8ddbeaeb577b7826379f6ab0` |
| `acceptance.mjs` | `a641d003492665711971e87fb3df33e0549f97c4977972f55e0776f3a0c6dbb9` |
| `AGENTS.md`      | `6930d40d2d1bc7892d4465529f1ae3c802558f688dfc5da39e6d2200255e6c21` |

The audit compared those bytes with both the source checkout and retained integration worktree. Each final commit changed only `src/normalize-display-name.mjs` and `src/normalize-labels.mjs`. The original source checkout and the retained integration worktree were clean after completion.

## Pi live run

Pi used the operator's normal authentication and an explicit `anthropic` / `claude-opus-4-8` selection. The persisted effective adapter version was `0.85.1`.

| Evidence                   | Observation                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Run                        | `0252091e-b004-42da-8d1f-4e6377d2ecd8`; succeeded at sequence 205                                 |
| Base                       | `6f793f92d200f7603602e57b1f878ce37f03cce0`                                                        |
| Implementation overlap     | display-name sequences 67–94; labels sequences 71–107; distinct execution IDs                     |
| Wave integration           | `e17051b8108a0c0f50761e0ce345772b6a0f48f7`                                                        |
| Integrator correction      | Valid empty patch with SHA-256 `e3b0c442…b855`                                                    |
| Final integration          | `3f08da83ad53914d3843399c03b2049442c38a12`                                                        |
| Independent review overlap | specification sequences 148–178; quality sequences 155–187; distinct execution IDs; both approved |
| Operator verifier          | exit 0; 39 stdout bytes; 0 stderr bytes                                                           |
| Artifacts                  | 39 durable references; 36 immutable files; 83,029 total bytes                                     |
| Retained branch            | `anastom/0252091e-b004-42da-8d1f-4e6377d2ecd8--integration`                                       |

Some Pi roles initially returned prose or otherwise schema-invalid final text. The adapter issued at most one explicit format-only correction in the same session and attempt. The correction forbade more repository work and tool use; normal schema validation, attempt limits, and workflow policy remained authoritative.

## Codex live run

Codex used the operator's normal file-backed authentication with explicit `openai` / `gpt-5.6-terra` selection and `medium` reasoning effort. The persisted native CLI version was `0.154.0`.

| Evidence                   | Observation                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Run                        | `e7481aff-fd39-403e-b606-0f0bbc90b153`; succeeded at sequence 198                                 |
| Base                       | `5c6063437fc49b5d2b277de0259b7c217df92e31`                                                        |
| Implementation overlap     | display-name sequences 53–80; labels sequences 59–94; distinct execution IDs                      |
| Wave integration           | `705d0ceaca1a2e75e2fb5e2c462a0a550c9f7497`                                                        |
| Integrator correction      | Valid empty patch with SHA-256 `e3b0c442…b855`                                                    |
| Final integration          | `c9c31e49f139474894d0a04278a451d5cf049e50`                                                        |
| Independent review overlap | specification sequences 136–172; quality sequences 143–180; distinct execution IDs; both approved |
| Operator verifier          | exit 0; 39 stdout bytes; 0 stderr bytes                                                           |
| Artifacts                  | 39 durable references; 36 immutable files; 66,507 total bytes                                     |
| Retained branch            | `anastom/e7481aff-fd39-403e-b606-0f0bbc90b153--integration`                                       |

The live planner exposed a native structured-output compatibility boundary: Codex's strict schema endpoint rejected JSON Schema `uniqueItems`. The adapter now removes that unsupported annotation only from the temporary native output schema. Anastom still validates the returned report against the complete original methodology schema, including uniqueness.

## Artifact and private-data audit

For each live run, the checked-in auditor:

- opened the SQLite history in one process and compared it with `inspect --json` from a later process;
- reproduced the evidence ledger and bounded live projection from authoritative events;
- read every artifact reference through `FileArtifactStore`, recomputed every digest, required an ordinary privately permissioned file, and checked the type-specific size bound;
- required the exact artifact set for seven model-backed attempts and one command verifier;
- rejected credential-shaped values such as Anthropic/OpenAI key prefixes, bearer tokens, and API-key assignments across events and artifact bytes;
- recursively rejected credential, private-reasoning, encrypted-content, and raw-provider-error fields from events and JSON artifacts; and
- checked the 2 KiB per-message and 64 KiB/128-message per-attempt public-log bounds.

Authentication stayed in each harness's operator-owned store and has no representation in runtime descriptors, events, artifacts, or public output. Private reasoning and raw native bodies have no accepted event or report field. Both audits passed.

## Findings fixed during live acceptance

Live execution challenged four boundaries that deterministic doubles had not fully exercised:

- An exhausted failed worker that also changed its workspace now fails its node and cancels active siblings. A retryable dirty failure pauses the whole run only after sibling cancellation settles. Reducer and coordinator tests cover both cases.
- Prompted Pi output receives one bounded format correction before becoming a schema failure. This is output normalization inside one attempt, not a review-repair loop.
- A successful integrator may correctly make no cross-task correction. Empty patches retain the SHA-256 identity of zero bytes and still produce a deterministic empty integration commit.
- Codex receives a native-compatible schema projection while Anastom retains and enforces the full methodology schema locally.

Earlier process acceptance also added explicit Feature protected paths and aligned dotted expanded-node IDs with the artifact grammar.

## Repository gates

The implementation candidate passes the local test suite, typecheck, ESLint/JSDoc, formatting, contributor hygiene, whole-repository and strict-production dead-code analysis, generated API-documentation check, deterministic defined-SDLC matrix, and both live audits. The final main-targeting pull request records the required Linux and macOS CI, DCO, dependency-review, and CodeQL results before merge.
