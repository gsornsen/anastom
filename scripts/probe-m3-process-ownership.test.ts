import { describe, expect, it } from "vitest";
import { runM3ProcessOwnershipProbe } from "./probe-m3-process-ownership.js";

describe("M3 process-ownership feasibility", () => {
  it("proves current crash survivors, the exited-leader gap, and parent-death cleanup", async () => {
    const evidence = await runM3ProcessOwnershipProbe();
    expect(evidence.currentOwners.map((owner) => owner.owner)).toEqual([
      "pi",
      "codex",
      "claude-code",
      "command",
    ]);
    expect(evidence.currentOwners.every((owner) => owner.descendantAliveAfterCrash)).toBe(true);
    expect(evidence.currentOwners.every((owner) => owner.productPersistedExecutionReference)).toBe(
      false,
    );
    expect(evidence.exitedLeader).toEqual({
      leaderAbsent: true,
      descendantAlive: true,
      groupStillAlive: true,
      leaderIdentityCanAuthorizeCleanup: false,
    });
    expect(evidence.parentDeathSupervisor).toEqual({
      coordinatorAbsent: true,
      supervisorObservedParentDeath: true,
      supervisorAbsentAfterCleanup: true,
      executionAbsentAfterCleanup: true,
      descendantAbsentAfterCleanup: true,
    });
  }, 45_000);
});
