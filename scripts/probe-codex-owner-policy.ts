import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformanceRequest } from "../packages/runtime-contract/src/testing/conformance.js";
import { inspectCodexPolicy } from "../packages/runtime-codex/src/policy.js";
import {
  CODEX_VERSION,
  createCodexProfile,
  resolveAuthFile,
  resolveCodexExecutable,
  type CodexProfile,
} from "../packages/runtime-codex/src/profile.js";

// Explicit model-free owner-auth check. Anastom inspects auth metadata only;
// the pinned native policy reader owns any normal subscription authentication.
const workspace = await mkdtemp(join(tmpdir(), "anastom-codex-owner-policy-"));
let profile: CodexProfile | undefined;
try {
  const executable = await resolveCodexExecutable();
  const authFile = await resolveAuthFile();
  profile = await createCodexProfile({
    request: conformanceRequest(workspace),
    authFile,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  });
  await inspectCodexPolicy({ executable, profile, workspace });
  console.log(
    JSON.stringify({
      runtime: "codex",
      nativeVersion: CODEX_VERSION,
      authentication: "normal-file-backed",
      managedPolicy: "absent",
      modelCalls: 0,
    }),
  );
} finally {
  await profile?.dispose();
  await rm(workspace, { recursive: true, force: true });
}
