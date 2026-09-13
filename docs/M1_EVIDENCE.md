# M1 completion evidence

Status: deterministic and required live Pi evidence recorded. Final code-analysis checks are being revalidated after task-parser hardening.

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

Recorded command evidence:

| Command | Result |
| --- | --- |
| `pnpm test` | 77 tests passed across 12 files; includes all 29 M0 tests. |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed. |
| `pnpm anastom validate examples/workflows/demo-feature.yaml` | Valid `demo/feature@0.1.0`, three nodes. |
| `pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml` | All three nodes succeeded, one attempt each. |
| M1 fake task run with explicit `examples/fake/m1-endpoint.yaml` and temporary fixture | Succeeded; worker report valid; verifier exit zero. |
| Later `pnpm anastom status <run-id> --state-dir <fixture>/.anastom` | Reconstructed succeeded worker/verifier from SQLite. |
| Later `pnpm anastom inspect <run-id> --state-dir <fixture>/.anastom` | Reconstructed definition/workspace/artifacts and all 27 events. |
| Live Pi run with `--provider anthropic --model claude-opus-4-8` on a fresh fixture | Succeeded; both acceptance tests passed; verifier exit zero. |
| Later live-run `status` and `inspect` | Reconstructed succeeded state and all 36 events. |
| Git status of the live source checkout | Clean; only the owned worktree received edits. |

## Retained fake run

Run ID: `12e5440b-bc7e-46d4-85e8-6fef5e1b621e`. Outcome: `succeeded`. Worker: deterministic `fake`, one attempt. Verifier: control-plane command, one attempt; exit `0`, signal `null`, duration approximately 151 ms. Acceptance: both HTTP tests passed.

The temporary fixture and worktree are retained locally. Machine-specific paths are represented as `<fixture>` here. Base and final head: `eaff09f0801d5da07d2424596514e1354c0df829`; branch: `anastom/12e5440b-bc7e-46d4-85e8-6fef5e1b621e`. Only `server.mjs` changed. The source checkout remained unchanged in the end-to-end tests. All nine artifact bodies were independently hashed and matched their stored references.

Definition digest: `sha256:06b3b515151796bbd8286f6150a3855304be664258fe8754633051045dc96677`.

| Producer | Artifact | SHA-256 (prefix `sha256:` omitted) |
| --- | --- | --- |
| implement/1 | context | ec64c2a39d3c68fbca6e6be04c73ab55542d77863a53191273a831367f3a502a |
| implement/1 | logs | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| implement/1 | worker-report | 572c04cd66fa1820f60212c54390d0f0216a47be9ced86e8724132bb9cda4545 |
| implement/1 | diff | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |
| verify/1 | context | 80f4a85951b25afceccea85c8e9171fd338fcd9e76d8d0b245e01a79e2a80e1f |
| verify/1 | stdout | 11b152e5c51836a46343e84e2e314abf7be0313d3f7ebd16ce5b399cac85b9c6 |
| verify/1 | stderr | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| verify/1 | command-result | de2013baf9726e8f287de21be05f9a8b3300d4fe6bbb96a92f007170aa754a7e |
| verify/1 | diff | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |

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

| Producer | Artifact | SHA-256 (prefix `sha256:` omitted) |
| --- | --- | --- |
| implement/1 | context | 397181fecea7a8bf9051d899e1e0dd8c6e545a915d5cdb04406cea8115dcf790 |
| implement/1 | logs | aeacca5bddd31e2b3503b9accb2c5b92048a53c72ed75275e1eb6281ef738264 |
| implement/1 | worker-report | 66930562c978fa788ac580dfe3f0a8d85ed76155c4dfbb85013a7bde5d2b7f76 |
| implement/1 | diff | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |
| verify/1 | context | 12a1f779c83f038cd4d7f00ee1f794aba0e1f900c95d7c96c4399d2f454364c7 |
| verify/1 | stdout | 7e3b092b7498665490493f013ab25f19aeba850be7c6d17fee053667dafd8dfc |
| verify/1 | stderr | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| verify/1 | command-result | 87297e55b3bed158a362a95f8e72ecf8c3acd1bdea1e5cd7dd6e9eac62dabff9 |
| verify/1 | diff | 2b9feb882a36967385fd84f56da838c8d9fda497cc1f52cbe76a61f5470e31bd |

The live retained diff is byte-identical to the complete fake-run diff printed above. Pi's validated report states that it added the method/URL health check and preserved unmatched-route behavior. Public logs contain only tool starts/finishes for `read`, `edit`, and `bash`; private reasoning, raw tool bodies, credentials, and session state are absent from the published record.

## CI and analysis

Node.js 24 Linux CI, Node.js 24 macOS portability, dependency review, and DCO passed on the initial implementation commit. CodeQL flagged the front-matter regular expression and direct task-file path use. The regex was replaced with a single line scan, including BOM/CRLF and repeated-delimiter regression coverage. The loader now resolves the explicitly selected task filename before reading, matching the compatible workflow loader. Final checks are being re-run on this change; no scan rules were disabled.

Reproduction commands and limits are in [M1_DEMO.md](M1_DEMO.md); the required completion checklist is in [M1_BUILD_BRIEF.md](M1_BUILD_BRIEF.md).
