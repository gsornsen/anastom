import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@anastom/core";

import {
  applyRunEvent,
  materializeEvents,
  LiveRunProjector,
  projectEvidenceLedger,
  projectLiveRunEvents,
  replayRun,
  type RunEvent,
} from "./index.js";

const hash = `sha256:${"a".repeat(64)}`;
const privateSentinel = "PRIVATE_SENTINEL_MUST_NOT_APPEAR";

const workflow: WorkflowDefinition = {
  apiVersion: "anastom.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "test/projection", version: "0.1.0" },
  sourcePath: "/repo/workflow.yaml",
  inputs: {},
  policies: { defaultAttemptBudget: { maxAttempts: 1 }, maxParallel: 1 },
  nodeOrder: ["work", "verify"],
  nodes: {
    work: {
      id: "work",
      kind: "agent",
      needs: [],
      role: "implementer",
      output: { ref: "report.json", schema: { type: "object" } },
      attemptBudget: { maxAttempts: 1 },
      mutation: "isolated",
    },
    verify: {
      id: "verify",
      kind: "verifier",
      needs: ["work"],
      output: { ref: "command.json", schema: { type: "object" } },
      attemptBudget: { maxAttempts: 1 },
      mutation: "readonly",
    },
  },
};

function artifact(id: string, type: string, attempt: number) {
  return {
    id,
    type,
    mediaType: "application/json",
    uri: `artifact://${id}`,
    digest: hash,
    producer: { runId: "projection-run", nodeId: "work", attempt },
  };
}

function projectionHistory(): RunEvent[] {
  const created: RunEvent = {
    type: "RunCreated",
    runId: "projection-run",
    sequence: 1,
    workflowInstanceId: "projection-run:root",
    workflowId: workflow.metadata.id,
    workflowVersion: workflow.metadata.version,
    nodeIds: [...workflow.nodeOrder],
    inputs: { private: privateSentinel },
  };
  const transition = materializeEvents(applyRunEvent(undefined, created), created.runId, [
    { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
    { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "fixture" },
    { type: "AttemptStarted", nodeId: "work", attempt: 1 },
    {
      type: "ArtifactProduced",
      nodeId: "work",
      attempt: 1,
      artifact: artifact("context", "context", 1),
    },
    {
      type: "RuntimeEventObserved",
      nodeId: "work",
      attempt: 1,
      event: { type: "metadata", provider: "fixture", model: "fixture-model", source: "reported" },
    },
    {
      type: "RuntimeEventObserved",
      nodeId: "work",
      attempt: 1,
      event: { type: "log", message: `line one\n${"🙂".repeat(1_100)}`, droppedLogs: 7 },
    },
    {
      type: "RuntimeEventObserved",
      nodeId: "work",
      attempt: 1,
      event: { type: "usage", scope: "attempt", coverage: "partial", inputTokens: 12 },
    },
    {
      type: "ArtifactProduced",
      nodeId: "work",
      attempt: 1,
      artifact: artifact("report", "worker-report", 1),
    },
    {
      type: "ArtifactProduced",
      nodeId: "work",
      attempt: 1,
      artifact: artifact("diff", "workspace-diff", 1),
    },
    {
      type: "WorkspaceObserved",
      nodeId: "work",
      attempt: 1,
      headCommit: "b".repeat(40),
      changedFiles: ["src/change.ts"],
      diffArtifactId: "diff",
    },
    {
      type: "AttemptSucceeded",
      nodeId: "work",
      attempt: 1,
      output: { privateReasoning: privateSentinel },
    },
    { type: "NodeSucceeded", nodeId: "work" },
    { type: "NodeReady", nodeId: "verify", reason: "dependencies-satisfied" },
  ]);
  return [created, ...transition.events];
}

function pressureHistory(): RunEvent[] {
  const created: RunEvent = {
    type: "RunCreated",
    runId: "projection-run",
    sequence: 1,
    workflowInstanceId: "projection-run:root",
    workflowId: workflow.metadata.id,
    workflowVersion: workflow.metadata.version,
    nodeIds: [...workflow.nodeOrder],
    inputs: {},
  };
  const transition = materializeEvents(applyRunEvent(undefined, created), created.runId, [
    { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
    { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "fixture" },
    { type: "AttemptStarted", nodeId: "work", attempt: 1 },
    ...Array.from({ length: 140 }, (_, index) => ({
      type: "RuntimeEventObserved" as const,
      nodeId: "work",
      attempt: 1,
      event: { type: "log" as const, message: `public message ${index}` },
    })),
    { type: "AttemptSucceeded", nodeId: "work", attempt: 1, output: {} },
    { type: "NodeSucceeded", nodeId: "work" },
  ]);
  return [created, ...transition.events];
}

describe("durable evidence projections", () => {
  it("derives actor, context, output, workspace, usage, and dependency evidence", () => {
    const history = projectionHistory();
    const ledger = projectEvidenceLedger(workflow, history);
    const work = ledger.phases[0]!;
    const verify = ledger.phases[1]!;

    expect(ledger).toMatchObject({
      version: "anastom.dev/evidence-ledger/v1alpha1",
      runId: "projection-run",
      throughSequence: history.at(-1)?.sequence,
      decision: "running",
    });
    expect(work).toMatchObject({
      nodeId: "work",
      phase: "execution",
      decision: "succeeded",
      actor: {
        kind: "runtime",
        runtimeIds: ["fixture"],
        identities: [{ provider: "fixture", model: "fixture-model" }],
      },
    });
    expect(work.attempts[0]).toMatchObject({
      decision: "succeeded",
      inputContextDigest: hash,
      identities: [{ provider: "fixture", model: "fixture-model", source: "reported" }],
      usage: { inputTokens: 12 },
      outputReport: { id: "report", digest: hash },
      workspace: {
        headCommit: "b".repeat(40),
        changedFiles: ["src/change.ts"],
        diffArtifactId: "diff",
      },
    });
    expect(verify.permittedBy).toEqual([
      { nodeId: "work", decision: "succeeded", sequence: history.at(-2)?.sequence },
    ]);
  });

  it("bounds log messages, accounts for dropped messages, and excludes private fields", () => {
    const projected = projectLiveRunEvents(workflow, projectionHistory());
    const log = projected.find((event) => event.type === "log");

    expect(log).toMatchObject({
      type: "log",
      droppedMessages: 7,
      messageTruncated: true,
    });
    expect(log?.type === "log" ? Buffer.byteLength(log.message) : 0).toBeLessThanOrEqual(2_048);
    expect(log?.type === "log" ? log.message : "").not.toContain("\n");
    expect(JSON.stringify(projected)).not.toContain(privateSentinel);
  });

  it("matches a reconnect replay with observations collected from growing durable prefixes", () => {
    const history = projectionHistory();
    const observed = new Map<number, ReturnType<typeof projectLiveRunEvents>[number]>();
    for (let length = 1; length <= history.length; length++) {
      for (const event of projectLiveRunEvents(workflow, history.slice(0, length))) {
        observed.set(event.sequence, event);
      }
    }
    expect([...observed.values()]).toEqual(projectLiveRunEvents(workflow, history));
  });

  it("bounds pressure logs and produces the same exact dropped count live and on replay", () => {
    const history = pressureHistory();
    const replayed = projectLiveRunEvents(workflow, history);
    const projector = new LiveRunProjector(workflow);
    const streamed = history.flatMap((event, index) =>
      projector.project(replayRun(history.slice(0, index + 1)), [event]),
    );
    const logs = replayed.filter((event) => event.type === "log");

    expect(streamed).toEqual(replayed);
    expect(logs).toHaveLength(130);
    expect(logs.reduce((total, event) => total + (event.droppedMessages ?? 0), 0)).toBe(12);
    expect(
      logs.filter((event) => event.message === "Additional public runtime messages omitted"),
    ).toHaveLength(2);
  });
});
