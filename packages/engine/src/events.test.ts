import { describe, expect, it } from "vitest";

import {
  InMemoryRunPersistence,
  InvalidTransitionError,
  PersistenceConflictError,
  applyRunEvent,
  materializeEvents,
  replayRun,
  type RunEvent,
} from "./index.js";

const created: RunEvent = {
  type: "RunCreated",
  runId: "run",
  sequence: 1,
  workflowInstanceId: "run:root",
  workflowId: "test/workflow",
  workflowVersion: "0.1.0",
  nodeIds: ["work"],
  inputs: {},
};

describe("event transitions", () => {
  it("rejects invalid node transitions", () => {
    const state = applyRunEvent(undefined, created);
    expect(() =>
      applyRunEvent(state, { type: "NodeSucceeded", runId: "run", sequence: 2, nodeId: "work" }),
    ).toThrow(InvalidTransitionError);
  });

  it("rejects gaps and duplicate events during replay", () => {
    expect(() =>
      replayRun([
        created,
        {
          type: "NodeReady",
          runId: "run",
          sequence: 3,
          nodeId: "work",
          reason: "dependencies-satisfied",
        },
      ]),
    ).toThrow("Expected event sequence 2");
  });

  it("represents paused and cancelled node states through typed events", () => {
    const transition = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      { type: "RunPaused" },
      { type: "NodePaused", nodeId: "work" },
      { type: "RunResumed" },
      { type: "NodeReady", nodeId: "work", reason: "resumed" },
      { type: "NodeCancelled", nodeId: "work", reason: "test" },
      { type: "RunCancelled", reason: "test" },
    ]);
    expect(transition.state.status).toBe("cancelled");
    expect(transition.state.nodes.work?.status).toBe("cancelled");
  });
});

describe("InMemoryRunPersistence", () => {
  it("round-trips event state and enforces optimistic sequence checks", async () => {
    const persistence = new InMemoryRunPersistence();
    const workflow = {
      apiVersion: "anastom.dev/v1alpha1" as const,
      kind: "Workflow" as const,
      metadata: { id: "test/workflow", version: "0.1.0" },
      sourcePath: "/tmp/workflow.yaml",
      inputs: {},
      policies: { defaultAttemptBudget: { maxAttempts: 1 } },
      nodeOrder: ["work"],
      nodes: {
        work: {
          id: "work",
          kind: "command" as const,
          needs: [],
          output: { ref: "output.json", schema: { type: "object" } },
          attemptBudget: { maxAttempts: 1 },
        },
      },
    };
    await persistence.create("run", { workflow, events: [created] });
    const loaded = await persistence.load("run");
    expect(loaded?.events).toEqual([created]);
    loaded?.events.push({ ...created, sequence: 2 });
    expect((await persistence.load("run"))?.events).toHaveLength(1);
    await expect(persistence.append("run", 4, [])).rejects.toBeInstanceOf(PersistenceConflictError);
  });
});
