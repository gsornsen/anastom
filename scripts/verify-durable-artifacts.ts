import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { FileArtifactStore } from "../packages/persistence/src/index.js";
import { runCli, type DurableRunInspection } from "../packages/cli/src/index.js";
import { canonicalExistingRoot, resolveExistingChild } from "../packages/path-policy/src/index.js";

const [runId, directory] = process.argv.slice(2);
if (!runId || !directory) {
  throw new Error("Usage: verify-durable-artifacts <run-id> <state-dir>");
}
const auditRoot = await canonicalExistingRoot(
  process.platform === "darwin" ? "/private/tmp" : "/tmp",
);
const stateDir = await resolveExistingChild(auditRoot, directory, "directory");
const output: string[] = [];
const errors: string[] = [];
const code = await runCli(["inspect", runId, "--state-dir", stateDir, "--json"], {
  io: {
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  },
});
if (code !== 0 || errors.length !== 0 || output.length !== 1) {
  throw new Error("Later-process durable JSON inspection failed");
}
const inspection = JSON.parse(output[0]!) as DurableRunInspection;
const events = inspection.events;
if (!events) {
  throw new Error("Durable JSON inspection omitted authoritative events");
}
const workspace = inspection.state.workspace;
if (
  inspection.state.runId !== runId ||
  inspection.state.status !== "succeeded" ||
  workspace?.mode !== "isolated" ||
  workspace.repoRoot !== resolve(stateDir, "..")
) {
  throw new Error("Successful isolated run identity or workspace ownership is missing");
}
const artifactEvents = events.filter((event) => event.type === "ArtifactProduced");
if (artifactEvents.length === 0) {
  throw new Error("No durable artifacts were referenced");
}
const store = new FileArtifactStore(stateDir);
const bytesById = new Map<string, Buffer>();
for (const event of artifactEvents) {
  const artifact = event.artifact;
  const { id, type, digest, producer } = artifact;
  if (
    producer.runId !== runId ||
    producer.nodeId !== event.nodeId ||
    producer.attempt !== event.attempt ||
    id !== `${event.nodeId}-${event.attempt}-${type}-${digest.slice(7)}` ||
    bytesById.has(id)
  ) {
    throw new Error("Artifact producer, ID or uniqueness is inconsistent");
  }
  const bytes = await store.read(artifact);
  const independentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (independentDigest !== digest) {
    throw new Error("Artifact bytes fail independent SHA-256 verification");
  }
  bytesById.set(id, bytes);
}
const execute = promisify(execFile);
const [source, freshDiff] = await Promise.all([
  execute("git", ["status", "--porcelain"], { cwd: workspace.repoRoot }),
  execute("git", ["diff", "--binary", workspace.baseCommit, "--"], {
    cwd: workspace.path,
    maxBuffer: 16_777_216,
  }),
]);
if (source.stdout.trim()) {
  throw new Error("Source checkout is no longer clean");
}
const observed = events.filter((event) => event.type === "WorkspaceObserved");
if (
  observed.length === 0 ||
  observed.some(
    (event) =>
      event.changedFiles.length !== 1 ||
      event.changedFiles[0] !== "server.mjs" ||
      bytesById.get(event.diffArtifactId)?.toString("utf8") !== freshDiff.stdout,
  )
) {
  throw new Error("Retained worktree differs from a recorded diff or changed-file set");
}
const verifierResult = artifactEvents.find(
  (event) => event.nodeId === "verify" && event.artifact.type === "command-result",
);
const verifierStdout = artifactEvents.find(
  (event) => event.nodeId === "verify" && event.artifact.type === "stdout",
);
const verifierStderr = artifactEvents.find(
  (event) => event.nodeId === "verify" && event.artifact.type === "stderr",
);
if (!verifierResult || !verifierStdout || !verifierStderr) {
  throw new Error("Independent verifier's durable command artifacts are missing");
}
const command = JSON.parse(bytesById.get(verifierResult.artifact.id)!.toString("utf8")) as {
  passed?: unknown;
  exitCode?: unknown;
};
const stdout = bytesById.get(verifierStdout.artifact.id)!.toString("utf8");
const stderr = bytesById.get(verifierStderr.artifact.id)!;
if (
  command.passed !== true ||
  command.exitCode !== 0 ||
  !/^(?:#|ℹ)\s+tests 2$/m.test(stdout) ||
  !/^(?:#|ℹ)\s+pass 2$/m.test(stdout) ||
  !/^(?:#|ℹ)\s+fail 0$/m.test(stdout) ||
  stderr.length !== 0
) {
  throw new Error("Durable independent two-test verifier evidence did not pass");
}
process.stdout.write(
  JSON.stringify({
    runId,
    status: inspection.state.status,
    events: events.length,
    artifactsVerified: artifactEvents.length,
    verifierExitCode: command.exitCode,
    verifierTests: 2,
    verifierPassed: 2,
    verifierFailed: 0,
    sourceClean: true,
    retainedWorktree: workspace.path,
    changedFiles: ["server.mjs"],
    freshDiffMatches: true,
    modelCalls: 0,
  }) + "\n",
);
