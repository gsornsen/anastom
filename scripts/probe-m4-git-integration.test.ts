import { describe, expect, it } from "vitest";

import { runM4GitIntegrationFeasibility } from "./m4-git-integration-feasibility.js";

describe("defined-SDLC Git integration feasibility", () => {
  it("recovers prepared integration and refuses an unexpected branch head", async () => {
    const evidence = await runM4GitIntegrationFeasibility();
    expect(evidence).toMatchObject({
      deterministicCommit: true,
      recoveredBeforeRefUpdate: true,
      recoveredAfterRefUpdate: true,
      recoveredAfterWorktreeSync: true,
      unexpectedRefRefused: true,
      integratedContentExact: true,
      sourceCheckoutClean: true,
    });
    expect(evidence.preparationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 30_000);
});
