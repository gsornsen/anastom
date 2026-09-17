import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { DurableRunInspection } from "../packages/cli/src/durable.js";
import { RunStoreError, type RunEvent, type RunState } from "../packages/engine/src/index.js";
import { observeLocalProcess } from "../packages/execution-host/src/index.js";
import { FileArtifactStore, SqliteDurableRunStore } from "../packages/persistence/src/index.js";
import { digestBytes } from "../packages/core/src/index.js";
import {
  loadFeatureWorkspaceTopology,
  GitWorkspaceManager,
} from "../packages/workspaces/src/index.js";

import type { DefinedSdlcAcceptanceScenario } from "./testing/defined-sdlc-acceptance-runtime.js";

const executeFile = promisify(execFile);
const coordinatorProgram = fileURLToPath(
  new URL("./testing/defined-sdlc-acceptance-coordinator.ts", import.meta.url),
);
const cliProgram = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));
const passingVerifier = fileURLToPath(
  new URL("./testing/fixtures/defined-sdlc-acceptance.mjs", import.meta.url),
);
const failingVerifier = fileURLToPath(
  new URL("./testing/fixtures/defined-sdlc-verifier-failure.mjs", import.meta.url),
);
const tsxImport = import.meta.resolve("tsx");
const tsconfigPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const processOutputLimit = 1024 * 1024;
const processTimeoutMs = 90_000;

interface CapturedProcess {
  child: ChildProcess;
  completion: Promise<ProcessResult>;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Probe {
  nodeId: string;
  phase: string;
  observedAtMs: number;
  processId: number;
}

interface CompletedCase {
  repository: string;
  runId: string;
  state: RunState;
  events: RunEvent[];
}

/** Model-free evidence from production-shaped defined-SDLC process acceptance. */
export interface DefinedSdlcAcceptanceEvidence {
  version: "anastom.dev/defined-sdlc-acceptance-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  node: string;
  successOrders: readonly {
    scenario: "left-first" | "right-first";
    completionOrder: readonly string[];
    workersOverlapped: true;
    independentReviewProcesses: true;
    terminalState: "succeeded";
    integrations: number;
    acceptedPatches: number;
    verifierPassed: true;
    artifactsVerified: number;
    sourceCheckoutClean: true;
    retainedBranch: string;
    laterProcessInspection: true;
  }[];
  controls: readonly {
    action: "pause" | "cancel";
    activeExecutions: 2;
    cancellationFanIn: true;
    terminalState: "paused" | "cancelled";
    sourceCheckoutClean: true;
  }[];
  siblingFailure: {
    terminalState: "failed";
    siblingCancelled: true;
    sourceCheckoutClean: true;
  };
  reviewRejection: {
    terminalState: "failed";
    verifierStarted: false;
    sourceCheckoutClean: true;
  };
  verifierFailure: {
    terminalState: "failed";
    exitCode: 7;
    sourceCheckoutClean: true;
  };
  integrationRecovery: {
    preparedBeforeCrash: true;
    committedAfterRestart: true;
    initialOwnerAbsent: true;
    staleFenceRejected: "ownership-conflict";
    terminalState: "succeeded";
    sourceCheckoutClean: true;
  };
  protectedInputPreserved: true;
  modelCalls: 0;
}

function featureMarkdown(): string {
  return `---
apiVersion: anastom.dev/v1alpha1
kind: Feature
metadata: {id: acceptance/defined-sdlc, version: 0.1.0}
acceptanceCriteria:
  - Both independent implementations and the integration correction pass acceptance
verification:
  - id: acceptance
    argv: [node, acceptance.mjs]
    maxDuration: 30s
policies:
  maxTasks: 2
  maxParallel: 2
  protectedPaths: [acceptance.mjs]
  attemptPolicy: {maxAttempts: 1, maxDuration: 30s}
---
Implement the independent left and right fixture behavior, combine it coherently, obtain both independent reviews, and pass the protected acceptance program.
`;
}

function spawnTypeScript(program: string, args: readonly string[], cwd: string): CapturedProcess {
  const child = spawn(process.execPath, ["--import", tsxImport, program, ...args], {
    cwd,
    env: { ...process.env, NODE_ENV: "test", TSX_TSCONFIG_PATH: tsconfigPath },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8", 0, Math.max(0, processOutputLimit - stdout.length));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8", 0, Math.max(0, processOutputLimit - stderr.length));
  });
  return {
    child,
    completion: new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
  };
}

async function runTypeScript(
  program: string,
  args: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  const running = spawnTypeScript(program, args, cwd);
  return waitForProcess(running, program);
}

async function waitForProcess(
  running: CapturedProcess,
  label: string,
  timeoutMs = processTimeoutMs,
): Promise<ProcessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      running.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          running.child.kill("SIGKILL");
          reject(new Error(`Process timed out: ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForCondition(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function parseJson<T>(result: ProcessResult): T {
  if (result.code !== 0 || result.stderr.trim()) {
    throw new Error(`Fixture process failed: ${result.stderr || result.stdout}`);
  }
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) {
    throw new Error("Fixture process produced no JSON result");
  }
  return JSON.parse(line) as T;
}

async function createRepository(scenario: DefinedSdlcAcceptanceScenario): Promise<string> {
  const repository = await realpath(
    await mkdtemp(join(tmpdir(), `anastom-defined-sdlc-${scenario}-`)),
  );
  await Promise.all([
    writeFile(join(repository, ".gitignore"), ".anastom/\n"),
    writeFile(join(repository, "feature.md"), featureMarkdown()),
    writeFile(join(repository, "left.txt"), ""),
    writeFile(join(repository, "right.txt"), ""),
    cp(
      scenario === "verifier-failure" ? failingVerifier : passingVerifier,
      join(repository, "acceptance.mjs"),
    ),
  ]);
  await executeFile("git", ["init", "-q", "--initial-branch=main"], { cwd: repository });
  await executeFile("git", ["config", "user.name", "Anastom Fixture"], { cwd: repository });
  await executeFile("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: repository,
  });
  await executeFile("git", ["add", "."], { cwd: repository });
  await executeFile(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: repository },
  );
  return repository;
}

async function coordinator(options: {
  action: "start" | "resume" | "control";
  repository: string;
  runId: string;
  scenario: DefinedSdlcAcceptanceScenario;
  extra?: readonly string[];
}): Promise<ProcessResult> {
  return runTypeScript(
    coordinatorProgram,
    [options.action, options.repository, options.runId, options.scenario, ...(options.extra ?? [])],
    options.repository,
  );
}

async function loadCompletedCase(repository: string, runId: string): Promise<CompletedCase> {
  const store = new SqliteDurableRunStore(join(repository, ".anastom", "anastom.sqlite"));
  try {
    const loaded = await store.load(runId, "complete-history");
    if (!loaded) {
      throw new Error(`Run ${runId} is missing`);
    }
    return { repository, runId, state: loaded.state, events: loaded.events };
  } finally {
    store.close();
  }
}

async function readProbe(repository: string, runId: string, name: string): Promise<Probe> {
  return JSON.parse(
    await readFile(
      join(repository, ".anastom", "acceptance-probes", runId, `${name}.json`),
      "utf8",
    ),
  ) as Probe;
}

async function probeExists(repository: string, runId: string, name: string): Promise<boolean> {
  try {
    await readProbe(repository, runId, name);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function sourceClean(repository: string): Promise<boolean> {
  return (
    (await executeFile("git", ["status", "--porcelain"], { cwd: repository })).stdout.trim() === ""
  );
}

async function verifyArtifacts(value: CompletedCase): Promise<number> {
  const store = new FileArtifactStore(join(value.repository, ".anastom"));
  const artifacts = value.events.filter((event) => event.type === "ArtifactProduced");
  for (const event of artifacts) {
    const bytes = await store.read(event.artifact);
    if (digestBytes(bytes) !== event.artifact.digest) {
      throw new Error("Acceptance artifact digest changed");
    }
  }
  return artifacts.length;
}

async function inspectInLaterProcess(value: CompletedCase): Promise<DurableRunInspection> {
  const result = await runTypeScript(
    cliProgram,
    ["inspect", value.runId, "--state-dir", join(value.repository, ".anastom"), "--json"],
    value.repository,
  );
  if (result.code !== 0 || result.stderr.trim()) {
    throw new Error(`Later-process inspection failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as DurableRunInspection;
}

async function runSuccessOrder(
  scenario: "left-first" | "right-first",
): Promise<DefinedSdlcAcceptanceEvidence["successOrders"][number]> {
  const repository = await createRepository(scenario);
  const runId = `defined-sdlc-${scenario}`;
  try {
    const state = parseJson<RunState>(
      await coordinator({ action: "start", repository, runId, scenario }),
    );
    const completed = await loadCompletedCase(repository, runId);
    const [leftStarted, leftCompleted, rightStarted, rightCompleted, specification, quality] =
      await Promise.all([
        readProbe(repository, runId, "implement-left-started"),
        readProbe(repository, runId, "implement-left-completed"),
        readProbe(repository, runId, "implement-right-started"),
        readProbe(repository, runId, "implement-right-completed"),
        readProbe(repository, runId, "review-specification-started"),
        readProbe(repository, runId, "review-quality-started"),
      ]);
    const completionOrder = completed.events.flatMap((event) =>
      event.type === "NodeSucceeded" &&
      (event.nodeId === "implement.left" || event.nodeId === "implement.right")
        ? [event.nodeId]
        : [],
    );
    const expectedOrder =
      scenario === "left-first"
        ? ["implement.left", "implement.right"]
        : ["implement.right", "implement.left"];
    const workersOverlapped =
      leftStarted.observedAtMs <= rightCompleted.observedAtMs &&
      rightStarted.observedAtMs <= leftCompleted.observedAtMs;
    const topology = await loadFeatureWorkspaceTopology(
      new GitWorkspaceManager(join(repository, ".anastom")),
      runId,
    );
    const [left, right, protectedProgram] = await Promise.all([
      readFile(join(topology.integration.path, "left.txt"), "utf8"),
      readFile(join(topology.integration.path, "right.txt"), "utf8"),
      readFile(join(topology.integration.path, "acceptance.mjs")),
    ]);
    const later = await inspectInLaterProcess(completed);
    if (
      state.status !== "succeeded" ||
      completionOrder.join("\0") !== expectedOrder.join("\0") ||
      !workersOverlapped ||
      specification.processId === quality.processId ||
      left !== "left implementation\nintegration correction\n" ||
      right !== "right implementation\n" ||
      !protectedProgram.equals(await readFile(passingVerifier)) ||
      later.state.status !== "succeeded" ||
      !later.evidence ||
      !later.liveEvents?.some((event) => event.type === "verification" && event.passed)
    ) {
      throw new Error(`Successful completion-order evidence failed for ${scenario}`);
    }
    const artifactsVerified = await verifyArtifacts(completed);
    const clean = await sourceClean(repository);
    if (!clean) {
      throw new Error("Source checkout changed during acceptance");
    }
    return {
      scenario,
      completionOrder,
      workersOverlapped: true,
      independentReviewProcesses: true,
      terminalState: "succeeded",
      integrations: Object.keys(state.integrations ?? {}).length,
      acceptedPatches: Object.keys(state.acceptedPatches ?? {}).length,
      verifierPassed: true,
      artifactsVerified,
      sourceCheckoutClean: true,
      retainedBranch: topology.integration.branch,
      laterProcessInspection: true,
    };
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function runControlCase(
  action: "pause" | "cancel",
): Promise<DefinedSdlcAcceptanceEvidence["controls"][number]> {
  const repository = await createRepository("hold-workers");
  const runId = `defined-sdlc-${action}`;
  const running = spawnTypeScript(
    coordinatorProgram,
    ["start", repository, runId, "hold-workers"],
    repository,
  );
  let coordinatorExited = false;
  try {
    await waitForCondition(`${action} worker fan-out`, async () => {
      return (
        (await probeExists(repository, runId, "implement-left-started")) &&
        (await probeExists(repository, runId, "implement-right-started"))
      );
    });
    const before = await loadCompletedCase(repository, runId);
    const active = ["implement.left", "implement.right"].filter((nodeId) => {
      return before.state.nodes[nodeId]?.attempts.at(-1)?.status === "running";
    });
    const receipt = parseJson<{ action: string; replayed: boolean }>(
      await coordinator({
        action: "control",
        repository,
        runId,
        scenario: "hold-workers",
        extra: [action, randomUUID()],
      }),
    );
    const state = parseJson<RunState>(await waitForProcess(running, `${action} coordinator`));
    coordinatorExited = true;
    const [leftCancelled, rightCancelled, clean] = await Promise.all([
      probeExists(repository, runId, "implement-left-cancelled"),
      probeExists(repository, runId, "implement-right-cancelled"),
      sourceClean(repository),
    ]);
    if (
      active.length !== 2 ||
      receipt.action !== action ||
      receipt.replayed ||
      state.status !== (action === "pause" ? "paused" : "cancelled") ||
      !leftCancelled ||
      !rightCancelled ||
      !clean
    ) {
      throw new Error(`${action} did not fan in both active executions`);
    }
    return {
      action,
      activeExecutions: 2,
      cancellationFanIn: true,
      terminalState: state.status,
      sourceCheckoutClean: true,
    };
  } finally {
    if (
      !coordinatorExited &&
      running.child.exitCode === null &&
      running.child.signalCode === null
    ) {
      running.child.kill("SIGKILL");
      await running.completion.catch(() => undefined);
    }
    await rm(repository, { recursive: true, force: true });
  }
}

async function runTerminalFailure(
  scenario: "worker-failure" | "review-rejection" | "verifier-failure",
): Promise<CompletedCase> {
  const repository = await createRepository(scenario);
  const runId = `defined-sdlc-${scenario}`;
  try {
    const state = parseJson<RunState>(
      await coordinator({ action: "start", repository, runId, scenario }),
    );
    if (state.status !== "failed") {
      throw new Error(`${scenario} did not fail the run`);
    }
    return await loadCompletedCase(repository, runId);
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}

async function runSiblingFailure(): Promise<DefinedSdlcAcceptanceEvidence["siblingFailure"]> {
  const completed = await runTerminalFailure("worker-failure");
  try {
    const siblingCancelled = await probeExists(
      completed.repository,
      completed.runId,
      "implement-right-cancelled",
    );
    if (!siblingCancelled || !(await sourceClean(completed.repository))) {
      throw new Error("Worker failure did not cancel its active sibling cleanly");
    }
    return {
      terminalState: "failed",
      siblingCancelled: true,
      sourceCheckoutClean: true,
    };
  } finally {
    await rm(completed.repository, { recursive: true, force: true });
  }
}

async function runReviewRejection(): Promise<DefinedSdlcAcceptanceEvidence["reviewRejection"]> {
  const completed = await runTerminalFailure("review-rejection");
  try {
    const verifierStarted = completed.events.some(
      (event) => event.type === "AttemptScheduled" && event.nodeId === "verify.acceptance",
    );
    if (verifierStarted || !(await sourceClean(completed.repository))) {
      throw new Error("Rejected review allowed verification or changed the source checkout");
    }
    return {
      terminalState: "failed",
      verifierStarted: false,
      sourceCheckoutClean: true,
    };
  } finally {
    await rm(completed.repository, { recursive: true, force: true });
  }
}

async function runVerifierFailure(): Promise<DefinedSdlcAcceptanceEvidence["verifierFailure"]> {
  const completed = await runTerminalFailure("verifier-failure");
  try {
    const command = completed.events.find(
      (event) => event.type === "CommandCompleted" && event.nodeId === "verify.acceptance",
    );
    if (command?.type !== "CommandCompleted" || command.output.exitCode !== 7) {
      throw new Error("Verifier failure did not retain its exact exit code");
    }
    if (!(await sourceClean(completed.repository))) {
      throw new Error("Verifier failure changed the source checkout");
    }
    return { terminalState: "failed", exitCode: 7, sourceCheckoutClean: true };
  } finally {
    await rm(completed.repository, { recursive: true, force: true });
  }
}

async function runIntegrationRecovery(): Promise<
  DefinedSdlcAcceptanceEvidence["integrationRecovery"]
> {
  const repository = await createRepository("integration-crash");
  const runId = "defined-sdlc-integration-crash";
  const stateDir = join(repository, ".anastom");
  const running = spawnTypeScript(
    coordinatorProgram,
    ["start", repository, runId, "integration-crash"],
    repository,
  );
  let store: SqliteDurableRunStore | undefined;
  let coordinatorExited = false;
  try {
    await waitForCondition("prepared integration reconciliation", () =>
      probeExists(repository, runId, "integration-reconcile-started"),
    );
    store = new SqliteDurableRunStore(join(stateDir, "anastom.sqlite"));
    const [before, initialLease] = await Promise.all([
      store.load(runId, "complete-history"),
      store.inspectLease(runId),
    ]);
    if (
      !before ||
      !initialLease ||
      initialLease.released ||
      !before.events.some((event) => event.type === "IntegrationPrepared") ||
      before.events.some((event) => event.type === "IntegrationCommitted") ||
      running.child.pid === undefined ||
      running.child.pid !== initialLease.owner.pid
    ) {
      throw new Error("Integration crash boundary was not durably prepared");
    }
    process.kill(running.child.pid, "SIGKILL");
    const killed = await waitForProcess(running, "integration-crash coordinator", 10_000);
    coordinatorExited = true;
    if (killed.signal !== "SIGKILL") {
      throw new Error("Integration coordinator did not stop at the requested boundary");
    }
    await waitForCondition(
      "integration owner absence",
      async () => (await observeLocalProcess(initialLease.owner)).state === "absent",
      5_000,
    );
    await waitForCondition(
      "integration lease expiry",
      async () => Date.now() >= initialLease.expiresAtMs,
      Math.max(5_000, initialLease.expiresAtMs - Date.now() + 5_000),
    );
    const state = parseJson<RunState>(
      await coordinator({
        action: "resume",
        repository,
        runId,
        scenario: "integration-crash",
        extra: [randomUUID()],
      }),
    );
    const after = await store.load(runId, "complete-history");
    if (!after || state.status !== "succeeded") {
      throw new Error("Prepared integration did not complete after restart");
    }
    let staleFenceRejected: string | undefined;
    try {
      await store.commit({
        lease: {
          runId,
          ownerId: initialLease.ownerId,
          generation: initialLease.generation,
        },
        operationId: "stale-defined-sdlc-owner",
        expectedSequence: after.state.sequence,
        events: [
          {
            type: "RunPaused",
            runId,
            sequence: after.state.sequence + 1,
          },
        ],
      });
    } catch (error) {
      staleFenceRejected = error instanceof RunStoreError ? error.code : undefined;
    }
    if (
      staleFenceRejected !== "ownership-conflict" ||
      !after.events.some((event) => event.type === "IntegrationCommitted") ||
      !(await sourceClean(repository))
    ) {
      throw new Error("Integration recovery or stale fencing evidence changed");
    }
    return {
      preparedBeforeCrash: true,
      committedAfterRestart: true,
      initialOwnerAbsent: true,
      staleFenceRejected: "ownership-conflict",
      terminalState: "succeeded",
      sourceCheckoutClean: true,
    };
  } finally {
    store?.close();
    if (
      !coordinatorExited &&
      running.child.exitCode === null &&
      running.child.signalCode === null
    ) {
      running.child.kill("SIGKILL");
      await running.completion.catch(() => undefined);
    }
    await rm(repository, { recursive: true, force: true });
  }
}

/** Run the production-shaped defined-SDLC process acceptance matrix without model calls. */
export async function runDefinedSdlcAcceptance(): Promise<DefinedSdlcAcceptanceEvidence> {
  process.stderr.write("defined-SDLC acceptance: left-first success\n");
  const leftFirst = await runSuccessOrder("left-first");
  process.stderr.write("defined-SDLC acceptance: right-first success\n");
  const rightFirst = await runSuccessOrder("right-first");
  const successOrders = [leftFirst, rightFirst];
  process.stderr.write("defined-SDLC acceptance: pause fan-in\n");
  const pause = await runControlCase("pause");
  process.stderr.write("defined-SDLC acceptance: cancel fan-in\n");
  const cancel = await runControlCase("cancel");
  const controls = [pause, cancel];
  process.stderr.write("defined-SDLC acceptance: sibling failure\n");
  const siblingFailure = await runSiblingFailure();
  process.stderr.write("defined-SDLC acceptance: review rejection\n");
  const reviewRejection = await runReviewRejection();
  process.stderr.write("defined-SDLC acceptance: verifier failure\n");
  const verifierFailure = await runVerifierFailure();
  process.stderr.write("defined-SDLC acceptance: integration recovery\n");
  const integrationRecovery = await runIntegrationRecovery();
  return {
    version: "anastom.dev/defined-sdlc-acceptance-evidence/v1alpha1",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    successOrders,
    controls,
    siblingFailure,
    reviewRejection,
    verifierFailure,
    integrationRecovery,
    protectedInputPreserved: true,
    modelCalls: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await runDefinedSdlcAcceptance(), null, 2) + "\n");
}
