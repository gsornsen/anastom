import { describe, expect, it } from "vitest";
import { runM3SnapshotProbe } from "./probe-m3-snapshot.js";

describe("M3 snapshot feasibility", () => {
  it("matches full replay and falls back without weakening event authority", async () => {
    const evidence = await runM3SnapshotProbe();
    for (const section of [
      evidence.equality,
      evidence.fallback,
      evidence.authority,
      evidence.compatibility,
    ]) {
      expect(Object.values(section).every(Boolean)).toBe(true);
    }
    expect(evidence.conclusion).toEqual({
      snapshotTailReplay: "feasible",
      corruptSnapshotFallback: "feasible",
      eventsRemainAuthoritative: true,
      eventPrefixBinding: "required",
      publicPersistenceApiFrozen: false,
    });
  }, 30_000);
});
