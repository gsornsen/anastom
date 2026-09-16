import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectProcess,
  isLiveProcess,
  matchesLiveProcess,
  terminateObservedGroup,
  waitForCondition,
  type ProcessIdentity,
} from "../m3-process-identity.js";

interface WorkerRecord {
  leaderPid: number;
  descendantPid: number;
}

async function readWorker(root: string): Promise<WorkerRecord | null> {
  try {
    return JSON.parse(await readFile(join(root, "worker.json"), "utf8")) as WorkerRecord;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

const [root, workerProgram] = process.argv.slice(2);
if (!root || !workerProgram) {
  throw new Error("Usage: m3-attempt-supervisor.ts <record-directory> <worker-program>");
}
const recordRoot = root;
const workerPath = workerProgram;
const ownerIdentity = JSON.parse(
  await readFile(join(recordRoot, "supervisor-owner.json"), "utf8"),
) as ProcessIdentity;

const worker = spawn(process.execPath, [workerPath, recordRoot, "hold"], {
  detached: true,
  stdio: "ignore",
});
if (worker.pid === undefined) {
  throw new Error("Supervised worker did not establish a PID");
}
await waitForCondition(
  "supervised worker readiness",
  async () => (await readWorker(recordRoot)) !== null,
);
const workerRecord = await readWorker(recordRoot);
if (workerRecord === null) {
  throw new Error("Supervised worker identities are missing");
}
const supervisorIdentity = await inspectProcess(process.pid);
const leaderIdentity = await inspectProcess(workerRecord.leaderPid);
const descendantIdentity = await inspectProcess(workerRecord.descendantPid);
if (
  !isLiveProcess(supervisorIdentity) ||
  !isLiveProcess(leaderIdentity) ||
  !isLiveProcess(descendantIdentity)
) {
  throw new Error("Supervised execution identities could not be established");
}
await writeFile(
  join(recordRoot, "supervisor-ready.json"),
  JSON.stringify({
    supervisor: supervisorIdentity,
    execution: leaderIdentity,
    descendant: descendantIdentity,
  }),
  { mode: 0o600 },
);

let cleanup: Promise<void> | undefined;
function clean(): Promise<void> {
  return (cleanup ??= (async () => {
    let outcome = "terminated";
    try {
      await terminateObservedGroup(leaderIdentity as ProcessIdentity);
    } catch {
      outcome = "unknown";
    }
    await writeFile(join(recordRoot, "supervisor-cleaned.json"), JSON.stringify({ outcome }), {
      mode: 0o600,
    });
  })());
}

process.stdin.resume();
process.stdin.once("end", () => void clean().finally(() => process.exit(0)));
process.stdin.once("close", () => void clean().finally(() => process.exit(0)));
void waitForCondition(
  "supervisor owner process to exit",
  async () => !(await matchesLiveProcess(ownerIdentity)),
  30_000,
).then(
  () => void clean().finally(() => process.exit(0)),
  () => void clean().finally(() => process.exit(1)),
);
await new Promise<void>(() => {});
