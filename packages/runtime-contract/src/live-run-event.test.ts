import { describe, expect, it } from "vitest";

import { assertLiveRunEvent } from "./index.js";

const valid = {
  version: "anastom.dev/live-run-event/v1alpha1",
  runId: "run",
  sequence: 1,
  type: "log",
  nodeId: "work",
  phase: "implementation",
  attempt: 1,
  message: "bounded public message",
  droppedMessages: 4,
} as const;

describe("live run event validation", () => {
  it("accepts an exact bounded public observation", () => {
    expect(() => assertLiveRunEvent(valid)).not.toThrow();
  });

  it("rejects cross-variant fields and oversized UTF-8 messages", () => {
    expect(() => assertLiveRunEvent({ ...valid, provider: "private" })).toThrow(
      "Invalid live run event",
    );
    expect(() => assertLiveRunEvent({ ...valid, message: "🙂".repeat(600) })).toThrow(
      "Invalid live run event",
    );
    expect(() =>
      assertLiveRunEvent({
        version: valid.version,
        runId: valid.runId,
        sequence: valid.sequence,
        type: "attempt",
        nodeId: valid.nodeId,
        phase: valid.phase,
        attempt: valid.attempt,
        status: "failed",
      }),
    ).toThrow("Invalid live run event");
  });
});
