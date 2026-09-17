import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function groupHasLiveMembers(pid: number): Promise<boolean> {
  // A successful group-wide kill(0) may identify only zombies. Inspect live status.
  const executable = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  const { stdout } = await execFileAsync(executable, ["-axo", "pgid=,stat="], {
    timeout: 500,
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

async function groupExists(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
    return await groupHasLiveMembers(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      try {
        return await groupHasLiveMembers(pid);
      } catch (inspectionError) {
        throw new Error("Owned process group termination cannot be inspected", {
          cause: inspectionError,
        });
      }
    }
    throw new Error("Owned process group termination cannot be confirmed", { cause: error });
  }
}

async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || (code === "EPERM" && !(await groupHasLiveMembers(pid)))) {
      return;
    }
    throw new Error("Owned process group could not be signalled", { cause: error });
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
  const deadline = started + 1000;
  if (await groupExists(pid)) {
    await signalGroup(pid, "SIGTERM");
  }
  while ((await groupExists(pid)) && performance.now() - started < 100) {
    await delay(5);
  }
  if (await groupExists(pid)) {
    await signalGroup(pid, "SIGKILL");
  }
  while ((await groupExists(pid)) && performance.now() < deadline) {
    await delay(5);
  }
  if (await groupExists(pid)) {
    throw new Error("Owned process group termination was not confirmed within 1000 ms");
  }
  if (waitForLeaderExit) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waitForLeaderExit,
        new Promise<never>((_done, reject) => {
          timer = setTimeout(
            () => reject(new Error("Owned leader termination was not confirmed within 1000 ms")),
            Math.max(1, 1000 - (performance.now() - started)),
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
