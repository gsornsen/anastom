import { describe, expect, it } from "vitest";

import type { ExecutionRequest, RuntimeAdapter } from "@anastom/runtime-contract";

import { FakeRuntimeAdapter, parseFakeScenario } from "./index.js";

function request(attempt = 1): ExecutionRequest {
  return {
    runId: "adapter-conformance",
    workflowInstanceId: "adapter-conformance:root",
    nodeId: "work",
    nodeKind: "agent",
    attempt,
    role: { id: "worker" },
    workspace: { id: "memory", mode: "memory" },
    context: { inputs: {}, dependencyOutputs: {} },
    budget: { maxAttempts: 2 },
    requiredOutputSchema: { type: "object" },
    toolPolicy: { allowMutations: false },
  };
}

async function adapterConformanceExample(adapter: RuntimeAdapter): Promise<void> {
  const capabilities = await adapter.capabilities();
  expect(capabilities.structuredOutput).not.toBe("none");
  const handle = await adapter.start(request());
  const events = [];
  for await (const event of adapter.events(handle)) {
    events.push(event);
  }
  expect(events.map((event) => event.type)).toEqual(["started", "log", "completed"]);
  await expect(adapter.collect(handle)).resolves.toEqual({
    status: "succeeded",
    output: { value: 1 },
  });
  await adapter.cancel(handle);
  await expect(adapter.collect(handle)).resolves.toMatchObject({ status: "succeeded" });
}

describe("FakeRuntimeAdapter", () => {
  it("provides an adapter conformance test example", async () => {
    const adapter = new FakeRuntimeAdapter({
      nodes: { work: [{ events: ["scripted"], output: { value: 1 } }] },
    });
    await adapterConformanceExample(adapter);
  });

  it("selects scripted results by node and attempt", async () => {
    const adapter = new FakeRuntimeAdapter({
      nodes: {
        work: [
          { outcome: "failed", failure: { category: "tool", message: "first failed" } },
          { output: { value: 2 } },
        ],
      },
    });
    const first = await adapter.collect(await adapter.start(request(1)));
    const second = await adapter.collect(await adapter.start(request(2)));
    expect(first).toMatchObject({ status: "failed", failure: { category: "tool" } });
    expect(second).toEqual({ status: "succeeded", output: { value: 2 } });
  });

  it("validates fake scenario YAML", () => {
    expect(parseFakeScenario("nodes:\n  work:\n    - output: { value: 1 }")).toEqual({
      nodes: { work: [{ output: { value: 1 } }] },
    });
    expect(() => parseFakeScenario("nodes:\n  work:\n    - outcome: magic")).toThrow(
      "Invalid fake scenario",
    );
  });
});
