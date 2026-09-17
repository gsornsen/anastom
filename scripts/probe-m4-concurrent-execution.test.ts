import { describe, expect, it } from "vitest";

import { runM4ConcurrentExecutionFeasibility } from "./m4-concurrent-execution-feasibility.js";

describe("defined-SDLC concurrent execution feasibility", () => {
  it("reconciles every active execution and refuses replacement under ambiguity", async () => {
    expect(await runM4ConcurrentExecutionFeasibility()).toEqual({
      twoExecutionsActive: true,
      sharedRunAndFence: true,
      crossInstanceInspection: true,
      activeSetForbidsReplacement: true,
      fanInCleanupConfirmed: true,
      absentSetPermitsReplacement: true,
      oneUnknownForbidsReplacement: true,
      publicEvidenceSanitized: true,
    });
  }, 60_000);
});
