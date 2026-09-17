import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileSdlcFeature,
  expandSdlcPlan,
  loadSdlcMethodology,
  normalizeFeature,
  normalizeFeaturePlan,
  parseFeatureMarkdown,
} from "@anastom/core";
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
  findExecutableNodes,
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
    expect(() =>
      applyRunEvent(state, {
        type: "NodeReady",
        runId: "run",
        sequence: 2,
        nodeId: "constructor",
        reason: "dependencies-satisfied",
      }),
    ).toThrow('Unknown node "constructor"');
  });

  it("assigns a node workspace once before that node starts", () => {
    const state = applyRunEvent(undefined, created);
    const assigned = applyRunEvent(state, {
      type: "NodeWorkspaceAssigned",
      runId: "run",
      sequence: 2,
      nodeId: "work",
      workspace: {
        id: "work-space",
        mode: "readonly",
        repoRoot: "/repo",
        path: "/repo",
        baseCommit: "base",
      },
    });
    expect(assigned.nodeWorkspaces?.work).toMatchObject({ id: "work-space", mode: "readonly" });
    expect(() =>
      applyRunEvent(assigned, {
        type: "NodeWorkspaceAssigned",
        runId: "run",
        sequence: 3,
        nodeId: "work",
        workspace: {
          id: "replacement",
          mode: "readonly",
          repoRoot: "/repo",
          path: "/repo",
          baseCommit: "base",
        },
      }),
    ).toThrow("Node workspace can only be assigned once");
  });

  it("folds one validated planner expansion into deterministic scheduling", async () => {
    const feature = normalizeFeature(
      parseFeatureMarkdown(`---
apiVersion: anastom.dev/v1alpha1
kind: Feature
metadata: {id: test/expanded, version: 0.1.0}
acceptanceCriteria: [Both independent changes are present]
verification:
  - id: test
    argv: [pnpm, test]
    maxDuration: 1m
policies: {maxTasks: 2, maxParallel: 2}
---
Implement two independent changes and verify their integrated result.
`),
      "/tmp/expanded-feature.md",
    );
    const methodology = await loadSdlcMethodology(resolve("methodologies/sdlc/default"));
    const workflow = compileSdlcFeature(feature, methodology, { protectedPaths: ["feature.md"] });
    const plan = normalizeFeaturePlan(
      {
        summary: "Implement two independent files before deterministic integration.",
        tasks: [
          {
            id: "left",
            title: "Left change",
            objective: "Implement the complete left-side change.",
            acceptanceCriteria: ["Left behavior is present"],
            dependsOn: [],
            mutationScopes: ["left.txt"],
          },
          {
            id: "right",
            title: "Right change",
            objective: "Implement the complete right-side change.",
            acceptanceCriteria: ["Right behavior is present"],
            dependsOn: [],
            mutationScopes: ["right.txt"],
          },
        ],
        risks: [],
      },
      feature.policies,
    );
    const start: RunEvent = {
      ...created,
      workflowId: workflow.metadata.id,
      workflowVersion: workflow.metadata.version,
      nodeIds: [...workflow.nodeOrder],
    };
    const planned = materializeEvents(applyRunEvent(undefined, start), "run", [
      { type: "NodeReady", nodeId: "analysis", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "analysis", attempt: 1, runtimeId: "fake" },
      { type: "AttemptStarted", nodeId: "analysis", attempt: 1 },
      { type: "AttemptSucceeded", nodeId: "analysis", attempt: 1, output: { accepted: true } },
      { type: "NodeSucceeded", nodeId: "analysis" },
      { type: "NodeReady", nodeId: "planning", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "planning", attempt: 1, runtimeId: "fake" },
      { type: "AttemptStarted", nodeId: "planning", attempt: 1 },
      { type: "AttemptSucceeded", nodeId: "planning", attempt: 1, output: { accepted: true } },
      { type: "NodeSucceeded", nodeId: "planning" },
      {
        type: "WorkflowExpanded",
        sourceNodeId: "planning",
        plan,
        expansion: expandSdlcPlan(feature, methodology, plan),
      },
    ]).state;

    expect(findExecutableNodes(workflow, planned)).toEqual(["implement.left", "implement.right"]);
    expect(() =>
      applyRunEvent(planned, {
        type: "WorkflowExpanded",
        runId: "run",
        sequence: planned.sequence + 1,
        sourceNodeId: "planning",
        plan,
        expansion: expandSdlcPlan(feature, methodology, plan),
      }),
    ).toThrow("can occur once");
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

  it("replays the checked-in baseline history without rewriting its records", async () => {
    const fixture = new URL(
      "./testing/fixtures/baseline-run-events.v1alpha1.json",
      import.meta.url,
    );
    const baselineEvents = JSON.parse(await readFile(fixture, "utf8")) as RunEvent[];
    const bytes = baselineEvents.map((event) => JSON.stringify(event));
    const replayed = replayRun(baselineEvents);
    expect(replayed.status).toBe("succeeded");
    expect(replayed.runtimeNegotiation).toBeUndefined();
    expect(replayed.nodes.work?.attempts[0]?.identity).toEqual([
      { type: "metadata", provider: "anthropic", model: "baseline" },
    ]);
    expect(replayed.nodes.work?.attempts[0]?.usage).toBeUndefined();
    expect(baselineEvents.map((event) => JSON.stringify(event))).toEqual(bytes);
  });

  it("replays prepared execution ownership, orphan recovery and exact control evidence", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const checkpoint = {
      version: "anastom.dev/workspace-checkpoint/v1alpha1" as const,
      workspaceId: "workspace",
      baseCommit: "base",
      headCommit: "head",
      diffDigest: hash,
      changedFiles: [],
      ignoredDigest: hash,
      ignoredEntryCount: 0,
      ignoredByteCount: 0,
      ownership: {
        repositoryRoot: "/repo",
        repositoryCommonDirectory: "/repo/.git",
        workspacePath: "/repo/worktree",
        workspaceGitDirectory: "/repo/.git/worktrees/worktree",
        branch: "anastom/run",
        manifestDigest: hash,
        registrationDigest: hash,
      },
    };
    const plan = {
      version: "anastom.dev/owned-execution/v1alpha1" as const,
      runId: "run",
      executionId: "execution-1",
      kind: "runtime" as const,
      generation: 1,
      planDigest: hash,
    };
    const descriptor = {
      version: "anastom.dev/runtime-descriptor/v1alpha1" as const,
      runtimeId: "pi",
      configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1",
      configuration: { provider: "anthropic", model: "fixture" },
    };
    const scheduled = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "RuntimeConfigured", descriptor },
      {
        type: "WorkspaceAssigned",
        workspace: {
          id: "workspace",
          mode: "isolated",
          repoRoot: "/repo",
          path: "/repo/worktree",
          baseCommit: "base",
          branch: "anastom/run",
        },
      },
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "pi" },
    ]).state;
    expect(() =>
      applyRunEvent(scheduled, {
        type: "AttemptPrepared",
        runId: "run",
        sequence: scheduled.sequence + 1,
        nodeId: "work",
        attempt: 1,
        execution: plan,
        workspaceCheckpoint: { ...checkpoint, credential: "secret" },
      } as unknown as RunEvent),
    ).toThrow("Corrupt run event AttemptPrepared");
    const transition = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "RuntimeConfigured", descriptor },
      {
        type: "WorkspaceAssigned",
        workspace: {
          id: "workspace",
          mode: "isolated",
          repoRoot: "/repo",
          path: "/repo/worktree",
          baseCommit: "base",
          branch: "anastom/run",
        },
      },
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "pi" },
      {
        type: "AttemptPrepared",
        nodeId: "work",
        attempt: 1,
        execution: plan,
        workspaceCheckpoint: checkpoint,
      },
      {
        type: "AttemptStartAuthorized",
        nodeId: "work",
        attempt: 1,
        execution: { ...plan, manifestDigest: hash },
      },
      {
        type: "ControlRequestObserved",
        operationId: "resume-1",
        action: "pause",
        recordedAtMs: 1,
      },
      {
        type: "ExecutionCleanupObserved",
        nodeId: "work",
        attempt: 1,
        executionId: "execution-1",
        cause: "recovery",
        outcome: "confirmed",
      },
      {
        type: "AttemptOrphaned",
        nodeId: "work",
        attempt: 1,
        executionId: "execution-1",
        lostGeneration: 1,
        reason: "coordinator-lost",
        workspaceObservation: checkpoint,
        workspaceDifferences: [],
      },
      { type: "NodeReady", nodeId: "work", reason: "recovered" },
      {
        type: "RunRecoveryBlocked",
        operationId: "resume-2",
        reason: {
          kind: "execution-unknown",
          executionId: "execution-1",
          detail: "supervisor-lost",
        },
      },
      { type: "RunResumed", operationId: "resume-3" },
    ]);
    const replayed = replayRun([created, ...transition.events]);
    expect(replayed.status).toBe("running");
    expect(replayed.runtimeDescriptor).toEqual(descriptor);
    expect(replayed.nodes.work?.attempts[0]).toMatchObject({
      status: "orphaned",
      executionPlan: plan,
      execution: { ...plan, manifestDigest: hash },
      workspaceCheckpoint: checkpoint,
      orphan: { executionId: "execution-1", workspaceDifferences: [] },
      cleanup: [{ executionId: "execution-1", cause: "recovery", outcome: "confirmed" }],
    });
  });

  it("keeps baseline lifecycle shapes exact while accepting typed pause reasons", () => {
    const ready = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      {
        type: "NodePaused",
        nodeId: "work",
        reason: { kind: "operator", operationId: "pause-1" },
      },
      {
        type: "RunPaused",
        reason: { kind: "operator", operationId: "pause-1" },
      },
    ]);
    expect(ready.state.pauseReason).toEqual({ kind: "operator", operationId: "pause-1" });
    expect(ready.state.nodes.work?.pauseReason).toEqual({
      kind: "operator",
      operationId: "pause-1",
    });
    expect(() =>
      applyRunEvent(applyRunEvent(undefined, created), {
        type: "RunPaused",
        runId: "run",
        sequence: 2,
        reason: { kind: "operator", operationId: "pause-1" },
        extra: true,
      } as unknown as RunEvent),
    ).toThrow("Corrupt run event RunPaused");
  });

  it("uses the same prepared ownership contract for command executions", () => {
    const hash = `sha256:${"b".repeat(64)}`;
    const transition = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "command" },
      {
        type: "AttemptPrepared",
        nodeId: "work",
        attempt: 1,
        execution: {
          version: "anastom.dev/owned-execution/v1alpha1",
          runId: "run",
          executionId: "command-1",
          kind: "command",
          generation: 1,
          planDigest: hash,
        },
        workspaceCheckpoint: {
          version: "anastom.dev/workspace-checkpoint/v1alpha1",
          workspaceId: "workspace",
          baseCommit: "base",
          headCommit: "head",
          diffDigest: hash,
          changedFiles: [],
          ignoredDigest: hash,
          ignoredEntryCount: 0,
          ignoredByteCount: 0,
          ownership: {
            repositoryRoot: "/repo",
            repositoryCommonDirectory: "/repo/.git",
            workspacePath: "/repo/worktree",
            workspaceGitDirectory: "/repo/.git/worktrees/worktree",
            branch: "anastom/run",
            manifestDigest: hash,
            registrationDigest: hash,
          },
        },
      },
    ]);
    expect(transition.state.nodes.work?.attempts[0]).toMatchObject({
      status: "prepared",
      executionPlan: { kind: "command", executionId: "command-1" },
    });
  });

  it("enforces the runtime descriptor byte bound before replay", () => {
    expect(() =>
      applyRunEvent(applyRunEvent(undefined, created), {
        type: "RuntimeConfigured",
        runId: "run",
        sequence: 2,
        descriptor: {
          version: "anastom.dev/runtime-descriptor/v1alpha1",
          runtimeId: "pi",
          configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1",
          configuration: { model: "x".repeat(17 * 1024) },
        },
      }),
    ).toThrow("invalid runtime descriptor");
  });

  it("rejects durable pause or cancellation while a node is still active", () => {
    const active = materializeEvents(applyRunEvent(undefined, created), "run", [
      { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
      { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "pi" },
      { type: "AttemptStarted", nodeId: "work", attempt: 1 },
    ]).state;
    expect(() =>
      materializeEvents(active, "run", [
        {
          type: "RunPaused",
          reason: { kind: "operator", operationId: "pause-1" },
        },
      ]),
    ).toThrow("requires every active node to stop");
    expect(() =>
      materializeEvents(active, "run", [
        { type: "RunCancelled", operationId: "cancel-1", reason: "operator" },
      ]),
    ).toThrow("requires every nonterminal node to be cancelled");
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
      policies: { defaultAttemptBudget: { maxAttempts: 1 }, maxParallel: 1 },
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
