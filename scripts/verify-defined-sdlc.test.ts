import { expect, it } from "vitest";

import { runDefinedSdlcAcceptance } from "./verify-defined-sdlc.js";

it("executes concurrent defined-SDLC processes, controls, failures, and integration recovery", async () => {
  const evidence = await runDefinedSdlcAcceptance();

  expect(evidence.successOrders.map(({ completionOrder }) => completionOrder)).toEqual([
    ["implement.left", "implement.right"],
    ["implement.right", "implement.left"],
  ]);
  expect(evidence.controls.map(({ terminalState }) => terminalState)).toEqual([
    "paused",
    "cancelled",
  ]);
  expect(evidence.integrationRecovery).toMatchObject({
    committedAfterRestart: true,
    staleFenceRejected: "ownership-conflict",
    terminalState: "succeeded",
  });
  expect(evidence.modelCalls).toBe(0);
}, 180_000);
