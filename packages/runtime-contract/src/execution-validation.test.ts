import { describe, expect, it } from "vitest";

import { assertExecutionRequest, assertExecutionResult } from "./index.js";

const request = {
  runId: "fixture",
  workflowInstanceId: "fixture:root",
  nodeId: "work",
  nodeKind: "agent",
  attempt: 1,
  workspace: {
    id: "fixture",
    mode: "isolated",
    repoRoot: "/fixture",
    path: "/fixture/worktree",
    baseCommit: "base",
    branch: "fixture",
  },
  context: { inputs: {}, dependencyOutputs: {} },
  budget: { maxAttempts: 1, maxDurationMs: 5_000 },
  requiredOutputSchema: { type: "object" },
  toolPolicy: { allowMutations: true },
};

describe("durable execution validation", () => {
  it("accepts exact requests and rejects unknown private fields", () => {
    expect(() => assertExecutionRequest(request)).not.toThrow();
    expect(() => assertExecutionRequest({ ...request, authToken: "private" })).toThrow(
      "Invalid persisted execution request",
    );
    expect(() =>
      assertExecutionRequest({
        ...request,
        workspace: { ...request.workspace, path: "bad\0path" },
      }),
    ).toThrow("Invalid persisted execution request");
    expect(() =>
      assertExecutionRequest({
        ...request,
        context: {
          ...request.context,
          inputs: { oversized: "x".repeat(4 * 1024 * 1024) },
        },
      }),
    ).toThrow("Invalid persisted execution request");
  });

  it("accepts exact normalized results and enforces the canonical byte bound", () => {
    expect(() =>
      assertExecutionResult({ status: "succeeded", output: { value: true } }),
    ).not.toThrow();
    expect(() =>
      assertExecutionResult({ status: "failed", failure: { category: "tool", message: "failed" } }),
    ).not.toThrow();
    expect(() =>
      assertExecutionResult({ status: "cancelled", reason: "cancelled", native: {} }),
    ).toThrow("Invalid execution result");
    expect(() =>
      assertExecutionResult({ status: "succeeded", output: "x".repeat(1024 * 1024) }),
    ).toThrow("Invalid execution result");
  });
});
