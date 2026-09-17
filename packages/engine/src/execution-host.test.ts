import { workerReportSchema } from "@anastom/core";
import { describe, expect, it } from "vitest";

import {
  assertExecutionPlanRef,
  assertPersistedExecutionRef,
  assertPrepareExecution,
  createPrepareExecution,
  type LocalProcessIdentity,
} from "./index.js";

const digest = `sha256:${"a".repeat(64)}`;
const coordinator: LocalProcessIdentity = {
  version: "anastom.dev/local-process/v1alpha1",
  hostIdentityDigest: digest,
  bootIdentityDigest: digest,
  pid: 123,
  startToken: "fixture-start",
};
const workspace = {
  id: "fixture",
  mode: "isolated" as const,
  repoRoot: "/fixture",
  path: "/fixture/worktree",
  baseCommit: "base",
  branch: "fixture",
};

describe("execution-host contract", () => {
  it("binds every runtime launch field into an exact plan", () => {
    const prepared = createPrepareExecution({
      runId: "fixture",
      executionId: "00000000-0000-4000-8000-000000000001",
      generation: 2,
      coordinator,
      descriptor: {
        version: "anastom.dev/runtime-descriptor/v1alpha1",
        runtimeId: "fixture",
        configurationVersion: "fixture-v1",
        configuration: { model: "fixture" },
      },
      request: {
        runId: "fixture",
        workflowInstanceId: "fixture:root",
        nodeId: "work",
        nodeKind: "agent",
        attempt: 1,
        workspace,
        context: { inputs: {}, dependencyOutputs: {} },
        budget: { maxAttempts: 1, maxDurationMs: 5_000 },
        requiredOutputSchema: structuredClone(workerReportSchema),
        toolPolicy: { allowMutations: true },
      },
    });
    expect(Object.keys(prepared).sort()).toEqual(["coordinator", "descriptor", "plan", "request"]);
    expect(() => assertPrepareExecution(prepared)).not.toThrow();
    if (!("request" in prepared)) {
      throw new Error("Runtime preparation produced a command launch");
    }
    prepared.request.nodeId = "tampered";
    expect(() => assertPrepareExecution(prepared)).toThrow("plan digest");
  });

  it("binds command and workspace inputs and validates persisted manifest identity", () => {
    const prepared = createPrepareExecution({
      runId: "fixture",
      executionId: "00000000-0000-4000-8000-000000000002",
      generation: 1,
      coordinator,
      command: {
        argv: ["node", "verify.mjs"],
        cwd: ".",
        maxDurationMs: 1_000,
        maxOutputBytes: 1_024,
      },
      workspace,
    });
    expect(Object.keys(prepared).sort()).toEqual(["command", "coordinator", "plan", "workspace"]);
    expect(() => assertPrepareExecution(prepared)).not.toThrow();
    const persisted = { ...prepared.plan, manifestDigest: digest };
    expect(() => assertPersistedExecutionRef(persisted, prepared.plan)).not.toThrow();
    expect(() =>
      assertPersistedExecutionRef({ ...persisted, generation: 2 }, prepared.plan),
    ).toThrow("another plan");
  });

  it("rejects malformed references without leaking incidental JavaScript errors", () => {
    expect(() => assertExecutionPlanRef(null as never)).toThrow("Invalid execution plan reference");
    expect(() =>
      assertExecutionPlanRef({
        version: "anastom.dev/owned-execution/v1alpha1",
        runId: "fixture",
        executionId: "not-a-v4-uuid",
        kind: "runtime",
        generation: 1,
        planDigest: digest,
      }),
    ).toThrow("Invalid execution plan reference");
  });
});
