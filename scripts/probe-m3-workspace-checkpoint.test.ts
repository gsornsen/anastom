import { describe, expect, it } from "vitest";
import { runM3WorkspaceCheckpointProbe } from "./probe-m3-workspace-checkpoint.js";

describe("M3 workspace checkpoint feasibility", () => {
  it("detects content and ownership changes without altering the source checkout", async () => {
    const evidence = await runM3WorkspaceCheckpointProbe();
    for (const section of [
      evidence.capture,
      evidence.contentConflicts,
      evidence.ownershipConflicts,
      evidence.restoration,
    ]) {
      expect(Object.values(section).every(Boolean)).toBe(true);
    }
    expect(evidence.conclusion).toEqual({
      temporaryIndexCheckpoint: "feasible",
      ignoredFingerprint: "required",
      stagingState: "non-authoritative",
      ownershipIdentity: "required",
      publicWorkspaceApiFrozen: false,
    });
  }, 60_000);
});
