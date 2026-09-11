import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { InMemoryRunPersistence } from "@anastom/engine";

import { runCli } from "./index.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
}

const workflowPath = resolve("examples/workflows/demo-feature.yaml");
const scenarioPath = resolve("examples/fake/success.yaml");

describe("M0 CLI", () => {
  it("validates and graphs a workflow", async () => {
    const validation = capture();
    expect(await runCli(["validate", workflowPath], { io: validation.io })).toBe(0);
    expect(validation.stdout[0]).toBe("valid demo/feature@0.1.0 (3 nodes)");

    const graph = capture();
    expect(await runCli(["graph", workflowPath], { io: graph.io })).toBe(0);
    expect(graph.stdout[0]).toContain("implement [agent] -> verify");
  });

  it("runs and inspects a workflow through shared process-local persistence", async () => {
    const persistence = new InMemoryRunPersistence();
    const run = capture();
    expect(
      await runCli(["run", workflowPath, "--fake-scenario", scenarioPath], { io: run.io, persistence }),
    ).toBe(0);
    expect(run.stdout[0]).toContain("[succeeded]");
    const runId = /^Run ([^ ]+)/.exec(run.stdout[0] ?? "")?.[1];
    expect(runId).toBeDefined();

    const inspect = capture();
    expect(await runCli(["inspect", runId as string], { io: inspect.io, persistence })).toBe(0);
    expect(inspect.stdout[0]).toEqual(run.stdout[0]);
  });

  it("returns usage errors without throwing", async () => {
    const output = capture();
    expect(await runCli(["run", workflowPath], { io: output.io })).toBe(1);
    expect(output.stderr[0]).toContain("--fake-scenario");
  });
});
