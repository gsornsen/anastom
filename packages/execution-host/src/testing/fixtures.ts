import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { workerReportSchema } from "@anastom/core";
import {
  createPrepareExecution,
  type LocalProcessIdentity,
  type PrepareExecution,
} from "@anastom/engine";
import type { ExecutionRequest, RuntimeDescriptor, WorkspaceRef } from "@anastom/runtime-contract";

import type { RuntimeHostCommand } from "../index.js";

export type FixtureOwner = "pi" | "codex" | "claude-code" | "command";
export type FixtureScenario = "success" | "hold" | "pressure";

/** Locate the checked-in fixture runtime host without an inline executable script. */
export function fixtureRuntimeHost(
  mode: "normal" | "start-gated" = "normal",
  probeRoot?: string,
): RuntimeHostCommand {
  if (mode === "start-gated" && !probeRoot) {
    throw new TypeError("Start-gated fixture runtime host requires a probe root");
  }
  return {
    executable: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("fixture-runtime-host.ts", import.meta.url)),
      ...(mode === "normal" ? [] : [mode, probeRoot!]),
    ],
  };
}

/** Build one model-free production-host launch for a current execution owner. */
export function fixturePrepare(
  root: string,
  owner: FixtureOwner,
  scenario: FixtureScenario,
  coordinator: LocalProcessIdentity,
): PrepareExecution {
  const workspace: WorkspaceRef = {
    id: "execution-host-fixture",
    mode: "isolated",
    repoRoot: root,
    path: root,
    baseCommit: "fixture",
    branch: "fixture",
  };
  const common = {
    runId: "execution-host-fixture",
    executionId: randomUUID(),
    generation: 1,
    coordinator,
  };
  if (owner === "command") {
    return createPrepareExecution({
      ...common,
      command: {
        argv: [
          process.execPath,
          fileURLToPath(new URL("fixture-worker.mjs", import.meta.url)),
          scenario,
          owner,
        ],
        cwd: ".",
        maxDurationMs: 30_000,
        maxOutputBytes: 64 * 1024,
      },
      workspace,
    });
  }
  const descriptor: RuntimeDescriptor = {
    version: "anastom.dev/runtime-descriptor/v1alpha1",
    runtimeId: owner,
    configurationVersion: "fixture-v1",
    configuration: { scenario },
  };
  const request: ExecutionRequest = {
    runId: common.runId,
    workflowInstanceId: `${common.runId}:root`,
    nodeId: "work",
    nodeKind: "agent",
    attempt: 1,
    workspace,
    context: {
      inputs: {},
      dependencyOutputs: {},
      task: {
        id: "execution-host-fixture",
        version: "0.1.0",
        objective: "Exercise the model-free execution host",
        acceptanceCriteria: ["fixture completes through the shared supervisor"],
      },
    },
    budget: { maxAttempts: 2, maxDurationMs: 30_000 },
    requiredOutputSchema: structuredClone(workerReportSchema),
    toolPolicy: { allowMutations: true },
  };
  return createPrepareExecution({ ...common, descriptor, request });
}
