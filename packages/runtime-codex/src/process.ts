import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
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
  signalGroup(pid, "SIGTERM");
  while (groupExists(pid) && performance.now() - started < 100) {
    await delay(5);
  }
  if (groupExists(pid)) {
    signalGroup(pid, "SIGKILL");
  }
  while (groupExists(pid) && performance.now() - started < 300) {
    await delay(5);
  }
  if (groupExists(pid)) {
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
