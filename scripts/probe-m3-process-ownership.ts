import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  inspectProcess,
  isLiveProcess,
  liveGroupMembers,
  localBootIdentityDigest,
  matchesLiveProcess,
  terminateObservedGroup,
  terminateObservedProcess,
  waitForCondition,
  type ProcessIdentity,
} from "./m3-process-identity.js";

const owners = ["pi", "codex", "claude-code", "command"] as const;
type Owner = (typeof owners)[number];

interface RuntimeRecord {
  owner: Owner | "supervised";
  coordinator: ProcessIdentity;
  execution: ProcessIdentity;
  descendant: ProcessIdentity;
  fixtureRoot: string;
  handleId?: string;
  supervisor?: ProcessIdentity;
}

interface WorkerRecord {
  leaderPid: number;
  descendantPid: number;
}

export interface CurrentOwnerObservation {
  owner: Owner;
  coordinatorAbsentAfterCrash: boolean;
  executionLeaderAliveAfterCrash: boolean;
  descendantAliveAfterCrash: boolean;
  executionGroupAliveAfterCrash: boolean;
  productPersistedExecutionReference: false;
  engineGeneratedExecutionIdBeforeSideEffects: false;
  laterCleanupWithFixtureLeaderIdentity: boolean;
  allObservedProcessesAbsentAfterCleanup: boolean;
}

export interface M3ProcessOwnershipEvidence {
  version: "anastom.dev/m3-process-ownership-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  node: string;
  bootIdentityDigest: string;
  currentOwners: CurrentOwnerObservation[];
  exitedLeader: {
    leaderAbsent: boolean;
    descendantAlive: boolean;
    groupStillAlive: boolean;
    leaderIdentityCanAuthorizeCleanup: boolean;
  };
  parentDeathSupervisor: {
    coordinatorAbsent: boolean;
    supervisorObservedParentDeath: boolean;
    supervisorAbsentAfterCleanup: boolean;
    executionAbsentAfterCleanup: boolean;
    descendantAbsentAfterCleanup: boolean;
  };
  conclusion: {
    persistCurrentHandleOnly: "rejected";
    persistLeaderPidOnly: "rejected";
    sharedParentDeathSupervisor: "feasible-on-observed-platform";
    piRequiresOutOfProcessAttemptOwnership: true;
  };
}

function testingProgram(name: string): string {
  return fileURLToPath(new URL(`./testing/${name}`, import.meta.url));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function startCoordinator(
  owner: Owner | "supervised",
  root: string,
): {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<unknown>;
  diagnostics: () => string;
} {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      testingProgram("m3-runtime-coordinator.ts"),
      owner,
      root,
    ],
    {
      detached: true,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 65_536) {
      stderr += chunk.toString("utf8", 0, Math.max(0, 65_536 - stderr.length));
    }
  });
  return { child, exited: once(child, "exit"), diagnostics: () => stderr.trim() };
}

async function waitForRecord(root: string, diagnostics: () => string): Promise<RuntimeRecord> {
  let record: RuntimeRecord | null = null;
  try {
    await waitForCondition(
      "runtime coordinator record",
      async () => {
        record = await readJson<RuntimeRecord>(join(root, "record.json"));
        return record !== null;
      },
      10_000,
    );
  } catch (error) {
    throw new Error(
      `Runtime coordinator did not become ready: ${diagnostics() || "no diagnostic"}`,
      {
        cause: error,
      },
    );
  }
  if (record === null) {
    throw new Error("Runtime coordinator record is missing after readiness");
  }
  return record;
}

async function killCoordinator(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<unknown>,
  coordinator: ProcessIdentity,
): Promise<void> {
  await terminateObservedProcess(coordinator);
  await exited;
}

async function cleanDirectories(...directories: string[]): Promise<void> {
  for (const directory of new Set(directories.map((value) => resolve(value)))) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function observeCurrentOwner(owner: Owner): Promise<CurrentOwnerObservation> {
  const root = await mkdtemp(join(tmpdir(), `anastom-m3-${owner}-`));
  const { child, exited, diagnostics } = startCoordinator(owner, root);
  let record: RuntimeRecord | undefined;
  try {
    record = await waitForRecord(root, diagnostics);
    if (!(await matchesLiveProcess(record.coordinator))) {
      throw new Error(`${owner} coordinator identity was not live before the crash`);
    }
    await killCoordinator(child, exited, record.coordinator);
    const coordinatorAbsentAfterCrash = !(await matchesLiveProcess(record.coordinator));
    const executionLeaderAliveAfterCrash = await matchesLiveProcess(record.execution);
    const descendantAliveAfterCrash = await matchesLiveProcess(record.descendant);
    const executionGroupAliveAfterCrash =
      (await liveGroupMembers(record.execution.processGroupId)).length > 0;
    let laterCleanupWithFixtureLeaderIdentity = false;
    if (owner === "pi") {
      await terminateObservedProcess(record.descendant);
    } else {
      laterCleanupWithFixtureLeaderIdentity = true;
      await terminateObservedGroup(record.execution);
    }
    const allObservedProcessesAbsentAfterCleanup =
      !(await matchesLiveProcess(record.coordinator)) &&
      !(await matchesLiveProcess(record.execution)) &&
      !(await matchesLiveProcess(record.descendant)) &&
      (await liveGroupMembers(record.execution.processGroupId)).length === 0;
    return {
      owner,
      coordinatorAbsentAfterCrash,
      executionLeaderAliveAfterCrash,
      descendantAliveAfterCrash,
      executionGroupAliveAfterCrash,
      productPersistedExecutionReference: false,
      engineGeneratedExecutionIdBeforeSideEffects: false,
      laterCleanupWithFixtureLeaderIdentity,
      allObservedProcessesAbsentAfterCleanup,
    };
  } finally {
    if (record && (await matchesLiveProcess(record.coordinator))) {
      await terminateObservedProcess(record.coordinator);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // The coordinator may already have exited after a setup failure.
      }
    }
    if (record && owner !== "pi" && (await matchesLiveProcess(record.execution))) {
      await terminateObservedGroup(record.execution);
    }
    if (record && (await matchesLiveProcess(record.descendant))) {
      await terminateObservedProcess(record.descendant);
    }
    await cleanDirectories(root, record?.fixtureRoot ?? root);
  }
}

async function observeExitedLeader(): Promise<M3ProcessOwnershipEvidence["exitedLeader"]> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m3-exited-leader-"));
  const child = spawn(
    process.execPath,
    [testingProgram("m3-attempt-worker.mjs"), root, "exit-leader"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  const exited = once(child, "exit");
  let leader: ProcessIdentity | undefined;
  let descendant: ProcessIdentity | undefined;
  try {
    await waitForCondition(
      "exiting group leader readiness",
      async () => (await readJson<WorkerRecord>(join(root, "worker.json"))) !== null,
    );
    const worker = await readJson<WorkerRecord>(join(root, "worker.json"));
    if (worker === null) {
      throw new Error("Exiting group leader record is missing");
    }
    const leaderIdentity = await inspectProcess(worker.leaderPid);
    const descendantIdentity = await inspectProcess(worker.descendantPid);
    if (!isLiveProcess(leaderIdentity) || !isLiveProcess(descendantIdentity)) {
      throw new Error("Exiting leader identities could not be established");
    }
    leader = leaderIdentity;
    descendant = descendantIdentity;
    await writeFile(join(root, "release-leader"), "release", { mode: 0o600 });
    await exited;
    const leaderAbsent = !(await matchesLiveProcess(leader));
    const descendantAlive = await matchesLiveProcess(descendant);
    const groupStillAlive = (await liveGroupMembers(leader.processGroupId)).length > 0;
    let leaderIdentityCanAuthorizeCleanup = true;
    try {
      await terminateObservedGroup(leader);
    } catch {
      leaderIdentityCanAuthorizeCleanup = false;
    }
    await terminateObservedProcess(descendant);
    return { leaderAbsent, descendantAlive, groupStillAlive, leaderIdentityCanAuthorizeCleanup };
  } finally {
    if (leader && (await matchesLiveProcess(leader))) {
      await terminateObservedGroup(leader);
    }
    if (descendant && (await matchesLiveProcess(descendant))) {
      await terminateObservedProcess(descendant);
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function observeSupervisor(): Promise<M3ProcessOwnershipEvidence["parentDeathSupervisor"]> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m3-supervised-"));
  const { child, exited, diagnostics } = startCoordinator("supervised", root);
  let record: RuntimeRecord | undefined;
  try {
    record = await waitForRecord(root, diagnostics);
    if (!record.supervisor) {
      throw new Error("Supervisor identity is missing");
    }
    await killCoordinator(child, exited, record.coordinator);
    try {
      await waitForCondition(
        "parent-death supervisor cleanup",
        async () =>
          (await readJson<{ outcome: string }>(join(root, "supervisor-cleaned.json"))) !== null,
      );
    } catch (error) {
      throw new Error(
        `Supervisor cleanup missing; coordinator=${JSON.stringify(await inspectProcess(record.coordinator.pid))} supervisor=${JSON.stringify(await inspectProcess(record.supervisor.pid))} execution=${JSON.stringify(await inspectProcess(record.execution.pid))}`,
        { cause: error },
      );
    }
    const cleanup = await readJson<{ outcome: string }>(join(root, "supervisor-cleaned.json"));
    await waitForCondition(
      "parent-death supervisor exit",
      async () => !(await matchesLiveProcess(record?.supervisor as ProcessIdentity)),
    );
    return {
      coordinatorAbsent: !(await matchesLiveProcess(record.coordinator)),
      supervisorObservedParentDeath: cleanup?.outcome === "terminated",
      supervisorAbsentAfterCleanup: !(await matchesLiveProcess(record.supervisor)),
      executionAbsentAfterCleanup: !(await matchesLiveProcess(record.execution)),
      descendantAbsentAfterCleanup: !(await matchesLiveProcess(record.descendant)),
    };
  } finally {
    if (record && (await matchesLiveProcess(record.coordinator))) {
      await terminateObservedProcess(record.coordinator);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // The coordinator may already have exited after a setup failure.
      }
    }
    if (record?.supervisor && (await matchesLiveProcess(record.supervisor))) {
      await terminateObservedProcess(record.supervisor);
    }
    if (record?.execution && (await matchesLiveProcess(record.execution))) {
      await terminateObservedGroup(record.execution);
    }
    if (record?.descendant && (await matchesLiveProcess(record.descendant))) {
      await terminateObservedProcess(record.descendant);
    }
    await rm(root, { recursive: true, force: true });
  }
}

function assertEvidence(evidence: M3ProcessOwnershipEvidence): void {
  for (const owner of evidence.currentOwners) {
    if (
      !owner.coordinatorAbsentAfterCrash ||
      !owner.descendantAliveAfterCrash ||
      !owner.executionGroupAliveAfterCrash ||
      !owner.allObservedProcessesAbsentAfterCleanup
    ) {
      throw new Error(`Unexpected ${owner.owner} process-ownership observation`);
    }
    if (owner.owner === "pi" && owner.executionLeaderAliveAfterCrash) {
      throw new Error("Pi's in-process execution leader should die with the coordinator");
    }
    if (owner.owner !== "pi" && !owner.executionLeaderAliveAfterCrash) {
      throw new Error(`${owner.owner} process leader should survive the coordinator crash`);
    }
  }
  if (
    !evidence.exitedLeader.leaderAbsent ||
    !evidence.exitedLeader.descendantAlive ||
    !evidence.exitedLeader.groupStillAlive ||
    evidence.exitedLeader.leaderIdentityCanAuthorizeCleanup
  ) {
    throw new Error("Exited-leader ownership boundary was not reproduced");
  }
  if (Object.values(evidence.parentDeathSupervisor).some((value) => !value)) {
    throw new Error("Parent-death supervisor did not establish bounded cleanup");
  }
}

export async function runM3ProcessOwnershipProbe(): Promise<M3ProcessOwnershipEvidence> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`M3 process-ownership probe does not support ${process.platform}`);
  }
  const currentOwners: CurrentOwnerObservation[] = [];
  for (const owner of owners) {
    currentOwners.push(await observeCurrentOwner(owner));
  }
  const evidence: M3ProcessOwnershipEvidence = {
    version: "anastom.dev/m3-process-ownership-evidence/v1alpha1",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    bootIdentityDigest: await localBootIdentityDigest(),
    currentOwners,
    exitedLeader: await observeExitedLeader(),
    parentDeathSupervisor: await observeSupervisor(),
    conclusion: {
      persistCurrentHandleOnly: "rejected",
      persistLeaderPidOnly: "rejected",
      sharedParentDeathSupervisor: "feasible-on-observed-platform",
      piRequiresOutOfProcessAttemptOwnership: true,
    },
  };
  assertEvidence(evidence);
  return evidence;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await runM3ProcessOwnershipProbe(), null, 2)}\n`);
}
