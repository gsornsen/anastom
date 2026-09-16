import { ClaudeCodeRuntimeAdapter } from "@anastom/runtime-claude-code";
import { resolveClaudeCodeExecutable } from "../packages/runtime-claude-code/src/executable.js";
import {
  claudeProcessEnvironment,
  inspectClaudeAuthentication,
} from "../packages/runtime-claude-code/src/auth.js";
import { inspectClaudeManagedPolicy } from "../packages/runtime-claude-code/src/policy.js";

/** Model-free owner-platform audit; do not print status JSON or authentication metadata. */
const adapter = new ClaudeCodeRuntimeAdapter({
  provider: "anthropic",
  model: "claude-opus-4-8",
  authSource: "subscription",
});
let stage = "native-integrity";
try {
  const executable = await resolveClaudeCodeExecutable();
  stage = "environment";
  const environment = claudeProcessEnvironment("subscription");
  stage = "managed-policy";
  await inspectClaudeManagedPolicy();
  stage = "subscription-status";
  await inspectClaudeAuthentication(executable, "subscription", environment);
  const capabilities = await adapter.capabilities();
  process.stdout.write(
    JSON.stringify({
      runtime: adapter.id,
      nativeRelease: "2.1.268",
      authentication: "subscription-source-confirmed",
      managedPolicy: "absent-by-conservative-gate",
      workspaceModes: capabilities.workspaceModes,
      structuredOutput: capabilities.structuredOutput,
      modelCalls: 0,
    }) + "\n",
  );
} catch (error) {
  const category =
    error && typeof error === "object" && "category" in error ? error.category : "unknown";
  process.stdout.write(
    JSON.stringify({ runtime: adapter.id, preflight: "rejected", stage, category, modelCalls: 0 }) +
      "\n",
  );
  process.exitCode = 1;
}
