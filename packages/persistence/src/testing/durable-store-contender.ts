import { SqliteDurableRunStore } from "../durable-store.js";
import { RunStoreError, type LocalProcessIdentity, type RunLeaseToken } from "@anastom/engine";

const [action, path, value] = process.argv.slice(2);
if (!action || !path || !value) {
  throw new Error("Expected action, database path, and action payload");
}

const store = new SqliteDurableRunStore(path);
try {
  if (action === "acquire") {
    const owner: LocalProcessIdentity = {
      version: "anastom.dev/local-process/v1alpha1",
      hostIdentityDigest: `sha256:${"1".repeat(64)}`,
      bootIdentityDigest: `sha256:${"2".repeat(64)}`,
      pid: process.pid,
      startToken: `contender-${process.pid}`,
    };
    const token = await store.acquireReleased({
      runId: "multiprocess",
      ownerId: value,
      owner,
    });
    process.stdout.write(JSON.stringify({ outcome: "acquired", token }) + "\n");
  } else if (action === "commit") {
    const token = JSON.parse(value) as RunLeaseToken;
    const receipt = await store.commit({
      lease: token,
      operationId: "shared-mutation",
      expectedSequence: 2,
      events: [
        {
          type: "ControlRequestObserved",
          runId: "multiprocess",
          sequence: 3,
          operationId: "fixture-control",
          action: "pause",
          recordedAtMs: 1,
        },
      ],
    });
    process.stdout.write(JSON.stringify({ outcome: "committed", receipt }) + "\n");
  } else {
    throw new Error(`Unknown contender action ${JSON.stringify(action)}`);
  }
} catch (error) {
  if (error instanceof RunStoreError) {
    process.stdout.write(JSON.stringify({ outcome: "store-error", code: error.code }) + "\n");
  } else {
    throw error;
  }
} finally {
  store.close();
}
