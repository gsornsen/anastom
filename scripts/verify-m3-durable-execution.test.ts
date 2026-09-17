import { describe, expect, it } from "vitest";

import { runM3DurableExecutionAcceptance } from "./verify-m3-durable-execution.js";

describe("M3 durable execution acceptance", () => {
  it("recovers or refuses three SIGKILL cases through separate production processes", async () => {
    const evidence = await runM3DurableExecutionAcceptance();

    expect(evidence.cleanRecovery).toMatchObject({
      runId: "m3-clean",
      ownershipGenerations: [1, 2],
      orphanTransitions: 1,
      terminalState: "succeeded",
      verifierPassed: true,
      eventSequencesContiguous: true,
      parentDeathCleanupConfirmed: true,
      statusBeforeExpiryOwnerState: "unknown",
      beforeExpiryTakeoverRefused: "lease-active",
      staleGenerationAppendRejected: "ownership-conflict",
      repeatedResumeUnchanged: true,
      snapshotTailEqualsFullReplay: true,
      corruptSnapshotFallsBackToFullReplay: true,
      publicSentinelAbsent: true,
      sourceCheckoutClean: true,
      changedFiles: ["server.mjs"],
    });
    expect(evidence.cleanRecovery.firstExecutionId).not.toBe(
      evidence.cleanRecovery.replacementExecutionId,
    );
    expect(evidence.cleanRecovery.artifactsVerified).toBeGreaterThan(0);

    expect(evidence.dirtyWorkspace).toEqual({
      runId: "m3-dirty",
      terminalState: "paused",
      differences: ["diff-digest", "changed-files"],
      orphanTransitions: 1,
      replacementStarted: false,
      retainedDiffBytes: evidence.dirtyWorkspace.retainedDiffBytes,
      sourceCheckoutClean: true,
    });
    expect(evidence.dirtyWorkspace.retainedDiffBytes).toBeGreaterThan(0);
    expect(evidence.unknownExecution).toEqual({
      runId: "m3-unknown",
      terminalState: "recovery-blocked",
      reason: "invalid-record",
      replacementStarted: false,
      sourceCheckoutClean: true,
    });
    expect(evidence.duplicateOperation).toEqual({
      pauseRunId: "m3-duplicate-pause",
      cancelRunId: "m3-duplicate-cancel",
      pauseReplayConfirmed: true,
      cancelReplayConfirmed: true,
      changedActionRejected: "control-conflict",
      pauseState: "paused",
      cancelState: "cancelled",
    });
    expect(evidence.modelCalls).toBe(0);
  }, 120_000);
});
