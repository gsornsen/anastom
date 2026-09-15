import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function macGroupHasLiveMembers(pid: number, deadline: number): Promise<boolean> {
  // Darwin's group-wide kill(0) can return EPERM if any member cannot be signalled.
  // Inspect the group instead of treating that error as proof of either state.
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pgid=,stat="], {
    timeout: Math.max(1, Math.min(100, deadline - performance.now())),
    maxBuffer: 1_048_576,
  });
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (match && Number(match[1]) === pid && !["Z", "X"].includes(match[2]![0]!)) {
      return true;
    }
  }
  return false;
}

async function groupExists(pid: number, deadline: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if (process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EPERM") {
      try {
        if (performance.now() >= deadline) {
          throw new Error("Owned process group inspection exceeded its deadline", {
            cause: error,
          });
        }
        return await macGroupHasLiveMembers(pid, deadline);
      } catch (inspectionError) {
        throw new Error("Owned process group termination cannot be inspected", {
          cause: inspectionError,
        });
      }
    }
    throw new Error("Owned process group termination cannot be confirmed", { cause: error });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new Error("Owned process group could not be signalled", { cause: error });
    }
  }
}

/** Stop a trusted-tool POSIX process group; reject rather than imply uncertain cleanup is safe. */
export async function terminateOwnedGroup(
  child: ChildProcessWithoutNullStreams,
  waitForLeaderExit?: Promise<unknown>,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned process did not establish its identity");
    }
    return;
  }
  const started = performance.now();
  const deadline = started + 300;
  signalGroup(pid, "SIGTERM");
  while ((await groupExists(pid, deadline)) && performance.now() - started < 100) {
    await delay(5);
  }
  if (await groupExists(pid, deadline)) {
    signalGroup(pid, "SIGKILL");
  }
  while ((await groupExists(pid, deadline)) && performance.now() < deadline) {
    await delay(5);
  }
  if (await groupExists(pid, deadline)) {
    throw new Error("Owned process group termination was not confirmed within 300 ms");
  }
  if (waitForLeaderExit) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waitForLeaderExit,
        new Promise<never>((_done, reject) => {
          timer = setTimeout(
            () => reject(new Error("Owned leader termination was not confirmed within 300 ms")),
            Math.max(1, 300 - (performance.now() - started)),
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
