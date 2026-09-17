import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { platform, arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { digestBytes, type WorkflowDefinition } from "../packages/core/src/index.js";
import {
  projectEvidenceLedger,
  projectLiveRunEvents,
  type RunEvent,
  type RunState,
} from "../packages/engine/src/index.js";
import { FileArtifactStore, SqliteDurableRunStore } from "../packages/persistence/src/index.js";
import {
  GitWorkspaceManager,
  loadFeatureWorkspaceTopology,
  type FeatureWorkspaceTopology,
} from "../packages/workspaces/src/index.js";
import type { ArtifactRef, LiveRunEvent } from "../packages/runtime-contract/src/index.js";
import type { DurableRunInspection } from "../packages/cli/src/durable.js";

const executeFile = promisify(execFile);
const cliProgram = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));
const fixtureRoot = fileURLToPath(
  new URL("../examples/demo-repos/parallel-normalizers/", import.meta.url),
);
const tsxImport = import.meta.resolve("tsx");
const modelNodeIds = [
  "analysis",
  "planning",
  "implement.normalize-display-name",
  "implement.normalize-labels",
  "integrator",
  "review.specification",
  "review.quality",
] as const;
const implementationNodeIds = [
  "implement.normalize-display-name",
  "implement.normalize-labels",
] as const;
const reviewNodeIds = ["review.specification", "review.quality"] as const;
const protectedPaths = ["feature.md", "acceptance.mjs", "AGENTS.md"] as const;
const expectedChangedFiles = [
  "src/normalize-display-name.mjs",
  "src/normalize-labels.mjs",
] as const;
const forbiddenPrivateField =
  /^(?:apiKey|accessToken|refreshToken|authorization|cookie|privateReasoning|encryptedContent|rawProviderError)$/iu;
const forbiddenCredentialText =
  /(?:sk-ant-[a-z0-9_-]{10,}|sk-proj-[a-z0-9_-]{10,}|bearer\s+[a-z0-9._-]{16,}|(?:anthropic|openai)_api_key\s*[=:])/iu;

interface AuditOptions {
  repository: string;
  runId: string;
  runtimeId: "pi" | "codex";
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface AttemptInterval {
  nodeId: string;
  executionId: string;
  startedAtSequence: number;
  finishedAtSequence: number;
}

function parseArguments(argv: readonly string[]): AuditOptions {
  if (argv.length < 5 || argv.length > 6 || !["pi", "codex"].includes(argv[2] ?? "")) {
    throw new Error(
      "Usage: audit-defined-sdlc-live <repository> <run-id> <pi|codex> <provider> <model> [reasoning-effort]",
    );
  }
  const [repository, runId, runtimeId, provider, model, reasoningEffort] = argv;
  assert(repository && runId && runtimeId && provider && model);
  if (runtimeId === "codex" && !reasoningEffort) {
    throw new Error("Codex live evidence requires an explicit reasoning effort");
  }
  return {
    repository,
    runId,
    runtimeId: runtimeId as AuditOptions["runtimeId"],
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function terminalAttemptEvent(event: RunEvent, nodeId: string): boolean {
  return (
    "nodeId" in event &&
    event.nodeId === nodeId &&
    [
      "AttemptSucceeded",
      "AttemptFailed",
      "AttemptBlocked",
      "AttemptCancelled",
      "AttemptOrphaned",
    ].includes(event.type)
  );
}

function attemptInterval(events: readonly RunEvent[], nodeId: string): AttemptInterval {
  const authorized = events.find(
    (event) =>
      event.type === "AttemptStartAuthorized" && event.nodeId === nodeId && event.attempt === 1,
  );
  const finished = events.find((event) => terminalAttemptEvent(event, nodeId));
  assert(
    authorized?.type === "AttemptStartAuthorized",
    `${nodeId} has no first-attempt authorization evidence`,
  );
  assert(finished, `${nodeId} has no first-attempt terminal evidence`);
  return {
    nodeId,
    executionId: authorized.execution.executionId,
    startedAtSequence: authorized.sequence,
    finishedAtSequence: finished.sequence,
  };
}

function assertOverlap(left: AttemptInterval, right: AttemptInterval): void {
  assert(
    left.startedAtSequence < right.finishedAtSequence &&
      right.startedAtSequence < left.finishedAtSequence,
    `${left.nodeId} and ${right.nodeId} did not overlap`,
  );
  assert.notEqual(
    left.executionId,
    right.executionId,
    "Overlapping attempts reused an execution ID",
  );
}

function assertNoPrivateFields(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assert(!forbiddenPrivateField.test(key), `Private field persisted at ${path}.${key}`);
    assertNoPrivateFields(nested, `${path}.${key}`);
  }
}

function assertNoCredentialText(bytes: Uint8Array, artifactId: string): void {
  const text = Buffer.from(bytes).toString("utf8");
  assert(!forbiddenCredentialText.test(text), `Credential-shaped text persisted in ${artifactId}`);
}

function artifactLimit(artifact: ArtifactRef): number {
  if (["context"].includes(artifact.type)) {
    return 4 * 1024 * 1024;
  }
  if (["diff", "accepted-patch"].includes(artifact.type)) {
    return 16 * 1024 * 1024;
  }
  return 1024 * 1024;
}

function expectedArtifactTypes(nodeId: string): readonly string[] {
  if (nodeId === "verify.acceptance") {
    return ["command-result", "context", "diff", "stderr", "stdout"];
  }
  const types = ["context", "diff", "logs", "worker-report"];
  return nodeId.startsWith("implement.") || nodeId === "integrator"
    ? ["accepted-patch", ...types]
    : types;
}

async function verifyArtifacts(
  repository: string,
  runId: string,
  events: readonly RunEvent[],
): Promise<{ count: number; files: number; bytes: number }> {
  const artifactReferences = events.flatMap((event) =>
    event.type === "ArtifactProduced" ? [event.artifact] : [],
  );
  assert.equal(
    artifactReferences.length,
    39,
    "Live fixture artifact set is incomplete or unexpectedly expanded",
  );
  const artifacts = [
    ...new Map(artifactReferences.map((artifact) => [artifact.id, artifact])).values(),
  ];
  assert.equal(artifacts.length, 36, "Live fixture artifact file set changed");
  const byNode = new Map<string, ArtifactRef[]>();
  for (const artifact of artifacts) {
    const nodeArtifacts = byNode.get(artifact.producer.nodeId) ?? [];
    nodeArtifacts.push(artifact);
    byNode.set(artifact.producer.nodeId, nodeArtifacts);
  }
  for (const nodeId of [...modelNodeIds, "verify.acceptance"]) {
    assert.deepEqual(
      (byNode.get(nodeId) ?? []).map(({ type }) => type).sort(),
      [...expectedArtifactTypes(nodeId)].sort(),
      `${nodeId} artifact set is incomplete`,
    );
  }
  const store = new FileArtifactStore(join(repository, ".anastom"));
  let totalBytes = 0;
  for (const artifact of artifacts) {
    assert.equal(artifact.producer.runId, runId, "Artifact producer run changed");
    const bytes = await store.read(artifact);
    const metadata = await lstat(artifact.uri);
    assert.equal(metadata.mode & 0o077, 0, `Artifact permissions are not private: ${artifact.id}`);
    assert(
      bytes.byteLength <= artifactLimit(artifact),
      `Artifact exceeds its bound: ${artifact.id}`,
    );
    assertNoCredentialText(bytes, artifact.id);
    if (["context", "worker-report", "command-result"].includes(artifact.type)) {
      assertNoPrivateFields(JSON.parse(bytes.toString("utf8")), `artifact:${artifact.id}`);
    }
    totalBytes += bytes.byteLength;
  }
  return { count: artifactReferences.length, files: artifacts.length, bytes: totalBytes };
}

function assertBoundedPublicEvents(events: readonly LiveRunEvent[]): void {
  const logTotals = new Map<string, { bytes: number; messages: number }>();
  for (const event of events) {
    assertNoPrivateFields(event, `live:${event.sequence}`);
    assertNoCredentialText(Buffer.from(JSON.stringify(event)), `live-event-${event.sequence}`);
    if (event.type !== "log") {
      continue;
    }
    assert(Buffer.byteLength(event.message) <= 2 * 1024, "A public log message exceeds 2 KiB");
    const key = `${event.nodeId}\0${event.attempt}`;
    const total = logTotals.get(key) ?? { bytes: 0, messages: 0 };
    total.bytes += Buffer.byteLength(event.message);
    total.messages += 1;
    logTotals.set(key, total);
  }
  for (const total of logTotals.values()) {
    assert(total.bytes <= 64 * 1024, "An attempt's public logs exceed 64 KiB");
    assert(total.messages <= 129, "An attempt's public log count exceeds its bounded projection");
  }
}

async function inspectFromLaterProcess(
  repository: string,
  runId: string,
): Promise<DurableRunInspection> {
  const result = await executeFile(
    process.execPath,
    [
      "--import",
      tsxImport,
      cliProgram,
      "inspect",
      runId,
      "--state-dir",
      join(repository, ".anastom"),
      "--json",
    ],
    { cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.stderr, "", "Later-process inspection wrote diagnostics");
  return JSON.parse(result.stdout) as DurableRunInspection;
}

function assertRuntimeSelection(state: RunState, options: AuditOptions): void {
  assert.equal(state.status, "succeeded", "Live run did not succeed");
  assert.equal(state.runtimeDescriptor?.runtimeId, options.runtimeId, "Runtime selection changed");
  assert.equal(
    state.runtimeDescriptor.configuration.provider,
    options.provider,
    "Provider changed",
  );
  assert.equal(state.runtimeDescriptor.configuration.model, options.model, "Model changed");
  if (options.reasoningEffort) {
    assert.equal(
      state.runtimeDescriptor.configuration.reasoningEffort,
      options.reasoningEffort,
      "Reasoning effort changed",
    );
  }
}

function assertLaterInspection(
  later: DurableRunInspection,
  state: RunState,
  events: readonly RunEvent[],
  workflow: WorkflowDefinition,
): asserts later is DurableRunInspection & {
  events: RunEvent[];
  evidence: NonNullable<DurableRunInspection["evidence"]>;
  liveEvents: LiveRunEvent[];
} {
  assert.deepEqual(later.state, state, "Later process reconstructed different state");
  assert.deepEqual(later.events, events, "Later process read different authoritative history");
  assert.deepEqual(later.evidence, projectEvidenceLedger(workflow, events));
  assert.deepEqual(later.liveEvents, projectLiveRunEvents(workflow, events));
  assert(later.evidence && later.liveEvents, "Later-process evidence projections are missing");
  assertBoundedPublicEvents(later.liveEvents);
}

function assertModelOutcomes(state: RunState, options: AuditOptions): void {
  for (const nodeId of modelNodeIds) {
    const node = state.nodes[nodeId];
    assert.equal(node?.status, "succeeded", `${nodeId} did not succeed`);
    assert.equal(node.attempts.length, 1, `${nodeId} did not finish in one attempt`);
    const identities = node.attempts[0]?.identity ?? [];
    assert(identities.length > 0, `${nodeId} has no effective runtime identity`);
    for (const identity of identities) {
      assert.equal(identity.provider, options.provider, `${nodeId} provider changed`);
      assert.equal(identity.model, options.model, `${nodeId} model changed`);
    }
  }
  for (const nodeId of reviewNodeIds) {
    const output = state.nodes[nodeId]?.output;
    assert(
      output && typeof output === "object" && !Array.isArray(output) && output.approved === true,
      `${nodeId} did not retain structured approval`,
    );
  }
}

function assertAcceptedPatches(state: RunState): void {
  assert.equal(Object.keys(state.acceptedPatches ?? {}).length, 3, "Accepted patch set changed");
  assert.deepEqual(state.acceptedPatches?.["normalize-display-name"]?.changedFiles, [
    "src/normalize-display-name.mjs",
  ]);
  assert.deepEqual(state.acceptedPatches?.["normalize-labels"]?.changedFiles, [
    "src/normalize-labels.mjs",
  ]);
  const integratorPatch = state.acceptedPatches?.["integration-corrections"];
  assert.deepEqual(integratorPatch?.changedFiles, [], "No-op integrator patch gained files");
  assert.equal(
    integratorPatch?.patchDigest,
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "No-op integrator patch identity changed",
  );
}

async function assertIntegration(
  options: AuditOptions,
  state: RunState,
): Promise<{
  integrations: NonNullable<RunState["integrations"]>[string][];
  topology: FeatureWorkspaceTopology;
  finalCommit: string;
}> {
  const integrations = Object.values(state.integrations ?? {});
  assert.equal(integrations.length, 2, "Expected wave and final integration commits");
  assert(
    integrations.every(({ committed }) => committed),
    "An integration was not committed",
  );
  const topology = await loadFeatureWorkspaceTopology(
    new GitWorkspaceManager(join(options.repository, ".anastom")),
    options.runId,
  );
  const finalCommit = integrations.at(-1)?.committed?.commit;
  assert(finalCommit, "Final integration commit is missing");
  assert.equal(
    await git(options.repository, ["rev-parse", topology.integration.branch]),
    finalCommit,
    "Retained integration branch does not name the final commit",
  );
  assert.equal(
    await git(options.repository, ["status", "--porcelain"]),
    "",
    "Source checkout changed",
  );
  assert.equal(
    await git(topology.integration.path, ["status", "--porcelain"]),
    "",
    "Integration worktree is dirty",
  );
  assert.deepEqual(
    (
      await git(options.repository, ["diff", "--name-only", topology.sourceBaseCommit, finalCommit])
    ).split("\n"),
    [...expectedChangedFiles],
    "Integrated commit changed files outside the two planned scopes",
  );
  return { integrations, topology, finalCommit };
}

async function verifyProtectedInputs(
  options: AuditOptions,
  topology: FeatureWorkspaceTopology,
): Promise<Record<string, string>> {
  const protectedDigests: Record<string, string> = {};
  for (const path of protectedPaths) {
    const [fixture, source, integrated] = await Promise.all([
      readFile(join(fixtureRoot, path)),
      readFile(join(options.repository, path)),
      readFile(join(topology.integration.path, path)),
    ]);
    assert(source.equals(fixture), `${path} changed in the source checkout`);
    assert(integrated.equals(fixture), `${path} changed on the integration branch`);
    protectedDigests[path] = digestBytes(fixture);
  }
  return protectedDigests;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const stateDir = join(options.repository, ".anastom");
  const store = new SqliteDurableRunStore(join(stateDir, "anastom.sqlite"));
  const loaded = await store.load(options.runId, "complete-history");
  store.close();
  assert(loaded, `Run ${options.runId} does not exist`);
  const { state, events, workflow } = loaded;
  assertRuntimeSelection(state, options);

  const later = await inspectFromLaterProcess(options.repository, options.runId);
  assertLaterInspection(later, state, events, workflow);
  assertNoPrivateFields(events, "events");
  assertNoCredentialText(Buffer.from(JSON.stringify(events)), "authoritative-events");
  assertModelOutcomes(state, options);

  const workers: [AttemptInterval, AttemptInterval] = [
    attemptInterval(events, implementationNodeIds[0]),
    attemptInterval(events, implementationNodeIds[1]),
  ];
  const reviews: [AttemptInterval, AttemptInterval] = [
    attemptInterval(events, reviewNodeIds[0]),
    attemptInterval(events, reviewNodeIds[1]),
  ];
  assertOverlap(workers[0], workers[1]);
  assertOverlap(reviews[0], reviews[1]);

  const verifier = state.nodes["verify.acceptance"];
  assert.equal(verifier?.status, "succeeded", "Operator verifier did not succeed");
  assert.equal(verifier.command?.passed, true, "Operator verifier did not pass");
  assert.equal(verifier.command?.exitCode, 0, "Operator verifier exit code changed");
  assert.equal(verifier.command?.stdoutBytes, 39, "Operator verifier output changed");
  assert.equal(verifier.command?.stderrBytes, 0, "Operator verifier emitted diagnostics");

  assertAcceptedPatches(state);
  const { integrations, topology, finalCommit } = await assertIntegration(options, state);
  const protectedDigests = await verifyProtectedInputs(options, topology);
  const artifacts = await verifyArtifacts(options.repository, options.runId, events);
  const runtimeVersions = [
    ...new Set(
      modelNodeIds.flatMap((nodeId) =>
        (state.nodes[nodeId]?.attempts[0]?.identity ?? []).flatMap((identity) =>
          identity.runtimeVersion ? [identity.runtimeVersion] : [],
        ),
      ),
    ),
  ];

  process.stdout.write(
    `${JSON.stringify(
      {
        version: "anastom.dev/defined-sdlc-live-evidence/v1alpha1",
        platform: platform(),
        architecture: arch(),
        node: process.version,
        runId: options.runId,
        runtime: {
          id: options.runtimeId,
          provider: options.provider,
          model: options.model,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
          versions: runtimeVersions,
        },
        terminalState: state.status,
        throughSequence: state.sequence,
        workers: { intervals: workers, overlapped: true },
        reviews: { intervals: reviews, overlapped: true, independentlyApproved: true },
        integrations: integrations.map(({ preparation, committed }) => ({
          preparationDigest: preparation.preparationDigest,
          parentCommit: preparation.parentCommit,
          commit: committed?.commit,
        })),
        finalCommit,
        retainedBranch: topology.integration.branch,
        acceptedPatches: Object.keys(state.acceptedPatches ?? {}).length,
        verifier: verifier.command,
        artifacts: { ...artifacts, privateModes: true, digestVerified: true, bounded: true },
        privateDataAudit: { credentialPatternsAbsent: true, privateFieldsAbsent: true },
        protectedDigests,
        sourceCheckoutClean: true,
        integrationWorktreeClean: true,
        laterProcessInspection: true,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
