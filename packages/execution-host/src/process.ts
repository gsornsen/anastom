import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { digestBytes } from "@anastom/core";
import {
  assertLocalProcessIdentity,
  type LocalProcessIdentity,
  type ProcessObservation,
} from "@anastom/engine";
import { parseLinuxProcessStat } from "./linux-process-stat.js";

const executeFile = promisify(execFile);
const inspectionEnvironment = {
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
};

/** Private process-group evidence retained only in execution-host records. */
export interface PrivateProcessIdentity extends LocalProcessIdentity {
  processGroupId: number;
  state: string;
}

interface ObservedProcessIdentity extends LocalProcessIdentity {
  processGroupId?: number;
  state: string;
}

function assertPid(pid: number, label: string): void {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError(`${label} must be a positive safe process identifier`);
  }
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === 1 || error.code === "1" || error.code === "ESRCH" || error.code === "ENOENT")
  );
}

function liveState(state: string): boolean {
  return !["Z", "X"].includes(state[0] ?? "X");
}

async function linuxProcess(
  pid: number,
): Promise<Pick<ObservedProcessIdentity, "processGroupId" | "startToken" | "state"> | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return parseLinuxProcessStat(stat);
  } catch (error) {
    if (isMissingProcess(error)) {
      return null;
    }
    throw error;
  }
}

async function darwinProcess(
  pid: number,
): Promise<Pick<ObservedProcessIdentity, "processGroupId" | "startToken" | "state"> | null> {
  try {
    const { stdout } = await executeFile(
      "/bin/ps",
      ["-o", "pgid=,stat=,lstart=", "-p", String(pid)],
      { env: inspectionEnvironment, timeout: 500, maxBuffer: 65_536 },
    );
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(stdout);
    if (!match) {
      return null;
    }
    return { processGroupId: Number(match[1]), state: match[2]!, startToken: match[3]! };
  } catch (error) {
    if (isMissingProcess(error)) {
      return null;
    }
    throw error;
  }
}

async function rawHostIdentity(): Promise<string> {
  if (process.platform === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = (await readFile(path, "utf8")).trim();
        if (value) {
          return value;
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
    throw new Error("Local Linux machine identity is unavailable");
  }
  if (process.platform === "darwin") {
    const { stdout } = await executeFile(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      { env: inspectionEnvironment, timeout: 1_000, maxBuffer: 65_536 },
    );
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
    if (!match) {
      throw new Error("Local macOS machine identity is unavailable");
    }
    return match[1]!;
  }
  throw new Error(`Local process identity is unsupported on ${process.platform}`);
}

async function rawBootIdentity(): Promise<string> {
  if (process.platform === "linux") {
    return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  }
  if (process.platform === "darwin") {
    const { stdout } = await executeFile("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      env: inspectionEnvironment,
      timeout: 500,
      maxBuffer: 65_536,
    });
    return stdout.trim();
  }
  throw new Error(`Local process identity is unsupported on ${process.platform}`);
}

async function loadIdentityDigests(): Promise<{
  hostIdentityDigest: string;
  bootIdentityDigest: string;
}> {
  const [host, boot] = await Promise.all([rawHostIdentity(), rawBootIdentity()]);
  return {
    hostIdentityDigest: digestBytes(`anastom.dev/host-identity/v1alpha1\n${host}`),
    bootIdentityDigest: digestBytes(`anastom.dev/boot-identity/v1alpha1\n${boot}`),
  };
}

let identityDigestCache:
  Promise<{ hostIdentityDigest: string; bootIdentityDigest: string }> | undefined;

async function identityDigests(): Promise<{
  hostIdentityDigest: string;
  bootIdentityDigest: string;
}> {
  identityDigestCache ??= loadIdentityDigests().catch((error: unknown) => {
    identityDigestCache = undefined;
    throw error;
  });
  return identityDigestCache;
}

async function inspectObservedProcess(pid: number): Promise<ObservedProcessIdentity | null> {
  assertPid(pid, "PID");
  let processIdentity: Pick<
    ObservedProcessIdentity,
    "processGroupId" | "startToken" | "state"
  > | null = null;
  if (process.platform === "linux") {
    processIdentity = await linuxProcess(pid);
  } else if (process.platform === "darwin") {
    processIdentity = await darwinProcess(pid);
  }
  if (!processIdentity) {
    return null;
  }
  const digests = await identityDigests();
  return {
    version: "anastom.dev/local-process/v1alpha1",
    ...digests,
    pid,
    startToken: processIdentity.startToken,
    state: processIdentity.state,
    ...(processIdentity.processGroupId === undefined
      ? {}
      : { processGroupId: processIdentity.processGroupId }),
  };
}

/** Capture the strongest supported same-host process and process-group identity. */
export async function inspectPrivateProcess(
  pid = process.pid,
): Promise<PrivateProcessIdentity | null> {
  const identity = await inspectObservedProcess(pid);
  if (!identity) {
    return null;
  }
  if (identity.processGroupId === undefined) {
    throw new Error("Process group identity is unavailable");
  }
  return { ...identity, processGroupId: identity.processGroupId };
}

/** Capture sanitized identity for a local process without retaining raw host or boot identifiers. */
export async function localProcessIdentity(pid = process.pid): Promise<LocalProcessIdentity> {
  const identity = await inspectObservedProcess(pid);
  if (!identity || !liveState(identity.state)) {
    throw new Error(`Process ${pid} is not live`);
  }
  return publicIdentity(identity);
}

/** Observe a recorded process conservatively without treating inspection failure as absence. */
export async function observeLocalProcess(
  expected: LocalProcessIdentity,
): Promise<ProcessObservation> {
  assertLocalProcessIdentity(expected);
  const observedAtMs = Date.now();
  try {
    const digests = await identityDigests();
    if (digests.hostIdentityDigest !== expected.hostIdentityDigest) {
      return { state: "unknown", observedAtMs, reason: "Recorded owner belongs to another host" };
    }
    if (digests.bootIdentityDigest !== expected.bootIdentityDigest) {
      return { state: "absent", observedAtMs };
    }
    const observed = await inspectObservedProcess(expected.pid);
    if (!observed || !liveState(observed.state) || observed.startToken !== expected.startToken) {
      return { state: "absent", observedAtMs };
    }
    return { state: "alive", observedAtMs };
  } catch {
    return { state: "unknown", observedAtMs, reason: "Local process inspection failed" };
  }
}

/** Compare current process evidence with an exact private identity. */
export async function matchesPrivateProcess(expected: PrivateProcessIdentity): Promise<boolean> {
  const observed = await inspectPrivateProcess(expected.pid);
  return (
    !!observed &&
    liveState(observed.state) &&
    observed.hostIdentityDigest === expected.hostIdentityDigest &&
    observed.bootIdentityDigest === expected.bootIdentityDigest &&
    observed.startToken === expected.startToken &&
    observed.processGroupId === expected.processGroupId
  );
}

/** Return live members of one process group for bounded cleanup confirmation. */
export async function liveProcessGroup(processGroupId: number): Promise<number[]> {
  assertPid(processGroupId, "Process group ID");
  const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  const { stdout } = await executeFile(ps, ["-axo", "pid=,pgid=,stat="], {
    env: inspectionEnvironment,
    timeout: 500,
    maxBuffer: 1024 * 1024,
  });
  const members: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match && Number(match[2]) === processGroupId && liveState(match[3]!)) {
      members.push(Number(match[1]));
    }
  }
  return members;
}

/** Wait with bounded polling until a model-free condition is established. */
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

/** Terminate only an authenticated leader's current process group and confirm no live members remain. */
export async function terminatePrivateProcessGroup(
  leader: PrivateProcessIdentity,
  graceMs = 1_000,
): Promise<boolean> {
  if (!(await matchesPrivateProcess(leader))) {
    return false;
  }
  signalGroup(leader.processGroupId, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (await liveProcessGroup(leader.processGroupId)).length > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if ((await liveProcessGroup(leader.processGroupId)).length > 0) {
    signalGroup(leader.processGroupId, "SIGKILL");
  }
  try {
    await waitForCondition(
      `process group ${leader.processGroupId} cleanup`,
      async () => (await liveProcessGroup(leader.processGroupId)).length === 0,
      5_000,
    );
    return true;
  } catch {
    return false;
  }
}

function signalGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function publicIdentity(identity: LocalProcessIdentity): LocalProcessIdentity {
  return {
    version: identity.version,
    hostIdentityDigest: identity.hostIdentityDigest,
    bootIdentityDigest: identity.bootIdentityDigest,
    pid: identity.pid,
    startToken: identity.startToken,
  };
}
