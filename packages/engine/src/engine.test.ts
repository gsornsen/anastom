import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  loadWorkflow,
  normalizeWorkflow,
  parseWorkflowYaml,
  type JsonSchema,
  type WorkflowDefinition,
} from "@anastom/core";
import { FakeRuntimeAdapter, type FakeScenario } from "@anastom/runtime-fake";

import {
  InMemoryRunPersistence,
  WorkflowEngine,
  applyRunEvent,
  findExecutableNodes,
  renderRunStatus,
  renderWorkflowGraph,
  type RunEvent,
} from "./index.js";

let workflow: WorkflowDefinition;

beforeAll(async () => {
  workflow = await loadWorkflow(resolve("examples/workflows/demo-feature.yaml"));
});

function verification(passed: boolean) {
  return {
    passed,
    checks: [
      {
        id: "acceptance",
        passed,
        evidence: ["fake:test-output"],
        summary: passed ? "passed" : "failed",
      },
    ],
  };
}

function successScenario(): FakeScenario {
  return {
    nodes: {
      analyze: [{ output: { summary: "bounded path" } }],
      implement: [{ output: { changedFiles: ["src/feature.ts"] } }],
      verify: [{ output: verification(true) }],
    },
  };
}

function engineFor(scenario: FakeScenario, persistence = new InMemoryRunPersistence()): WorkflowEngine {
  return new WorkflowEngine({ runtime: new FakeRuntimeAdapter(scenario), persistence });
}

describe("dependency scheduling", () => {
  it("identifies only nodes whose dependencies have succeeded", () => {
    const created: RunEvent = {
      type: "RunCreated",
      runId: "schedule",
      sequence: 1,
      workflowInstanceId: "schedule:root",
      workflowId: workflow.metadata.id,
      workflowVersion: workflow.metadata.version,
      nodeIds: [...workflow.nodeOrder],
      inputs: {},
    };
    const state = applyRunEvent(undefined, created);
    expect(findExecutableNodes(workflow, state)).toEqual(["analyze"]);
  });
});

describe("WorkflowEngine", () => {
  it("executes every M0 node kind through the fake boundary", async () => {
    const document = parseWorkflowYaml(`
apiVersion: anastom.dev/v1alpha1
kind: Workflow
metadata: { id: test/all-kinds, version: 0.1.0 }
inputs: {}
nodes:
  agent: { kind: agent, role: worker, output: { schema: output.json } }
  command: { kind: command, needs: [agent], output: { schema: output.json } }
  gate: { kind: gate, needs: [command], output: { schema: output.json } }
  verifier: { kind: verifier, needs: [gate], output: { schema: verifier.json } }
`);
    const allKinds = await normalizeWorkflow(document, {
      sourcePath: "/tmp/all-kinds.yaml",
      loadSchema: async (path): Promise<JsonSchema> =>
        path.endsWith("verifier.json")
          ? { type: "object", required: ["passed"], properties: { passed: { type: "boolean" } } }
          : { type: "object" },
    });
    const scenario: FakeScenario = {
      nodes: {
        agent: [{ output: {} }],
        command: [{ output: {} }],
        gate: [{ output: {} }],
        verifier: [{ output: { passed: true } }],
      },
    };
    const state = await engineFor(scenario).start(allKinds, { runId: "all-kinds" });
    expect(state.status).toBe("succeeded");
    expect(Object.values(state.nodes).map((node) => node.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("executes a successful fake run and renders inspectable status", async () => {
    const state = await engineFor(successScenario()).start(workflow, { runId: "success" });

    expect(state.status).toBe("succeeded");
    expect(Object.values(state.nodes).map((node) => node.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(renderRunStatus(state, workflow)).toContain("verify: succeeded attempts=1");
    expect(renderWorkflowGraph(workflow)).toContain("analyze [agent] -> implement");
  });

  it("rejects schema-invalid output and retries with a fresh scripted result", async () => {
    const scenario = successScenario();
    scenario.nodes.analyze = [
      { output: { summary: 42 } },
      { output: { summary: "valid on retry" } },
    ];
    const state = await engineFor(scenario).start(workflow, { runId: "schema-retry" });

    expect(state.status).toBe("succeeded");
    expect(state.nodes.analyze?.attempts).toHaveLength(2);
    expect(state.nodes.analyze?.attempts[0]?.failure?.category).toBe("schema-violation");
    expect(state.nodes.analyze?.output).toEqual({ summary: "valid on retry" });
  });

  it("fails after retry exhaustion and blocks unexecuted nodes", async () => {
    const scenario: FakeScenario = {
      nodes: {
        analyze: [
          { outcome: "failed", failure: { category: "tool", message: "failure one" } },
          { outcome: "failed", failure: { category: "tool", message: "failure two" } },
        ],
      },
    };
    const state = await engineFor(scenario).start(workflow, { runId: "exhausted" });

    expect(state.status).toBe("failed");
    expect(state.nodes.analyze?.status).toBe("failed");
    expect(state.nodes.analyze?.attempts).toHaveLength(2);
    expect(state.nodes.implement?.status).toBe("blocked");
    expect(state.nodes.verify?.status).toBe("blocked");
  });

  it("treats verifier pass/fail as a deterministic retry decision", async () => {
    const scenario = successScenario();
    scenario.nodes.verify = [{ output: verification(false) }, { output: verification(true) }];
    const state = await engineFor(scenario).start(workflow, { runId: "verifier-retry" });

    expect(state.status).toBe("succeeded");
    expect(state.nodes.verify?.attempts).toHaveLength(2);
    expect(state.nodes.verify?.attempts[0]?.failure?.category).toBe("verification");

    scenario.nodes.verify = [{ output: verification(false) }, { output: verification(false) }];
    const failed = await engineFor(scenario).start(workflow, { runId: "verifier-failed" });
    expect(failed.status).toBe("failed");
    expect(failed.nodes.verify?.failure?.category).toBe("verification");
  });

  it("emits an identical typed event sequence for identical inputs", async () => {
    const first = engineFor(successScenario());
    const second = engineFor(successScenario());
    await first.start(workflow, { runId: "deterministic" });
    await second.start(workflow, { runId: "deterministic" });
    const firstEvents = await first.events("deterministic");
    const secondEvents = await second.events("deterministic");

    expect(firstEvents).toEqual(secondEvents);
    expect(firstEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: firstEvents.length }, (_, index) => index + 1),
    );
  });

  it("reloads event state in a new engine and continues execution", async () => {
    const persistence = new InMemoryRunPersistence();
    const first = engineFor(successScenario(), persistence);
    const created = await first.createRun(workflow, { runId: "reload" });
    expect(created.nodes.analyze?.status).toBe("ready");
    const partial = await first.tick("reload");
    expect(partial.nodes.analyze?.status).toBe("succeeded");
    expect(partial.nodes.implement?.status).toBe("ready");

    const second = engineFor(successScenario(), persistence);
    const completed = await second.resume("reload");
    expect(completed.status).toBe("succeeded");
    await expect(second.inspect("reload")).resolves.toEqual(completed);
  });

  it("propagates a scripted block to the run", async () => {
    const scenario: FakeScenario = {
      nodes: { analyze: [{ outcome: "blocked", reason: "human input required" }] },
    };
    const state = await engineFor(scenario).start(workflow, { runId: "blocked" });
    expect(state.status).toBe("blocked");
    expect(state.nodes.analyze?.status).toBe("blocked");
    expect(state.nodes.analyze?.attempts[0]?.status).toBe("blocked");
  });

  it("validates declared workflow inputs before creating state", async () => {
    const document = parseWorkflowYaml(`
apiVersion: anastom.dev/v1alpha1
kind: Workflow
metadata: { id: test/inputs, version: 0.1.0 }
inputs:
  issue: { schema: input.json }
nodes:
  work: { kind: command, output: { schema: output.json } }
`);
    const inputWorkflow = await normalizeWorkflow(document, {
      sourcePath: "/tmp/inputs.yaml",
      loadSchema: async (path): Promise<JsonSchema> =>
        path.endsWith("input.json") ? { type: "string", minLength: 1 } : { type: "object" },
    });
    const engine = engineFor({ nodes: { work: [{ output: {} }] } });
    await expect(engine.createRun(inputWorkflow, { runId: "missing-input" })).rejects.toThrow(
      "missing workflow inputs: issue",
    );
    await expect(
      engine.createRun(inputWorkflow, { runId: "bad-input", inputs: { issue: "" } }),
    ).rejects.toThrow("input issue");
  });
});
