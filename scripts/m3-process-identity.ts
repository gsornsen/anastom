import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const psExecutable = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
const inspectionEnvironment = { ...process.env, LANG: "C", LC_ALL: "C" };

export interface ProcessIdentity {
  pid: number;
  processGroupId: number;
  state: string;
  /** Probe-only `ps` value. Its platform precision is insufficient as production authority. */
  startToken: string;
}

function validatePid(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive process identifier`);
  }
}

function parseIdentity(line: string, pid: number): ProcessIdentity | null {
  const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  if (!match) {
    return null;
  }
  return {
    pid,
    processGroupId: Number(match[1]),
    state: match[2] as string,
    startToken: match[3] as string,
  };
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === 1 || error.code === "1" || error.code === "ESRCH")
  );
}

export function isLiveProcess(identity: ProcessIdentity | null): identity is ProcessIdentity {
  return identity !== null && !["Z", "X"].includes(identity.state[0] ?? "X");
}

export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  validatePid(pid, "PID");
  try {
    const { stdout } = await execFileAsync(
      psExecutable,
      ["-o", "pgid=,stat=,lstart=", "-p", String(pid)],
      { env: inspectionEnvironment, timeout: 500, maxBuffer: 65_536 },
    );
    return parseIdentity(stdout, pid);
  } catch (error) {
    if (isMissingProcess(error)) {
      return null;
    }
    throw new Error(`Process ${pid} could not be inspected`, { cause: error });
  }
}

export async function matchesLiveProcess(expected: ProcessIdentity): Promise<boolean> {
  const observed = await inspectProcess(expected.pid);
  return (
    isLiveProcess(observed) &&
    observed.processGroupId === expected.processGroupId &&
    observed.startToken === expected.startToken
  );
}

export async function liveGroupMembers(processGroupId: number): Promise<ProcessIdentity[]> {
  validatePid(processGroupId, "Process group ID");
  const { stdout } = await execFileAsync(psExecutable, ["-axo", "pid=,pgid=,stat=,lstart="], {
    env: inspectionEnvironment,
    timeout: 500,
    maxBuffer: 1_048_576,
  });
  const members: ProcessIdentity[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || Number(match[2]) !== processGroupId) {
      continue;
    }
    const identity = {
      pid: Number(match[1]),
      processGroupId,
      state: match[3] as string,
      startToken: match[4] as string,
    };
    if (isLiveProcess(identity)) {
      members.push(identity);
    }
  }
  return members;
}

export async function waitForCondition(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function signalGroup(processGroupId: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

export async function terminateObservedGroup(leader: ProcessIdentity): Promise<void> {
  if (!(await matchesLiveProcess(leader))) {
    throw new Error("Process-group leader identity no longer matches; cleanup is unsafe");
  }
  await signalGroup(leader.processGroupId, "SIGTERM");
  const gracefulDeadline = Date.now() + 100;
  while (Date.now() < gracefulDeadline && (await liveGroupMembers(leader.processGroupId)).length) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if ((await liveGroupMembers(leader.processGroupId)).length) {
    await signalGroup(leader.processGroupId, "SIGKILL");
  }
  await waitForCondition(
    `process group ${leader.processGroupId} to terminate`,
    async () => (await liveGroupMembers(leader.processGroupId)).length === 0,
  );
}

export async function terminateObservedProcess(identity: ProcessIdentity): Promise<void> {
  if (!(await matchesLiveProcess(identity))) {
    throw new Error("Process identity no longer matches; cleanup is unsafe");
  }
  process.kill(identity.pid, "SIGKILL");
  await waitForCondition(
    `process ${identity.pid} to terminate`,
    async () => !(await matchesLiveProcess(identity)),
  );
}

export async function localBootIdentityDigest(): Promise<string> {
  let value: string;
  if (process.platform === "linux") {
    value = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
  } else if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      env: inspectionEnvironment,
      timeout: 500,
      maxBuffer: 65_536,
    });
    value = stdout;
  } else {
    throw new Error(`M3 process ownership is not supported on ${process.platform}`);
  }
  return `sha256:${createHash("sha256").update(value.trim()).digest("hex")}`;
}
