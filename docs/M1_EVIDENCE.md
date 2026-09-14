# M1 completion evidence

Status: functional M1 evidence complete; the owner approved revision `84b394c` of PR #9. The PR remains open, with a subsequent JSDoc policy correction documented below. The original implementation baseline is commit `96a6594a5a6c9247b36d788fa8aa32449583bebf`: its recorded commands and digests below describe the retained originals. Owner-review revisions and current reproduction names are documented separately; historical evidence is not rewritten to match newer schemas.

## Environment

- Validation date: 2026-09-13.
- Node.js: v26.4.0; CI targets Node.js 24.
- pnpm: 11.9.0.
- Pi SDK/CLI: `@earendil-works/pi-coding-agent@0.85.1`, exact direct pin; CLI version independently verified.
- Platform: macOS 26.2, Darwin 25.2.0, arm64.
- Live provider/model: `anthropic` / `claude-opus-4-8`, explicitly selected by the repository owner after normal Pi login.

Pi's direct dependency is MIT-licensed, compatible with this project's AGPL-3.0-only distribution. API research used the maintained [official SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) and installed declarations. The lockfile preserves reviewed resolution and integrity. New `@google/genai` and `protobufjs` lifecycle scripts are explicitly disabled; published packages provide the runtime files and the Pi CLI import/version smoke check passes. Existing esbuild approval remains enabled.

## Deterministic checks

The standard test suite covers task parsing, M0/M1 IR validation, canonical immutable fresh context, SQLite reopening/conflicts/corrupt histories, Git source isolation/diffs/ownership/cleanup, commands and output truncation, agent-only dispatch, Pi's test-double boundary, timeout/cancellation/late output, and separate-process CLI inspection. Tests make no model calls and require no provider credentials.

Recorded command evidence at the original implementation baseline:

| Command                                                                                            | Result                                                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm test`                                                                                        | 77 tests passed across 12 files; includes all 29 M0 tests.      |
| `pnpm typecheck`                                                                                   | Passed.                                                         |
| `pnpm lint`                                                                                        | Passed.                                                         |
| `pnpm anastom validate examples/workflows/demo-feature.yaml`                                       | Valid `demo/feature@0.1.0`, three nodes.                        |
| `pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml` | All three nodes succeeded, one attempt each.                    |
| M1 fake task run with explicit `examples/fake/m1-endpoint.yaml` and temporary fixture              | Succeeded; worker report valid; verifier exit zero.             |
| Later `pnpm anastom status <run-id> --state-dir <fixture>/.anastom`                                | Reconstructed succeeded worker/verifier from SQLite.            |
| Later `pnpm anastom inspect <run-id> --state-dir <fixture>/.anastom`                               | Reconstructed definition/workspace/artifacts and all 27 events. |
| Live Pi run with `--provider anthropic --model claude-opus-4-8` on a fresh fixture                 | Succeeded; both acceptance tests passed; verifier exit zero.    |
| Later live-run `status` and `inspect`                                                              | Reconstructed succeeded state and all 36 events.                |
| Git status of the live source checkout                                                             | Clean; only the owned worktree received edits.                  |

## Retained fake run

Run ID: `12e5440b-bc7e-46d4-85e8-6fef5e1b621e`. Outcome: `succeeded`. Worker: deterministic `fake`, one attempt. Verifier: control-plane command, one attempt; exit `0`, signal `null`, duration approximately 151 ms. Acceptance: both HTTP tests passed.

The temporary fixture and worktree are retained locally. Machine-specific paths are represented as `<fixture>` here. Base and final head: `eaff09f0801d5da07d2424596514e1354c0df829`; branch: `anastom/12e5440b-bc7e-46d4-85e8-6fef5e1b621e`. Only `server.mjs` changed. The source checkout remained unchanged in the end-to-end tests. All nine artifact bodies were independently hashed and matched their stored references.

Definition digest: `sha256:06b3b515151796bbd8286f6150a3855304be664258fe8754633051045dc96677`.

| Producer    | Artifact       | SHA-256 (prefix `sha256:` omitted)                               |
| ----------- | -------------- | ---------------------------------------------------------------- |
| implement/1 | context        | ec64c2a39d3c68fbca6e6be04c73ab55542d77863a53191273a831367f3a502a |
| implement/1 | logs           | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| implement/1 | worker-report  | 572c04cd66fa1820f60212c54390d0f0216a47be9ced86e8724132bb9cda4545 |
| implement/1 | diff           | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |
| verify/1    | context        | 80f4a85951b25afceccea85c8e9171fd338fcd9e76d8d0b245e01a79e2a80e1f |
| verify/1    | stdout         | 11b152e5c51836a46343e84e2e314abf7be0313d3f7ebd16ce5b399cac85b9c6 |
| verify/1    | stderr         | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| verify/1    | command-result | de2013baf9726e8f287de21be05f9a8b3300d4fe6bbb96a92f007170aa754a7e |
| verify/1    | diff           | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |

Retained diff:

```diff
diff --git a/server.mjs b/server.mjs
index d434eeb..146920d 100644
--- a/server.mjs
+++ b/server.mjs
@@ -2,6 +2,11 @@ import { createServer } from "node:http";

 export function createApp() {
   return createServer((request, response) => {
+    if (request.method === "GET" && request.url === "/health") {
+      response.writeHead(200, { "content-type": "application/json" });
+      response.end(JSON.stringify({ status: "ok" }));
+      return;
+    }
     response.writeHead(404, { "content-type": "application/json" });
     response.end(JSON.stringify({ error: "not found" }));
   });
```

Context digests include run identity, immutable task/schema/policy data, and absolute workspace paths; new fixture/run identities produce different context/definition bytes. Digests identify the retained originals, without rewriting their bodies for publication.

## Retained live Pi run

The explicitly invoked live command used a fresh temporary fixture:

```bash
pnpm anastom run examples/demo-repos/m1-endpoint/tasks/add-endpoint.md \
  --runtime pi --provider anthropic --model claude-opus-4-8 --repo <fresh-fixture>
```

Run ID: `9e21f7a9-8445-43e9-b19f-f0c72de25042`. Terminal outcome: `succeeded`. Provider/model recorded by the SDK: `anthropic` / `claude-opus-4-8`. Worker and verifier each used one attempt. The control-plane verifier independently exited `0`, signal `null`, approximately 162 ms; stdout 203 bytes, stderr zero, neither truncated. Both acceptance tests passed. Pi also invoked the tests while working, but that invocation did not decide acceptance.

Base/final head: `fccb883cbce364295a75febb231e394a1e12cfbe`. Branch: `anastom/9e21f7a9-8445-43e9-b19f-f0c72de25042`. Retained workspace: `<fresh-fixture>/.anastom/worktrees/9e21f7a9-8445-43e9-b19f-f0c72de25042`. Source checkout: clean. Changed files: only `server.mjs`; tests and dependency declarations were untouched.

Later shell invocations of both `status` and `inspect` recovered the terminal state, immutable definition, workspace observation, and all 36 events without a Pi session. All nine live artifact bodies were independently hashed and matched their stored references. The normalized definition digest matches the fake run: `sha256:06b3b515151796bbd8286f6150a3855304be664258fe8754633051045dc96677`.

| Producer    | Artifact       | SHA-256 (prefix `sha256:` omitted)                               |
| ----------- | -------------- | ---------------------------------------------------------------- |
| implement/1 | context        | 397181fecea7a8bf9051d899e1e0dd8c6e545a915d5cdb04406cea8115dcf790 |
| implement/1 | logs           | aeacca5bddd31e2b3503b9accb2c5b92048a53c72ed75275e1eb6281ef738264 |
| implement/1 | worker-report  | 66930562c978fa788ac580dfe3f0a8d85ed76155c4dfbb85013a7bde5d2b7f76 |
| implement/1 | diff           | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |
| verify/1    | context        | 12a1f779c83f038cd4d7f00ee1f794aba0e1f900c95d7c96c4399d2f454364c7 |
| verify/1    | stdout         | 7e3b092b7498665490493f013ab25f19aeba850be7c6d17fee053667dafd8dfc |
| verify/1    | stderr         | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| verify/1    | command-result | 87297e55b3bed158a362a95f8e72ecf8c3acd1bdea1e5cd7dd6e9eac62dabff9 |
| verify/1    | diff           | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |

The live retained diff is byte-identical to the complete fake-run diff printed above. Pi's validated report states that it added the method/URL health check and preserved unmatched-route behavior. Public logs contain only tool starts/finishes for `read`, `edit`, and `bash`; private reasoning, raw tool bodies, credentials, and session state are absent from the published record.

## CI and analysis

Node.js 24 Linux CI (full tests/types/lint/M0 and M1 demos), Node.js 24 macOS portability, dependency review, and DCO passed on implementation and parser-hardening commits. CodeQL's regex finding was fixed with a single line scan and BOM/CRLF/repeated-delimiter regression coverage.

CodeQL alert 6 (`js/path-injection`, task-file read) was individually assessed as a false positive: a local operator explicitly chooses the task filename, and the loader intentionally supports that filesystem operation. M1 has no HTTP/API input boundary and does not elevate permissions beyond its caller. Resolving the path is normalization, not filesystem authorization. A future network-facing caller must authorize filenames before invoking this API. The same local-file selection is supported by the compatible workflow loader. The narrow dismissal and rationale are recorded in GitHub and ADR 0009; the path-injection query remains enabled. This assessment follows the [CodeQL rule's access-boundary concern](https://codeql.github.com/codeql-query-help/javascript/js-path-injection/) and GitHub's [documented alert dismissal process](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts).

At the original implementation baseline, all six PR checks passed: full Linux tests/types/lint/demos, macOS portability, dependency review, DCO, CodeQL analysis, and CodeQL results. Owner review revisions follow below; M2 work has not begun.

## Owner-review revision evidence

The owner requested repository-wide readability, documentation, versioning, migration, and CI hygiene before approval. The implementation and compatibility decisions are in [ADR 0010](adr/0010-contributor-hygiene-and-schema-migrations.md); ongoing expectations are in [engineering standards](ENGINEERING.md).

| Check                                                                  | Result                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                            | 118 tests passed across 15 files, retaining the original workflow behavior and adding migration, pointer, summary, and hygiene failure coverage.                        |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm hygiene`     | Passed; all packages have README/CHANGELOG files, canonical SemVer metadata, useful public JSDoc, and a release plan.                                                   |
| JSDoc description policy using the configured ESLint API               | Five negative and five positive cases passed: functions, classes, interfaces, type aliases, and constants reject empty descriptions and accept documented declarations. |
| `pnpm docs:api`                                                        | HTML generated and validated without warnings for all eight packages under ignored `.generated/api/`.                                                                   |
| Changesets versioning in a temporary package copy                      | All eight private packages became 0.1.0 with generated changelog entries; actual development manifests remain 0.0.0 pending reviewed versioning.                        |
| Original YAML CLI validation and fake execution                        | Passed; the compatibility smoke check remains in CI.                                                                                                                    |
| File-referenced health endpoint fake task                              | Succeeded with one worker and one verifier attempt, both acceptance tests passed, exit zero, and a clean source checkout.                                               |
| Revised fake task later-process `status` and `inspect`                 | Recovered success, immutable definition, workspace evidence, and all 27 events.                                                                                         |
| Retained original fake/live stores through versioned migration startup | Reopened successfully; definitions and all eighteen artifact bodies retain their original digests.                                                                      |
| Original live worker report against stronger current summary schema    | Passed; no additional provider call was required for this hygiene revision.                                                                                             |

The revised fake run is `9e91b2c5-7590-40c3-9074-f4ff95fb45a0`. Its definition digest is `sha256:fdbc84d509e6b1a70e9c021e778c108b86873d62b696d8a265bbd8b214e6cca2`; base/final head is `0075967cb611ee1f80b7bb67e815a5fbc453710c`. Only `server.mjs` changed. All nine revised artifacts were read with digest verification. Verifier stdout was 204 bytes, stderr zero, neither truncated; duration approximately 156 ms. Its diff digest remains `sha256:2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd`.

Current reproducible fixture names are `examples/demo-repos/health-endpoint/`, `examples/fake/health-endpoint.yaml`, and `scripts/create-endpoint-fixture.ts`. The fake server implementation lives in a separate JavaScript source file. Recorded commands above retain the original baseline names deliberately.

The original fake report's short summary does not satisfy the newer contract; it remains valid under its original embedded schema and is not rewritten. New definitions require thirty non-whitespace summary characters. This rejects blank and padded reports, while independent command verification still decides acceptance. The original live report already satisfies the stronger requirement. Both original normalized-definition digests remain unchanged after migration.

Updated GitHub checks are tracked on [PR #9](https://github.com/gsornsen/anastom/pull/9). Linux tests/types/lint/format/hygiene/demo, macOS portability, dependency review, DCO, and CodeQL analysis passed on revision `d7bb4d9`. CodeQL re-reported the identical operator-selected local task read as alert 7 after formatting; comparison with dismissed alert 6 confirmed the same intentional local-file boundary, and the new instance was individually triaged with the recorded ADR 0009 rationale. The query remains enabled. The duplicated durable fake-demo CI step was consolidated into actual cross-process CLI test coverage, macOS checks use capability names, and the required Linux display name is preserved. No live model request is part of routine CI. The owner approved revision `84b394c`; the subsequent lint correction extends description enforcement from functions to all JSDoc blocks, as checked above.

Reproduction commands and limits are in [M1_DEMO.md](M1_DEMO.md); the required completion checklist is in [M1_BUILD_BRIEF.md](M1_BUILD_BRIEF.md).
