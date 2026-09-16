import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalExistingRoot } from "@anastom/path-policy";
import {
  inspectProcess,
  isLiveProcess,
  matchesLiveProcess,
  terminateObservedGroup,
  waitForCondition,
  type ProcessIdentity,
} from "../m3-process-identity.js";
import { readM3Record, writeM3Record } from "./m3-records.js";

interface WorkerRecord {
  leaderPid: number;
  descendantPid: number;
}

async function readWorker(root: string): Promise<WorkerRecord | null> {
  return readM3Record<WorkerRecord>(root, "worker.json");
}

const recordRoot = await canonicalExistingRoot(".");
const workerPath = fileURLToPath(new URL("./m3-attempt-worker.mjs", import.meta.url));
const ownerIdentity = await readM3Record<ProcessIdentity>(recordRoot, "supervisor-owner.json");
if (ownerIdentity === null) {
  throw new Error("Supervisor owner identity is missing");
}

const worker = spawn(process.execPath, [workerPath, "hold"], {
  cwd: recordRoot,
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
try {
  await writeM3Record(recordRoot, "supervisor-ready.json", {
    supervisor: supervisorIdentity,
    execution: leaderIdentity,
    descendant: descendantIdentity,
  });
} catch (error) {
  await terminateObservedGroup(leaderIdentity);
  throw error;
}

let cleanup: Promise<void> | undefined;
function clean(): Promise<void> {
  return (cleanup ??= (async () => {
    let outcome = "terminated";
    try {
      await terminateObservedGroup(leaderIdentity as ProcessIdentity);
    } catch {
      outcome = "unknown";
    }
    await writeM3Record(recordRoot, "supervisor-cleaned.json", { outcome });
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
