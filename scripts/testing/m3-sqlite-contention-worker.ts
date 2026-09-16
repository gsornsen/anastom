import { canonicalExistingRoot } from "@anastom/path-policy";
import {
  M3ContentionStore,
  assertM3ContentionRequest,
  type M3ContentionRequest,
} from "../m3-sqlite-contention.js";
import { readM3Record, writeM3Record, type M3RecordName } from "./m3-records.js";
import { inspectProcess, isLiveProcess, waitForCondition } from "../m3-process-identity.js";

type Participant = "a" | "b";

interface WorkerEnvelope {
  round: number;
  request: M3ContentionRequest;
}

function requestName(participant: Participant): M3RecordName {
  return participant === "a" ? "contention-a-request.json" : "contention-b-request.json";
}

function readyName(participant: Participant): M3RecordName {
  return participant === "a" ? "contention-a-ready.json" : "contention-b-ready.json";
}

function assertEnvelope(value: unknown): asserts value is WorkerEnvelope {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "request,round" ||
    !("round" in value) ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    !("request" in value)
  ) {
    throw new Error("Invalid M3 contention worker envelope");
  }
  assertM3ContentionRequest(value.request);
}

const participantValue = process.argv[2];
if (participantValue !== "a" && participantValue !== "b") {
  throw new Error("Usage: m3-sqlite-contention-worker.ts <a|b>");
}
const participant: Participant = participantValue;
const root = await canonicalExistingRoot(".");
const rawEnvelope = await readM3Record<unknown>(root, requestName(participant));
assertEnvelope(rawEnvelope);
const envelope: WorkerEnvelope = rawEnvelope;

const store = new M3ContentionStore(root);
try {
  const processIdentity = await inspectProcess(process.pid);
  if (!isLiveProcess(processIdentity)) {
    throw new Error("Contention worker identity is unavailable");
  }
  await writeM3Record(root, readyName(participant), {
    round: envelope.round,
    process: processIdentity,
  });
  await waitForCondition(
    `contention round ${envelope.round} release`,
    async () => {
      const gate = await readM3Record<{ round?: unknown }>(root, "contention-gate.json");
      return gate?.round === envelope.round;
    },
    15_000,
  );
  process.stdout.write(`${JSON.stringify(store.execute(envelope.request))}\n`);
} finally {
  store.close();
}
