import { describe, expect, it } from "vitest";
import { runM3SupervisorProtocolProbe } from "./probe-m3-supervisor-protocol.js";

function allEvidencePassed(value: { owner: string } & Record<string, unknown>): boolean {
  return Object.entries(value).every(([key, result]) => key === "owner" || result === true);
}

describe("M3 supervisor protocol feasibility", () => {
  it("proves authorization, bounded IPC, cleanup, and fail-closed supervisor loss", async () => {
    const evidence = await runM3SupervisorProtocolProbe();
    expect(evidence.success.map(({ owner }) => owner)).toEqual([
      "pi",
      "codex",
      "claude-code",
      "command",
    ]);
    expect(evidence.success.every(allEvidencePassed)).toBe(true);
    expect(evidence.cancellation.every(allEvidencePassed)).toBe(true);
    expect(evidence.parentDeath.every(allEvidencePassed)).toBe(true);
    expect(evidence.supervisorLoss).toEqual({
      activeExecutionRemained: true,
      laterInspectionUnknown: true,
      replacementStartPermitted: false,
      fixtureCleanupConfirmed: true,
    });
    expect(evidence.startWindowCrash).toEqual({
      startingStatePersisted: true,
      noSideEffectObserved: true,
      laterInspectionUnknown: true,
      replacementStartPermitted: false,
      supervisorAbsent: true,
    });
  }, 120_000);
});
