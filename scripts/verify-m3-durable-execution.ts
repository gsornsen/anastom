import { spawn, execFile, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import type { DurableRunInspection } from "../packages/cli/src/durable.js";
import type { RunEvent, RunLease, RunState } from "../packages/engine/src/index.js";
import { observeLocalProcess } from "../packages/execution-host/src/index.js";
import { ensurePrivatePathRoot, type PrivatePathRoot } from "../packages/path-policy/src/index.js";
import { FileArtifactStore, SqliteDurableRunStore } from "../packages/persistence/src/index.js";
import type { ArtifactRef } from "../packages/runtime-contract/src/index.js";

import {
  createEndpointRepository,
  removeEndpointRepository,
} from "../packages/engine/src/testing/fixture.js";

const executeFile = promisify(execFile);
const coordinatorProgram = fileURLToPath(
  new URL("./testing/m3-acceptance-coordinator.ts", import.meta.url),
);
const cliProgram = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const tsconfigPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const processOutputLimit = 1024 * 1024;
const processTimeoutMs = 45_000;
const privateRecordLimit = 256 * 1024;
const operationIds = {
  clean: "11111111-1111-4111-8111-111111111111",
  dirty: "22222222-2222-4222-8222-222222222222",
  unknown: "33333333-3333-4333-8333-333333333333",
  duplicate: "44444444-4444-4444-8444-444444444444",
  duplicateCancel: "66666666-6666-4666-8666-666666666666",
} as const;

type CrashScenario = "clean" | "dirty" | "unknown";

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

interface ReadyRun {
  lease: RunLease;
  state: RunState;
  firstExecutionId: string;
}

interface CrashCaseEvidence {
  runId: string;
  stateDir: string;
  statusBeforeExpiry: string;
  earlyTakeoverReason: string;
  firstExecutionId: string;
  initialLease: RunLease;
  finalState: RunState;
  finalLease: RunLease;
  events: RunEvent[];
  terminalRecord: Record<string, unknown>;
  cancellationProbeObserved: boolean;
  parentDeathCleanupConfirmed: boolean;
  replacementProbeObserved: boolean;
  sourceClean: boolean;
}

export interface M3DurableExecutionEvidence {
  version: "anastom.dev/m3-durable-execution-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  node: string;
  cleanRecovery: {
    runId: string;
    firstExecutionId: string;
    replacementExecutionId: string;
    ownershipGenerations: [number, number];
    orphanTransitions: number;
    terminalState: "succeeded";
    verifierPassed: true;
    eventCount: number;
    eventSequencesContiguous: true;
    parentDeathCleanupConfirmed: true;
    statusBeforeExpiryOwnerState: "unknown";
    beforeExpiryTakeoverRefused: "lease-active";
    staleGenerationAppendRejected: "ownership-conflict";
    repeatedResumeUnchanged: true;
    snapshotTailEqualsFullReplay: true;
    corruptSnapshotFallsBackToFullReplay: true;
    artifactsVerified: number;
    publicSentinelAbsent: true;
    sourceCheckoutClean: true;
    retainedWorktree: string;
    changedFiles: ["server.mjs"];
  };
  dirtyWorkspace: {
    runId: string;
    terminalState: "paused";
    differences: string[];
    orphanTransitions: number;
    replacementStarted: false;
    retainedDiffBytes: number;
    sourceCheckoutClean: true;
  };
  unknownExecution: {
    runId: string;
    terminalState: "recovery-blocked";
    reason: "invalid-record";
    replacementStarted: false;
    sourceCheckoutClean: true;
  };
  duplicateOperation: {
    pauseRunId: string;
    cancelRunId: string;
    pauseReplayConfirmed: true;
    cancelReplayConfirmed: true;
    changedActionRejected: "control-conflict";
    pauseState: "paused";
    cancelState: "cancelled";
  };
  modelCalls: 0;
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
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8", 0, Math.max(0, processOutputLimit - stdout.length));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8", 0, Math.max(0, processOutputLimit - stderr.length));
  });
  const completion = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function runTypeScript(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = processTimeoutMs,
): Promise<ProcessResult> {
  const running = spawnTypeScript(program, args, cwd);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      running.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          running.child.kill("SIGKILL");
          reject(new Error(`Process timed out: ${program}`));
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
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function parseProcessJson<T>(result: ProcessResult, expectedCode = 0): T {
  if (result.code !== expectedCode) {
    throw new Error(
      `Fixture process exited with ${result.code}: ${result.stderr || result.stdout}`,
    );
  }
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) {
    throw new Error("Fixture process produced no JSON result");
  }
  return JSON.parse(line) as T;
}

async function readPrivateJson<T>(
  root: PrivatePathRoot,
  segments: readonly string[],
): Promise<T | null> {
  try {
    return JSON.parse(
      (await root.readFile(segments, { maxBytes: privateRecordLimit })).toString("utf8"),
    ) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForReadyRun(
  state: PrivatePathRoot,
  store: SqliteDurableRunStore,
  runId: string,
): Promise<ReadyRun> {
  let ready: ReadyRun | undefined;
  await waitForCondition(
    `${runId} durable attempt readiness`,
    async () => {
      const [loaded, lease, probe] = await Promise.all([
        store.load(runId, "execution"),
        store.inspectLease(runId),
        readPrivateJson(state, ["acceptance-probes", runId, "attempt-1-ready.json"]),
      ]);
      const attempt = loaded?.state.nodes.implement?.attempts[0];
      if (
        !loaded ||
        !lease ||
        lease.released ||
        loaded.state.status !== "running" ||
        attempt?.status !== "running" ||
        !attempt.execution ||
        !attempt.workspaceCheckpoint ||
        !probe
      ) {
        return false;
      }
      ready = {
        lease,
        state: loaded.state,
        firstExecutionId: attempt.execution.executionId,
      };
      return true;
    },
    15_000,
  );
  if (!ready) {
    throw new Error("Durable readiness completed without run evidence");
  }
  return ready;
}

async function waitForTerminalRecord(
  state: PrivatePathRoot,
  runId: string,
  executionId: string,
): Promise<{ cleanup: string } & Record<string, unknown>> {
  let terminal: ({ cleanup: string } & Record<string, unknown>) | null = null;
  await waitForCondition(
    `${runId} parent-death cleanup`,
    async () => {
      terminal = await readPrivateJson(state, [
        "runs",
        runId,
        "executions",
        executionId,
        "terminal.json",
      ]);
      return terminal !== null;
    },
    15_000,
  );
  if (!terminal) {
    throw new Error("Execution terminal evidence disappeared");
  }
  return terminal;
}

async function processStatus(repository: string, runId: string): Promise<string> {
  const result = await runTypeScript(
    cliProgram,
    ["status", runId, "--state-dir", join(repository, ".anastom")],
    repository,
  );
  if (result.code !== 0 || result.stderr.trim()) {
    throw new Error(`Later-process status failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function processInspect(repository: string, runId: string): Promise<DurableRunInspection> {
  const result = await runTypeScript(
    cliProgram,
    ["inspect", runId, "--state-dir", join(repository, ".anastom"), "--json"],
    repository,
  );
  if (result.code !== 0 || result.stderr.trim()) {
    throw new Error(`Later-process inspection failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as DurableRunInspection;
}

async function runCoordinator(input: {
  action: string;
  repository: string;
  runId: string;
  scenario: CrashScenario;
  extra?: readonly string[];
}): Promise<ProcessResult> {
  return runTypeScript(
    coordinatorProgram,
    [input.action, input.repository, input.runId, input.scenario, ...(input.extra ?? [])],
    input.repository,
  );
}

async function sourceCheckoutClean(repository: string): Promise<boolean> {
  const { stdout } = await executeFile("git", ["status", "--porcelain"], { cwd: repository });
  return stdout.trim() === "";
}

async function runDuplicateOperationCase(): Promise<
  M3DurableExecutionEvidence["duplicateOperation"]
> {
  const repository = await createEndpointRepository();
  const pauseRunId = "m3-duplicate-pause";
  const cancelRunId = "m3-duplicate-cancel";
  try {
    await createBoundaryRun(repository, pauseRunId);
    const pause = await submitRepeatedControl(
      repository,
      pauseRunId,
      "pause",
      operationIds.duplicate,
    );
    const conflict = parseProcessJson<{ error: { code?: string } }>(
      await runCoordinator({
        action: "control",
        repository,
        runId: pauseRunId,
        scenario: "clean",
        extra: ["cancel", operationIds.duplicate],
      }),
      3,
    );
    const finalState = parseProcessJson<RunState>(
      await runCoordinator({
        action: "resume",
        repository,
        runId: pauseRunId,
        scenario: "clean",
        extra: ["55555555-5555-4555-8555-555555555555"],
      }),
    );
    await createBoundaryRun(repository, cancelRunId);
    const cancel = await submitRepeatedControl(
      repository,
      cancelRunId,
      "cancel",
      operationIds.duplicateCancel,
    );
    const cancelled = parseProcessJson<RunState>(
      await runCoordinator({
        action: "resume",
        repository,
        runId: cancelRunId,
        scenario: "clean",
        extra: ["77777777-7777-4777-8777-777777777777"],
      }),
    );
    if (
      !pause ||
      !cancel ||
      conflict.error.code !== "control-conflict" ||
      finalState.status !== "paused" ||
      cancelled.status !== "cancelled"
    ) {
      throw new Error("Cross-process duplicate control behavior changed");
    }
    return {
      pauseRunId,
      cancelRunId,
      pauseReplayConfirmed: true,
      cancelReplayConfirmed: true,
      changedActionRejected: "control-conflict",
      pauseState: "paused",
      cancelState: "cancelled",
    };
  } finally {
    await removeEndpointRepository(repository);
  }
}

async function createBoundaryRun(repository: string, runId: string): Promise<void> {
  const created = parseProcessJson<RunState>(
    await runCoordinator({ action: "create", repository, runId, scenario: "clean" }),
  );
  if (created.status !== "running") {
    throw new Error("Duplicate-operation fixture was not created at a scheduling boundary");
  }
}

async function submitRepeatedControl(
  repository: string,
  runId: string,
  action: "pause" | "cancel",
  operationId: string,
): Promise<boolean> {
  const invoke = () =>
    runCoordinator({
      action: "control",
      repository,
      runId,
      scenario: "clean",
      extra: [action, operationId],
    });
  const first = parseProcessJson<{ replayed: boolean }>(await invoke());
  const repeated = parseProcessJson<{ replayed: boolean }>(await invoke());
  return first.replayed === false && repeated.replayed === true;
}

/** Run the deterministic production-shaped M3 crash/restart acceptance suite. */
export async function runM3DurableExecutionAcceptance(): Promise<M3DurableExecutionEvidence> {
  const pending = [
    runRetainedCrashCase("clean"),
    runRetainedCrashCase("dirty"),
    runRetainedCrashCase("unknown"),
    runDuplicateOperationCase(),
  ] as const;
  let completed: Awaited<ReturnType<typeof Promise.all<typeof pending>>>;
  try {
    completed = await Promise.all(pending);
  } catch (error) {
    const settled = await Promise.allSettled(pending);
    await Promise.all(
      settled.map(async (result) => {
        if (result.status === "fulfilled" && "repository" in result.value) {
          await removeEndpointRepository(result.value.repository);
        }
      }),
    );
    throw error;
  }
  const [clean, dirty, unknown, duplicateOperation] = completed;
  try {
    return {
      version: "anastom.dev/m3-durable-execution-evidence/v1alpha1",
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cleanRecovery: await inspectCleanCase(clean),
      dirtyWorkspace: await inspectDirtyCase(dirty),
      unknownExecution: inspectUnknownCase(unknown),
      duplicateOperation,
      modelCalls: 0,
    };
  } finally {
    await Promise.all([
      removeEndpointRepository(clean.repository),
      removeEndpointRepository(dirty.repository),
      removeEndpointRepository(unknown.repository),
    ]);
  }
}

interface RetainedCrashCase extends CrashCaseEvidence {
  repository: string;
}

async function runRetainedCrashCase(scenario: CrashScenario): Promise<RetainedCrashCase> {
  const repository = await createEndpointRepository();
  const runId = `m3-${scenario}`;
  const state = await ensurePrivatePathRoot(join(repository, ".anastom"));
  const store = new SqliteDurableRunStore(join(state.path, "anastom.sqlite"));
  const running = spawnTypeScript(
    coordinatorProgram,
    ["start", repository, runId, scenario],
    repository,
  );
  let coordinatorExited = false;
  try {
    const ready = await waitForReadyRun(state, store, runId);
    if (running.child.pid === undefined) {
      throw new Error("Acceptance coordinator has no process ID");
    }
    if (ready.lease.owner.pid !== running.child.pid) {
      throw new Error("SIGKILL target does not match the recorded lease owner");
    }
    process.kill(running.child.pid, "SIGKILL");
    const killed = await running.completion;
    coordinatorExited = true;
    if (killed.signal !== "SIGKILL") {
      throw new Error(`Coordinator did not exit through SIGKILL: ${killed.stderr}`);
    }
    await waitForCondition(
      `${runId} coordinator absence`,
      async () => (await observeLocalProcess(ready.lease.owner)).state === "absent",
      5_000,
    );
    const statusBeforeExpiry = await processStatus(repository, runId);
    if (
      !statusBeforeExpiry.includes("[running]") ||
      !statusBeforeExpiry.includes("Ownership: unknown")
    ) {
      throw new Error(
        `Later-process status did not report the unexpired absent owner safely: ${JSON.stringify(statusBeforeExpiry)}`,
      );
    }
    const early = parseProcessJson<{ error: { reason?: string } }>(
      await runCoordinator({
        action: "resume",
        repository,
        runId,
        scenario,
        extra: [operationIds[scenario]],
      }),
      3,
    );
    if (early.error.reason !== "lease-active") {
      throw new Error("Replacement ownership was not refused before exact lease expiry");
    }
    const terminal = await waitForTerminalRecord(state, runId, ready.firstExecutionId);
    const cancellationProbeObserved =
      (await readPrivateJson(state, ["acceptance-probes", runId, "attempt-1-cancelled.json"])) !==
      null;
    if (scenario === "unknown") {
      await state.writeFileAtomic(
        ["runs", runId, "executions", ready.firstExecutionId, "terminal.json"],
        Buffer.from("{}"),
        { maxBytes: 2 },
      );
    }
    await waitForCondition(
      `${runId} lease expiry`,
      async () => Date.now() >= ready.lease.expiresAtMs,
      Math.max(5_000, ready.lease.expiresAtMs - Date.now() + 5_000),
    );
    const finalState = parseProcessJson<RunState>(
      await runCoordinator({
        action: "resume",
        repository,
        runId,
        scenario,
        extra: [operationIds[scenario]],
      }),
    );
    const loaded = await store.load(runId, "complete-history");
    const finalLease = await store.inspectLease(runId);
    if (!loaded || !finalLease) {
      throw new Error("Recovered run or lease is missing");
    }
    const replacementProbeObserved =
      (await readPrivateJson(state, ["acceptance-probes", runId, "attempt-2-completed.json"])) !==
      null;
    return {
      repository,
      runId,
      stateDir: state.path,
      statusBeforeExpiry,
      earlyTakeoverReason: early.error.reason,
      firstExecutionId: ready.firstExecutionId,
      initialLease: ready.lease,
      finalState,
      finalLease,
      events: loaded.events,
      terminalRecord: terminal,
      cancellationProbeObserved,
      parentDeathCleanupConfirmed: terminal.cleanup === "confirmed",
      replacementProbeObserved,
      sourceClean: await sourceCheckoutClean(repository),
    };
  } catch (error) {
    await removeEndpointRepository(repository);
    throw error;
  } finally {
    store.close();
    if (
      !coordinatorExited &&
      running.child.exitCode === null &&
      running.child.signalCode === null
    ) {
      running.child.kill("SIGKILL");
      await running.completion.catch(() => undefined);
    }
  }
}

function contiguous(events: readonly RunEvent[]): boolean {
  return events.every((event, index) => event.sequence === index + 1);
}

async function proveSnapshotRecovery(value: RetainedCrashCase): Promise<void> {
  const path = join(value.stateDir, "anastom.sqlite");
  const store = new SqliteDurableRunStore(path);
  let authoritative: RunState | undefined;
  try {
    const execution = await store.load(value.runId, "execution");
    const history = await store.load(value.runId, "complete-history");
    if (
      execution?.snapshotSource !== "snapshot-tail" ||
      !history ||
      !isDeepStrictEqual(execution.state, history.state)
    ) {
      throw new Error("Snapshot-plus-tail did not equal authoritative replay");
    }
    authoritative = history.state;
  } finally {
    store.close();
  }
  const database = new DatabaseSync(path);
  try {
    const changed = database
      .prepare("UPDATE run_snapshots SET state_digest=? WHERE run_id=?")
      .run(`sha256:${"0".repeat(64)}`, value.runId);
    if (changed.changes < 1) {
      throw new Error("Clean recovery produced no snapshots to corrupt");
    }
  } finally {
    database.close();
  }
  const reopened = new SqliteDurableRunStore(path);
  try {
    const fallback = await reopened.load(value.runId, "execution");
    if (
      fallback?.snapshotSource !== "full-replay" ||
      !authoritative ||
      !isDeepStrictEqual(fallback.state, authoritative)
    ) {
      throw new Error("Corrupt snapshots did not fall back to authoritative replay");
    }
  } finally {
    reopened.close();
  }
}

async function verifyArtifacts(
  inspection: DurableRunInspection,
  stateDir: string,
): Promise<number> {
  const artifacts = inspection.state.artifacts ?? [];
  const artifactStore = new FileArtifactStore(stateDir);
  const stateRoot = await ensurePrivatePathRoot(stateDir);
  for (const artifact of artifacts) {
    await readAuditedArtifact(artifactStore, stateRoot, artifact);
  }
  return artifacts.length;
}

async function readAuditedArtifact(
  artifactStore: FileArtifactStore,
  stateRoot: PrivatePathRoot,
  artifact: ArtifactRef,
): Promise<Buffer> {
  const bytes = await artifactStore.read(artifact);
  const privateBytes = await stateRoot.readFile(
    ["runs", artifact.producer.runId, "artifacts", artifact.id],
    { maxBytes: bytes.byteLength },
  );
  if (!privateBytes.equals(bytes)) {
    throw new Error("Private artifact bytes changed during the acceptance audit");
  }
  return bytes;
}

async function verifyRetainedWorkspace(inspection: DurableRunInspection): Promise<string> {
  const workspace = inspection.state.workspace;
  if (workspace?.mode !== "isolated") {
    throw new Error("Recovered run did not retain an isolated worktree");
  }
  const { stdout } = await executeFile("git", ["diff", "--name-only", workspace.baseCommit, "--"], {
    cwd: workspace.path,
  });
  if (stdout.trim() !== "server.mjs") {
    throw new Error("Retained worktree changed-file evidence failed");
  }
  return workspace.path;
}

function requireCleanProjection(
  inspection: DurableRunInspection,
  value: RetainedCrashCase,
): { events: RunEvent[]; replacementExecutionId: string } {
  const events = inspection.events;
  if (!events) {
    throw new Error("Clean recovery inspection omitted events");
  }
  const replacementExecutionId = requireCleanAttempts(inspection, value);
  requireCleanVerifier(inspection);
  const checks = {
    status: inspection.state.status === "succeeded",
    generation: value.finalLease.generation === 2,
    released: value.finalLease.released,
    cleanup: value.parentDeathCleanupConfirmed,
    replacementProbe: value.replacementProbeObserved,
    sourceClean: value.sourceClean,
    contiguous: contiguous(events),
  };
  if (Object.values(checks).includes(false)) {
    throw new Error(
      `Clean crash recovery evidence is incomplete: ${JSON.stringify({
        ...checks,
        recoveryBlock: inspection.state.recoveryBlock,
        terminal: value.terminalRecord,
        cancellationProbe: value.cancellationProbeObserved,
      })}`,
    );
  }
  return { events, replacementExecutionId };
}

function requireCleanAttempts(inspection: DurableRunInspection, value: RetainedCrashCase): string {
  const implement = inspection.state.nodes.implement;
  if (!implement) {
    throw new Error("Clean recovery omitted the implement node");
  }
  const first = implement.attempts[0];
  const replacement = implement.attempts[1];
  if (first?.status !== "orphaned" || replacement?.status !== "succeeded") {
    throw new Error(
      `Clean recovery attempt states are incomplete: ${JSON.stringify({
        first: first?.status,
        replacement: replacement?.status,
        recoveryBlock: inspection.state.recoveryBlock,
        terminal: value.terminalRecord,
        cancellationProbe: value.cancellationProbeObserved,
      })}`,
    );
  }
  if (!replacement.execution) {
    throw new Error("Clean recovery omitted the replacement execution identity");
  }
  return replacement.execution.executionId;
}

function requireCleanVerifier(inspection: DurableRunInspection): void {
  const verify = inspection.state.nodes.verify;
  if (verify?.status !== "succeeded" || verify.command?.passed !== true) {
    throw new Error("Clean recovery verifier did not pass");
  }
}

async function inspectCleanCase(
  value: RetainedCrashCase,
): Promise<M3DurableExecutionEvidence["cleanRecovery"]> {
  const inspection = await processInspect(value.repository, value.runId);
  const { events, replacementExecutionId } = requireCleanProjection(inspection, value);
  const repeatedResume = parseProcessJson<RunState>(
    await runCoordinator({
      action: "resume",
      repository: value.repository,
      runId: value.runId,
      scenario: "clean",
      extra: [operationIds.clean],
    }),
  );
  if (
    repeatedResume.status !== "succeeded" ||
    repeatedResume.sequence !== inspection.state.sequence
  ) {
    throw new Error("Repeated cross-process resume changed a terminal run");
  }
  const stale = parseProcessJson<{ error: { code?: string } }>(
    await runCoordinator({
      action: "stale-append",
      repository: value.repository,
      runId: value.runId,
      scenario: "clean",
      extra: [
        value.initialLease.ownerId,
        String(value.initialLease.generation),
        String(inspection.state.sequence),
      ],
    }),
    3,
  );
  if (stale.error.code !== "ownership-conflict") {
    throw new Error("The stale generation was not rejected");
  }
  await proveSnapshotRecovery(value);
  const artifactsVerified = await verifyArtifacts(inspection, value.stateDir);
  const retainedWorktree = await verifyRetainedWorkspace(inspection);
  const publicSentinelAbsent = !JSON.stringify(inspection).includes("PRIVATE_SENTINEL");
  if (!publicSentinelAbsent) {
    throw new Error("Public inspection exposed a private fixture sentinel");
  }
  return {
    runId: value.runId,
    firstExecutionId: value.firstExecutionId,
    replacementExecutionId,
    ownershipGenerations: [1, 2],
    orphanTransitions: events.filter((event) => event.type === "AttemptOrphaned").length,
    terminalState: "succeeded",
    verifierPassed: true,
    eventCount: events.length,
    eventSequencesContiguous: true,
    parentDeathCleanupConfirmed: true,
    statusBeforeExpiryOwnerState: "unknown",
    beforeExpiryTakeoverRefused: "lease-active",
    staleGenerationAppendRejected: "ownership-conflict",
    repeatedResumeUnchanged: true,
    snapshotTailEqualsFullReplay: true,
    corruptSnapshotFallsBackToFullReplay: true,
    artifactsVerified,
    publicSentinelAbsent: true,
    sourceCheckoutClean: true,
    retainedWorktree,
    changedFiles: ["server.mjs"],
  };
}

async function inspectDirtyCase(
  value: RetainedCrashCase,
): Promise<M3DurableExecutionEvidence["dirtyWorkspace"]> {
  const implement = value.finalState.nodes.implement;
  const differences = implement?.attempts[0]?.orphan?.workspaceDifferences ?? [];
  const diffArtifact = value.finalState.artifacts?.find(
    (artifact) =>
      artifact.id === implement?.attempts[0]?.orphan?.workspaceObservation.diffArtifactId,
  );
  if (
    value.finalState.status !== "paused" ||
    value.finalState.pauseReason?.kind !== "workspace-conflict" ||
    implement?.attempts.length !== 1 ||
    implement.attempts[0]?.status !== "orphaned" ||
    value.replacementProbeObserved ||
    !value.sourceClean ||
    !value.parentDeathCleanupConfirmed ||
    !differences.includes("diff-digest") ||
    !differences.includes("changed-files") ||
    !diffArtifact
  ) {
    throw new Error("Dirty-workspace refusal evidence is incomplete");
  }
  const diffBytes = await readAuditedArtifact(
    new FileArtifactStore(value.stateDir),
    await ensurePrivatePathRoot(value.stateDir),
    diffArtifact,
  );
  return {
    runId: value.runId,
    terminalState: "paused",
    differences,
    orphanTransitions: value.events.filter((event) => event.type === "AttemptOrphaned").length,
    replacementStarted: false,
    retainedDiffBytes: diffBytes.byteLength,
    sourceCheckoutClean: true,
  };
}

function inspectUnknownCase(
  value: RetainedCrashCase,
): M3DurableExecutionEvidence["unknownExecution"] {
  const implement = value.finalState.nodes.implement;
  if (
    value.finalState.status !== "recovery-blocked" ||
    value.finalState.recoveryBlock?.reason.kind !== "execution-unknown" ||
    value.finalState.recoveryBlock.reason.detail !== "invalid-record" ||
    implement?.attempts.length !== 1 ||
    value.replacementProbeObserved ||
    !value.sourceClean ||
    !value.parentDeathCleanupConfirmed
  ) {
    throw new Error("Unknown-execution refusal evidence is incomplete");
  }
  return {
    runId: value.runId,
    terminalState: "recovery-blocked",
    reason: "invalid-record",
    replacementStarted: false,
    sourceCheckoutClean: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await runM3DurableExecutionAcceptance(), null, 2) + "\n");
}
