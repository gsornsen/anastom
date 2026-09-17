import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  M3_SUPERVISOR_MAX_FRAME_BYTES,
  M3_SUPERVISOR_SOCKET,
  M3_SUPERVISOR_VERSION,
  assertM3AttemptPlan,
  inspectPersistedM3Execution,
  readM3Frame,
  readM3ExecutionControl,
  readM3ExecutionManifest,
  requestM3Supervisor,
  type M3AttemptPlan,
  type M3ExecutionManifest,
  type M3ExecutionTerminal,
  type M3SupervisorOwner,
  type M3SupervisorScenario,
} from "./m3-supervisor-protocol.js";
import {
  liveGroupMembers,
  matchesLiveProcess,
  terminateObservedGroup,
  terminateObservedProcess,
  waitForCondition,
  type ProcessIdentity,
} from "./m3-process-identity.js";
import { readM3Record, writeM3Record } from "./testing/m3-records.js";

const owners = ["pi", "codex", "claude-code", "command"] as const;

interface CoordinatorRecord {
  coordinator: ProcessIdentity;
  executionId: string;
  fence: number;
  owner: M3SupervisorOwner;
  scenario: M3SupervisorScenario;
  supervisor: ProcessIdentity;
  sideEffectBeforeAuthorization: boolean;
}

interface ExecutionProbe {
  leader: ProcessIdentity;
  descendant: ProcessIdentity;
}

interface CoordinatorFixture {
  root: string;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<unknown>;
  diagnostics: () => string;
}

/** Model-free evidence from the production-shaped supervisor protocol probe. */
export interface M3SupervisorProtocolEvidence {
  version: "anastom.dev/m3-supervisor-protocol-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  success: Array<{
    owner: M3SupervisorOwner;
    noSideEffectBeforeAuthorization: boolean;
    publicResultRelayed: boolean;
    publicEventsBounded: boolean;
    laterInspectionAbsent: boolean;
  }>;
  cancellation: Array<{
    owner: M3SupervisorOwner;
    authenticatedInspectionActive: boolean;
    wrongCapabilityRejected: boolean;
    wrongFenceRejected: boolean;
    tamperedPersistedControlUnknown: boolean;
    oversizedFrameRejected: boolean;
    stalledConnectionClosedOnRelease: boolean;
    cleanupConfirmed: boolean;
    allObservedProcessesAbsent: boolean;
  }>;
  parentDeath: Array<{
    owner: M3SupervisorOwner;
    cleanupConfirmed: boolean;
    supervisorAbsent: boolean;
    allObservedProcessesAbsent: boolean;
    laterInspectionAbsent: boolean;
  }>;
  supervisorLoss: {
    activeExecutionRemained: boolean;
    laterInspectionUnknown: boolean;
    replacementStartPermitted: boolean;
    fixtureCleanupConfirmed: boolean;
  };
  startWindowCrash: {
    startingStatePersisted: boolean;
    noSideEffectObserved: boolean;
    laterInspectionUnknown: boolean;
    replacementStartPermitted: boolean;
    supervisorAbsent: boolean;
  };
  conclusion: {
    twoPhaseAuthorization: "feasible";
    boundedAuthenticatedIpc: "feasible";
    sharedOwnerProtocol: "feasible-on-observed-platform";
    supervisorLoss: "fail-closed-unknown";
    publicRuntimeApiFrozen: false;
  };
}

function testingProgram(name: string): string {
  return fileURLToPath(new URL(`./testing/${name}`, import.meta.url));
}

function repositoryProgram(name: string): string {
  return fileURLToPath(new URL(`../${name}`, import.meta.url));
}

async function startCoordinator(
  owner: M3SupervisorOwner,
  scenario: M3SupervisorScenario,
): Promise<CoordinatorFixture> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m3-protocol-"));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      "--tsconfig",
      repositoryProgram("tsconfig.json"),
      testingProgram("m3-protocol-coordinator.ts"),
      owner,
      scenario,
    ],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 65_536) {
      stderr += chunk.toString("utf8", 0, Math.max(0, 65_536 - stderr.length));
    }
  });
  return { root, child, exited, diagnostics: () => stderr.trim() };
}

async function waitForCoordinator(fixture: CoordinatorFixture): Promise<CoordinatorRecord> {
  let record: CoordinatorRecord | null = null;
  try {
    await waitForCondition(
      "protocol coordinator readiness",
      async () => {
        record = await readM3Record<CoordinatorRecord>(fixture.root, "protocol-coordinator.json");
        if (
          record === null &&
          (fixture.child.exitCode !== null || fixture.child.signalCode !== null)
        ) {
          throw new Error("Protocol coordinator exited before readiness");
        }
        return record !== null;
      },
      15_000,
    );
  } catch (error) {
    throw new Error(
      `Protocol coordinator did not become ready: ${fixture.diagnostics() || "no diagnostic"}`,
      { cause: error },
    );
  }
  if (record === null) {
    throw new Error("Protocol coordinator record is missing after readiness");
  }
  return record;
}

async function waitForCoordinatorExit(fixture: CoordinatorFixture): Promise<void> {
  await waitForCondition(
    "protocol coordinator exit",
    async () => fixture.child.exitCode !== null || fixture.child.signalCode !== null,
    10_000,
  );
  await fixture.exited;
}

async function waitForTerminal(root: string): Promise<M3ExecutionTerminal> {
  let terminal: M3ExecutionTerminal | null = null;
  await waitForCondition(
    "supervisor terminal record",
    async () => {
      terminal = await readM3Record<M3ExecutionTerminal>(root, "execution-terminal.json");
      return terminal !== null;
    },
    15_000,
  );
  if (terminal === null) {
    throw new Error("Supervisor terminal record is missing after readiness");
  }
  return terminal;
}

async function stopCoordinator(
  fixture: CoordinatorFixture,
  observed?: ProcessIdentity,
): Promise<void> {
  if (observed && (await matchesLiveProcess(observed))) {
    try {
      await terminateObservedProcess(observed);
    } catch (error) {
      if (await matchesLiveProcess(observed)) {
        throw error;
      }
    }
  }
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    if (observed) {
      await waitForCoordinatorExit(fixture);
    } else if (fixture.child.pid !== undefined) {
      try {
        process.kill(fixture.child.pid, "SIGKILL");
      } catch {
        // The TypeScript launcher may already have exited after a setup failure.
      }
    }
  }
}

async function observedProcessesAbsent(root: string): Promise<boolean> {
  const probe = await readM3Record<ExecutionProbe>(root, "execution-probe.json");
  return (
    probe !== null &&
    !(await matchesLiveProcess(probe.leader)) &&
    !(await matchesLiveProcess(probe.descendant)) &&
    (await liveGroupMembers(probe.leader.processGroupId)).length === 0
  );
}

async function cleanupObservedExecution(root: string): Promise<void> {
  const probe = await readM3Record<ExecutionProbe>(root, "execution-probe.json");
  if (!probe) {
    return;
  }
  if (await matchesLiveProcess(probe.leader)) {
    await terminateObservedGroup(probe.leader);
  }
  if (await matchesLiveProcess(probe.descendant)) {
    await terminateObservedProcess(probe.descendant);
  }
}

async function cleanupFixture(
  fixture: CoordinatorFixture,
  record?: CoordinatorRecord,
  coordinator = record?.coordinator,
): Promise<void> {
  try {
    const manifest = await readM3Record<M3ExecutionManifest>(
      fixture.root,
      "execution-manifest.json",
    );
    if (manifest && (await matchesLiveProcess(manifest.supervisor))) {
      try {
        const control = await readM3ExecutionControl(fixture.root);
        if (manifest.state === "active") {
          await requestM3Supervisor(fixture.root, {
            version: M3_SUPERVISOR_VERSION,
            operation: "cancel",
            executionId: manifest.executionId,
            fence: manifest.fence,
            capability: control.capability,
          });
        }
        const current = await readM3ExecutionManifest(fixture.root);
        if (current.state === "terminal") {
          await requestM3Supervisor(fixture.root, {
            version: M3_SUPERVISOR_VERSION,
            operation: "release",
            executionId: current.executionId,
            fence: current.fence,
            capability: control.capability,
          });
          await waitForCondition(
            "cleanup supervisor exit",
            async () => !(await matchesLiveProcess(manifest.supervisor)),
          );
        }
      } catch {
        if (await matchesLiveProcess(manifest.supervisor)) {
          await terminateObservedProcess(manifest.supervisor);
        }
      }
    }
    await stopCoordinator(fixture, coordinator);
    if (manifest && (await matchesLiveProcess(manifest.supervisor))) {
      try {
        await waitForCondition(
          "cleanup supervisor exit after coordinator stop",
          async () => !(await matchesLiveProcess(manifest.supervisor)),
          15_000,
        );
      } catch (error) {
        if (await matchesLiveProcess(manifest.supervisor)) {
          await terminateObservedProcess(manifest.supervisor);
        } else {
          throw error;
        }
      }
    }
    await cleanupObservedExecution(fixture.root);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function sendOversizedFrame(root: string): Promise<boolean> {
  const socket = createConnection(join(root, M3_SUPERVISOR_SOCKET));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveConnection, reject) => {
      socket.once("connect", resolveConnection);
      socket.once("error", reject);
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(M3_SUPERVISOR_MAX_FRAME_BYTES + 1);
    const response = await Promise.race([
      (async () => {
        const framedResponse = readM3Frame(socket);
        socket.end(header);
        return framedResponse;
      })(),
      new Promise<never>(
        (_resolve, reject) =>
          void (timer = setTimeout(
            () => reject(new Error("Oversized frame connection stayed open")),
            5_000,
          )),
      ),
    ]);
    return (
      response !== null &&
      typeof response === "object" &&
      "ok" in response &&
      response.ok === false &&
      "category" in response &&
      response.category === "invalid-request"
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    socket.destroy();
  }
}

async function openStalledConnection(root: string): Promise<Socket> {
  const socket = createConnection(join(root, M3_SUPERVISOR_SOCKET));
  await new Promise<void>((resolveConnection, reject) => {
    socket.once("connect", resolveConnection);
    socket.once("error", reject);
  });
  return socket;
}

async function observeSuccess(owner: M3SupervisorOwner) {
  const fixture = await startCoordinator(owner, "success");
  let record: CoordinatorRecord | undefined;
  try {
    record = await waitForCoordinator(fixture);
    await waitForCoordinatorExit(fixture);
    const terminal = await waitForTerminal(fixture.root);
    const inspection = await inspectPersistedM3Execution(fixture.root);
    const serialized = JSON.stringify(terminal);
    return {
      owner,
      noSideEffectBeforeAuthorization: !record.sideEffectBeforeAuthorization,
      publicResultRelayed: terminal.result.status === "succeeded",
      publicEventsBounded:
        terminal.events.length > 0 &&
        terminal.events.length <= 256 &&
        terminal.events[0]?.type === "started" &&
        terminal.events.at(-1)?.type === "completed" &&
        !serialized.includes("PRIVATE_SENTINEL"),
      laterInspectionAbsent: inspection.state === "absent",
    };
  } finally {
    await cleanupFixture(fixture, record);
  }
}

async function observeCancellation(owner: M3SupervisorOwner) {
  const fixture = await startCoordinator(owner, "hold");
  let record: CoordinatorRecord | undefined;
  let stalledSocket: Socket | undefined;
  try {
    record = await waitForCoordinator(fixture);
    const [manifest, control] = await Promise.all([
      readM3ExecutionManifest(fixture.root),
      readM3ExecutionControl(fixture.root),
    ]);
    const initial = await inspectPersistedM3Execution(fixture.root);
    const wrongCapability = await requestM3Supervisor(fixture.root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "inspect",
      executionId: manifest.executionId,
      fence: manifest.fence,
      capability: control.capability === "A".repeat(43) ? "B".repeat(43) : "A".repeat(43),
    });
    const wrongFence = await requestM3Supervisor(fixture.root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "inspect",
      executionId: manifest.executionId,
      fence: manifest.fence + 1,
      capability: control.capability,
    });
    const alternateCapability =
      control.capability === "A".repeat(43) ? "B".repeat(43) : "A".repeat(43);
    await writeM3Record(fixture.root, "execution-control.json", {
      ...control,
      capability: alternateCapability,
    });
    const tamperedInspection = await inspectPersistedM3Execution(fixture.root);
    await writeM3Record(fixture.root, "execution-control.json", control);
    const oversizedFrameRejected = await sendOversizedFrame(fixture.root);
    stalledSocket = await openStalledConnection(fixture.root);
    const cancelled = await requestM3Supervisor(fixture.root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "cancel",
      executionId: manifest.executionId,
      fence: manifest.fence,
      capability: control.capability,
    });
    const released = await requestM3Supervisor(fixture.root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "release",
      executionId: manifest.executionId,
      fence: manifest.fence,
      capability: control.capability,
    });
    if (!released.ok) {
      throw new Error("Cancelled supervisor did not release");
    }
    await waitForCondition(
      "cancelled supervisor exit",
      async () => !(await matchesLiveProcess(record?.supervisor as ProcessIdentity)),
    );
    await waitForCondition(
      "stalled supervisor connection to close on release",
      async () => stalledSocket?.destroyed === true,
    );
    await stopCoordinator(fixture, record.coordinator);
    return {
      owner,
      authenticatedInspectionActive: initial.state === "active",
      wrongCapabilityRejected: !wrongCapability.ok && wrongCapability.category === "unauthorized",
      wrongFenceRejected: !wrongFence.ok && wrongFence.category === "unauthorized",
      tamperedPersistedControlUnknown: tamperedInspection.state === "unknown",
      oversizedFrameRejected,
      stalledConnectionClosedOnRelease: stalledSocket.destroyed,
      cleanupConfirmed:
        cancelled.ok &&
        cancelled.terminal?.cleanup === "confirmed" &&
        cancelled.terminal.result.status === "cancelled",
      allObservedProcessesAbsent: await observedProcessesAbsent(fixture.root),
    };
  } finally {
    stalledSocket?.destroy();
    await cleanupFixture(fixture, record);
  }
}

async function observeParentDeath(owner: M3SupervisorOwner) {
  const fixture = await startCoordinator(owner, "hold");
  let record: CoordinatorRecord | undefined;
  try {
    record = await waitForCoordinator(fixture);
    await stopCoordinator(fixture, record.coordinator);
    const terminal = await waitForTerminal(fixture.root);
    await waitForCondition(
      "parent-death supervisor exit",
      async () => !(await matchesLiveProcess(record?.supervisor as ProcessIdentity)),
      15_000,
    );
    const inspection = await inspectPersistedM3Execution(fixture.root);
    return {
      owner,
      cleanupConfirmed: terminal.cleanup === "confirmed" && terminal.result.status === "cancelled",
      supervisorAbsent: !(await matchesLiveProcess(record.supervisor)),
      allObservedProcessesAbsent: await observedProcessesAbsent(fixture.root),
      laterInspectionAbsent: inspection.state === "absent",
    };
  } finally {
    await cleanupFixture(fixture, record);
  }
}

async function observeSupervisorLoss(): Promise<M3SupervisorProtocolEvidence["supervisorLoss"]> {
  const fixture = await startCoordinator("command", "hold");
  let record: CoordinatorRecord | undefined;
  try {
    record = await waitForCoordinator(fixture);
    const probe = await readM3Record<ExecutionProbe>(fixture.root, "execution-probe.json");
    if (!probe) {
      throw new Error("Supervisor-loss execution probe is missing");
    }
    await terminateObservedProcess(record.supervisor);
    const activeExecutionRemained =
      (await matchesLiveProcess(probe.leader)) && (await matchesLiveProcess(probe.descendant));
    const inspection = await inspectPersistedM3Execution(fixture.root);
    await stopCoordinator(fixture, record.coordinator);
    await cleanupObservedExecution(fixture.root);
    const fixtureCleanupConfirmed = await observedProcessesAbsent(fixture.root);
    return {
      activeExecutionRemained,
      laterInspectionUnknown: inspection.state === "unknown",
      replacementStartPermitted: inspection.state === "absent",
      fixtureCleanupConfirmed,
    };
  } finally {
    await cleanupFixture(fixture, record);
  }
}

async function observeStartWindowCrash(): Promise<
  M3SupervisorProtocolEvidence["startWindowCrash"]
> {
  const fixture = await startCoordinator("command", "start-gated");
  let coordinator: ProcessIdentity | undefined;
  let manifest: M3ExecutionManifest | undefined;
  try {
    await waitForCondition(
      "persisted starting state",
      async () => {
        const rawPlan = await readM3Record<unknown>(fixture.root, "attempt-plan.json");
        if (rawPlan !== null) {
          assertM3AttemptPlan(rawPlan);
          const plan: M3AttemptPlan = rawPlan;
          coordinator = plan.coordinator;
        }
        const candidate = await readM3Record<M3ExecutionManifest>(
          fixture.root,
          "execution-manifest.json",
        );
        if (candidate?.state === "starting") {
          manifest = candidate;
          return true;
        }
        if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
          throw new Error("Start-window coordinator exited before the starting state");
        }
        return false;
      },
      15_000,
    );
    if (!manifest || !coordinator) {
      throw new Error("Start-window records are missing after readiness");
    }
    const noSideEffectObserved = (await readM3Record(fixture.root, "side-effect.json")) === null;
    await terminateObservedProcess(manifest.supervisor);
    const inspection = await inspectPersistedM3Execution(fixture.root);
    await waitForCoordinatorExit(fixture);
    return {
      startingStatePersisted: manifest.state === "starting",
      noSideEffectObserved,
      laterInspectionUnknown: inspection.state === "unknown",
      replacementStartPermitted: inspection.state === "absent",
      supervisorAbsent: !(await matchesLiveProcess(manifest.supervisor)),
    };
  } finally {
    await cleanupFixture(fixture, undefined, coordinator);
  }
}

function assertEvidence(evidence: M3SupervisorProtocolEvidence): void {
  for (const result of [...evidence.success, ...evidence.cancellation, ...evidence.parentDeath]) {
    if (Object.entries(result).some(([key, value]) => key !== "owner" && value !== true)) {
      throw new Error(`M3 supervisor protocol failed for ${result.owner}`);
    }
  }
  if (
    !evidence.supervisorLoss.activeExecutionRemained ||
    !evidence.supervisorLoss.laterInspectionUnknown ||
    evidence.supervisorLoss.replacementStartPermitted ||
    !evidence.supervisorLoss.fixtureCleanupConfirmed
  ) {
    throw new Error("M3 supervisor-loss boundary did not fail closed");
  }
  if (
    !evidence.startWindowCrash.startingStatePersisted ||
    !evidence.startWindowCrash.noSideEffectObserved ||
    !evidence.startWindowCrash.laterInspectionUnknown ||
    evidence.startWindowCrash.replacementStartPermitted ||
    !evidence.startWindowCrash.supervisorAbsent
  ) {
    throw new Error("M3 supervisor start-window boundary did not fail closed");
  }
}

/** Run the production-shaped M3 supervisor protocol feasibility matrix. */
export async function runM3SupervisorProtocolProbe(): Promise<M3SupervisorProtocolEvidence> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`M3 supervisor protocol probe does not support ${process.platform}`);
  }
  const success = [];
  const cancellation = [];
  const parentDeath = [];
  for (const owner of owners) {
    success.push(await observeSuccess(owner));
    cancellation.push(await observeCancellation(owner));
    parentDeath.push(await observeParentDeath(owner));
  }
  const evidence: M3SupervisorProtocolEvidence = {
    version: "anastom.dev/m3-supervisor-protocol-evidence/v1alpha1",
    platform: process.platform,
    architecture: process.arch,
    success,
    cancellation,
    parentDeath,
    supervisorLoss: await observeSupervisorLoss(),
    startWindowCrash: await observeStartWindowCrash(),
    conclusion: {
      twoPhaseAuthorization: "feasible",
      boundedAuthenticatedIpc: "feasible",
      sharedOwnerProtocol: "feasible-on-observed-platform",
      supervisorLoss: "fail-closed-unknown",
      publicRuntimeApiFrozen: false,
    },
  };
  assertEvidence(evidence);
  return evidence;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await runM3SupervisorProtocolProbe(), null, 2)}\n`);
}
