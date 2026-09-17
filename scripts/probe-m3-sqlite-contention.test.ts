import { describe, expect, it } from "vitest";
import { runM3SqliteContentionProbe } from "./probe-m3-sqlite-contention.js";

describe("M3 SQLite contention feasibility", () => {
  it("serializes leases, fenced mutations, idempotency, and control requests", async () => {
    const evidence = await runM3SqliteContentionProbe();
    for (const section of [
      evidence.initialAcquire,
      evidence.renewal,
      evidence.takeover,
      evidence.idempotency,
      evidence.fencing,
      evidence.controls,
      evidence.releaseAndAcquire,
    ]) {
      expect(Object.values(section).every(Boolean)).toBe(true);
    }
    expect(evidence.conclusion).toEqual({
      beginImmediateSerialization: "feasible",
      fencedMutation: "feasible",
      idempotentMutation: "feasible",
      deduplicatedControlInbox: "feasible",
      publicPersistenceApiFrozen: false,
    });
  }, 60_000);
});
