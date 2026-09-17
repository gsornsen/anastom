import { describe, expect, it } from "vitest";

import { runM4GraphFeasibility } from "./m4-graph-feasibility.js";

describe("defined-SDLC graph feasibility", () => {
  it("keeps expansion and integration deterministic across completion orders", () => {
    expect(runM4GraphFeasibility()).toEqual({
      stableExpansion: true,
      alternateCompletionOrders: true,
      deterministicIntegrationOrder: true,
      boundedParallelism: true,
      cycleRejected: true,
      overlapRejected: true,
      traversalRejected: true,
    });
  });
});
