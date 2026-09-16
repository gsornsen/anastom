import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { runCli, type DurableRunInspection } from "../packages/cli/src/index.js";

const [runId, directory, expectedStatus, expectedEventsText] = process.argv.slice(2);
const expectedEvents = Number(expectedEventsText);
if (
  !runId ||
  !directory ||
  !["succeeded", "failed"].includes(expectedStatus ?? "") ||
  !Number.isSafeInteger(expectedEvents) ||
  expectedEvents < 1
) {
  throw new Error("Usage: check-historical-replay <run-id> <state-dir> <status> <events>");
}
const stateDir = resolve(directory);
const databasePath = resolve(stateDir, "anastom.sqlite");
const selectedRunId: string = runId;

function rowDigests(): { workflow: string; events: string } {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const workflow = db
      .prepare("SELECT workflow_json FROM runs WHERE run_id = ?")
      .get(selectedRunId);
    const events = db
      .prepare("SELECT event_json FROM events WHERE run_id = ? ORDER BY sequence")
      .all(selectedRunId);
    if (typeof workflow?.workflow_json !== "string" || events.length !== expectedEvents) {
      throw new Error("Historical rows or expected event count are missing");
    }
    const bytes = events.map((row) => {
      if (typeof row.event_json !== "string") {
        throw new Error("Historical event row is not JSON text");
      }
      return row.event_json;
    });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    return { workflow: digest(workflow.workflow_json), events: digest(bytes.join("\n")) };
  } finally {
    db.close();
  }
}

const before = rowDigests();
const output: string[] = [];
const errors: string[] = [];
const io = {
  stdout: (message: string) => output.push(message),
  stderr: (message: string) => errors.push(message),
};
if ((await runCli(["status", runId, "--state-dir", stateDir], { io })) !== 0 || errors.length) {
  throw new Error("Later-process durable status failed");
}
output.length = 0;
if (
  (await runCli(["inspect", runId, "--state-dir", stateDir, "--json"], { io })) !== 0 ||
  errors.length !== 0 ||
  output.length !== 1
) {
  throw new Error("Later-process durable JSON inspection failed");
}
const inspection = JSON.parse(output[0]!) as DurableRunInspection;
if (
  inspection.state.runId !== runId ||
  inspection.state.status !== expectedStatus ||
  inspection.events.length !== expectedEvents ||
  inspection.events.some((event, index) => event.runId !== runId || event.sequence !== index + 1)
) {
  throw new Error("Historical replay identity, status or event sequence changed");
}
const after = rowDigests();
if (before.workflow !== after.workflow || before.events !== after.events) {
  throw new Error("Historical workflow or event rows changed during inspection");
}
process.stdout.write(
  JSON.stringify({
    runId,
    status: inspection.state.status,
    events: inspection.events.length,
    workflowRowSha256: before.workflow,
    eventRowsSha256: before.events,
    rowsUnchanged: true,
    modelCalls: 0,
  }) + "\n",
);
