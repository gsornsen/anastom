import { describe, expect, it } from "vitest";
import { probeRuntime } from "@anastom/runtime-contract";
import { FakeRuntimeAdapter } from "@anastom/runtime-fake";

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

  it("replays negotiated identity and partial usage once without changing acceptance", async () => {
    const negotiation = await probeRuntime(new FakeRuntimeAdapter({ nodes: {} }), "isolated");
    const transition = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "RuntimeNegotiated", negotiation },
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "fake" },
      { type: "AttemptStarted", nodeId: "work", attempt: 1 },
      {
        type: "RuntimeEventObserved",
        nodeId: "work",
        attempt: 1,
        event: { type: "metadata", provider: "fixture", model: "fixture", source: "configured" },
      },
      {
        type: "RuntimeEventObserved",
        nodeId: "work",
        attempt: 1,
        event: {
          type: "usage",
          scope: "attempt",
          coverage: "partial",
          inputTokens: 100,
          cacheReadTokens: 20,
        },
      },
      { type: "AttemptSucceeded", nodeId: "work", attempt: 1, output: { accepted: true } },
      { type: "NodeSucceeded", nodeId: "work" },
      { type: "RunCompleted", outcome: "succeeded" },
    ]);
    const replayed = replayRun([created, ...transition.events]);
    expect(replayed.runtimeNegotiation).toEqual(negotiation);
    expect(replayed.nodes.work?.attempts[0]?.identity).toEqual([
      { type: "metadata", provider: "fixture", model: "fixture", source: "configured" },
    ]);
    expect(replayed.nodes.work?.attempts[0]?.usage).toMatchObject({
      coverage: "partial",
      inputTokens: 100,
      cacheReadTokens: 20,
    });
    expect(replayed.nodes.work?.output).toEqual({ accepted: true });
    expect(() =>
      applyRunEvent(replayRun([created, ...transition.events.slice(0, 6)]), {
        type: "RuntimeEventObserved",
        runId: "run",
        sequence: 8,
        nodeId: "work",
        attempt: 1,
        event: { type: "usage", scope: "attempt", coverage: "partial", outputTokens: 5 },
      }),
    ).toThrow("only one final usage");
  });

  it("replays old records without negotiation or identity provenance and leaves event bytes intact", () => {
    const oldEvents: RunEvent[] = [
      created,
      {
        type: "NodeReady",
        runId: "run",
        sequence: 2,
        nodeId: "work",
        reason: "dependencies-satisfied",
      },
      {
        type: "AttemptScheduled",
        runId: "run",
        sequence: 3,
        nodeId: "work",
        attempt: 1,
        runtimeId: "pi",
      },
      { type: "AttemptStarted", runId: "run", sequence: 4, nodeId: "work", attempt: 1 },
      {
        type: "RuntimeEventObserved",
        runId: "run",
        sequence: 5,
        nodeId: "work",
        attempt: 1,
        event: { type: "metadata", provider: "anthropic", model: "legacy" },
      },
      {
        type: "AttemptSucceeded",
        runId: "run",
        sequence: 6,
        nodeId: "work",
        attempt: 1,
        output: {},
      },
      { type: "NodeSucceeded", runId: "run", sequence: 7, nodeId: "work" },
      { type: "RunCompleted", runId: "run", sequence: 8, outcome: "succeeded" },
    ];
    const bytes = oldEvents.map((event) => JSON.stringify(event));
    const replayed = replayRun(oldEvents);
    expect(replayed.status).toBe("succeeded");
    expect(replayed.runtimeNegotiation).toBeUndefined();
    expect(replayed.nodes.work?.attempts[0]?.identity).toEqual([
      { type: "metadata", provider: "anthropic", model: "legacy" },
    ]);
    expect(replayed.nodes.work?.attempts[0]?.usage).toBeUndefined();
    expect(oldEvents.map((event) => JSON.stringify(event))).toEqual(bytes);
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
