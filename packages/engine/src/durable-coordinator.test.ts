import { randomUUID } from "node:crypto";

import { canonicalJson, digestBytes, type WorkflowDefinition } from "@anastom/core";
import { FakeRuntimeAdapter } from "@anastom/runtime-fake";
import {
  assertRuntimeDescriptor,
  probeRuntime,
  type ArtifactRef,
  type ExecutionResult,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type WorkspaceCheckpoint,
  type WorkspaceDifference,
  type WorkspaceRef,
} from "@anastom/runtime-contract";
import { describe, expect, it, vi } from "vitest";

import {
  DurableRunCoordinator,
  InMemoryDurableRunStore,
  buildContext,
  createPrepareExecution,
  createRunSnapshot,
  materializeEvents,
  type ArtifactStore,
  type CommandExecution,
  type DurableWorkspaceBoundary,
  type ExecutionHost,
  type ExecutionObservation,
  type LocalProcessIdentity,
  type OwnedExecution,
  type PersistedExecutionRef,
  type PrepareExecution,
  type RunEventPayload,
  RunOwnershipBlockedError,
} from "./index.js";
import { OwnedRunSession } from "./durable-session.js";

const hash = `sha256:${"a".repeat(64)}`;
const descriptor: RuntimeDescriptor = {
  version: "anastom.dev/runtime-descriptor/v1alpha1",
  runtimeId: "fake",
  configurationVersion: "fixture-v1",
  configuration: {},
};
const workspace: Extract<WorkspaceRef, { mode: "isolated" }> = {
  id: "durable-workspace",
  mode: "isolated",
  repoRoot: "/repo",
  path: "/repo/worktree",
  baseCommit: "base",
  branch: "anastom/durable",
};
const owner: LocalProcessIdentity = {
  version: "anastom.dev/local-process/v1alpha1",
  hostIdentityDigest: hash,
  bootIdentityDigest: hash,
  pid: 100,
  startToken: "owner-start",
};
const oldOwner: LocalProcessIdentity = { ...owner, pid: 99, startToken: "old-start" };

const workflow: WorkflowDefinition = {
  apiVersion: "anastom.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "test/durable", version: "0.1.0" },
  sourcePath: "/fixture/workflow.yaml",
  inputs: {},
  policies: { defaultAttemptBudget: { maxAttempts: 2, maxDurationMs: 30_000 } },
  nodeOrder: ["work"],
  nodes: {
    work: {
      id: "work",
      kind: "agent",
      role: "worker",
      needs: [],
      mutation: "isolated",
      output: {
        ref: "output.json",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
      },
      attemptBudget: { maxAttempts: 2, maxDurationMs: 30_000 },
    },
  },
};

const commandWorkflow: WorkflowDefinition = {
  ...workflow,
  metadata: { id: "test/durable-command", version: "0.1.0" },
  nodes: {
    work: {
      id: "work",
      kind: "command",
      needs: [],
      output: {
        ref: "command-output.json",
        schema: {
          type: "object",
          required: ["passed"],
          properties: { passed: { type: "boolean" } },
        },
      },
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
      command: {
        argv: ["fixture-command"],
        cwd: ".",
        maxDurationMs: 30_000,
        maxOutputBytes: 1_024,
      },
    },
  },
};

const timeoutWorkflow: WorkflowDefinition = {
  ...workflow,
  metadata: { id: "test/durable-timeout", version: "0.1.0" },
  policies: { defaultAttemptBudget: { maxAttempts: 1, maxDurationMs: 20 } },
  nodes: {
    work: {
      ...workflow.nodes.work!,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 20 },
    },
  },
};

function checkpoint(label = "clean"): WorkspaceCheckpoint {
  const digest = digestBytes(label);
  return {
    version: "anastom.dev/workspace-checkpoint/v1alpha1",
    workspaceId: workspace.id,
    baseCommit: workspace.baseCommit,
    headCommit: label === "clean" ? "head" : `head-${label}`,
    diffDigest: digest,
    changedFiles: label === "clean" ? [] : [`${label}.txt`],
    ignoredDigest: hash,
    ignoredEntryCount: 0,
    ignoredByteCount: 0,
    ownership: {
      repositoryRoot: workspace.repoRoot,
      repositoryCommonDirectory: "/repo/.git",
      workspacePath: workspace.path,
      workspaceGitDirectory: "/repo/.git/worktrees/durable",
      branch: workspace.branch,
      manifestDigest: hash,
      registrationDigest: hash,
    },
  };
}

class FixtureArtifacts implements ArtifactStore {
  private sequence = 0;

  async write(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    type: string;
    mediaType: string;
    bytes: string | Uint8Array;
  }): Promise<ArtifactRef> {
    this.sequence += 1;
    const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes) : input.bytes;
    return {
      id: `artifact-${this.sequence}`,
      type: input.type,
      mediaType: input.mediaType,
      uri: `memory:artifact-${this.sequence}`,
      digest: digestBytes(bytes),
      producer: { runId: input.runId, nodeId: input.nodeId, attempt: input.attempt },
    };
  }
}

class FixtureWorkspace implements DurableWorkspaceBoundary {
  private readonly captures: Array<{ checkpoint: WorkspaceCheckpoint; diff: string }>;
  captureCount = 0;

  constructor(labels: readonly string[]) {
    this.captures = labels.map((label) => ({
      checkpoint: checkpoint(label),
      diff: label === "clean" ? "" : `diff:${label}`,
    }));
  }

  async capture(): Promise<{ checkpoint: WorkspaceCheckpoint; diff: string }> {
    const value = this.captures[Math.min(this.captureCount, this.captures.length - 1)];
    this.captureCount += 1;
    if (!value) {
      throw new Error("Fixture workspace has no capture");
    }
    return structuredClone(value);
  }

  compare(
    expected: WorkspaceCheckpoint,
    observed: WorkspaceCheckpoint,
  ): { matches: boolean; differences: WorkspaceDifference[] } {
    const left = structuredClone(expected);
    const right = structuredClone(observed);
    delete left.diffArtifactId;
    delete right.diffArtifactId;
    const matches = canonicalJson(left) === canonicalJson(right);
    return { matches, differences: matches ? [] : ["head-commit"] };
  }
}

class FixtureExecutionHost implements ExecutionHost {
  readonly prepared: PrepareExecution[] = [];
  readonly authorized: PersistedExecutionRef[] = [];
  inspectResult: ExecutionObservation | undefined;
  terminateResult: ExecutionObservation | undefined;
  cancelState: "absent" | "unknown" = "absent";
  hold = false;
  result: ExecutionResult | CommandExecution = {
    status: "succeeded",
    output: { summary: "done" },
  };
  private releaseHold: (() => void) | undefined;
  private readonly held = new Promise<void>((resolve) => {
    this.releaseHold = resolve;
  });
  private authorizeObserved: (() => Promise<void>) | undefined;
  private resolveAuthorized!: () => void;
  readonly authorization = new Promise<void>((resolve) => {
    this.resolveAuthorized = resolve;
  });

  verifyAuthorization(observe: () => Promise<void>): void {
    this.authorizeObserved = observe;
  }

  async prepare(input: PrepareExecution): Promise<PersistedExecutionRef> {
    this.prepared.push(structuredClone(input));
    return { ...structuredClone(input.plan), manifestDigest: hash };
  }

  async authorize(execution: PersistedExecutionRef): Promise<OwnedExecution> {
    await this.authorizeObserved?.();
    this.authorized.push(structuredClone(execution));
    this.resolveAuthorized();
    const hold = this.hold;
    const held = this.held;
    const terminalResult = structuredClone(this.result);
    const terminalStatus = executionStatus(terminalResult);
    const releaseHold = this.releaseHold;
    const cancelState = this.cancelState;
    return {
      execution: structuredClone(execution),
      async *events(): AsyncIterable<RuntimeEvent> {
        yield { type: "started" };
        if (hold) {
          await held;
        }
        yield { type: "completed", status: hold ? "cancelled" : terminalStatus };
      },
      async collect(): Promise<ExecutionResult | CommandExecution> {
        if (hold) {
          await held;
          return { status: "cancelled", reason: "operator" };
        }
        return structuredClone(terminalResult);
      },
      async cancel(): Promise<ExecutionObservation> {
        releaseHold?.();
        if (cancelState === "unknown") {
          return {
            state: "unknown",
            execution,
            reason: "cleanup-unconfirmed",
          };
        }
        return {
          state: "absent",
          execution: execution,
          terminal: { outcome: "cancelled", cleanup: "confirmed", terminalDigest: hash },
        };
      },
    };
  }

  async inspect(execution: Parameters<ExecutionHost["inspect"]>[0]): Promise<ExecutionObservation> {
    return this.inspectResult ?? { state: "absent", execution: structuredClone(execution) };
  }

  async terminate(
    execution: Parameters<ExecutionHost["terminate"]>[0],
  ): Promise<ExecutionObservation> {
    return this.terminateResult ?? { state: "absent", execution: structuredClone(execution) };
  }
}

function coordinator(
  store: InMemoryDurableRunStore,
  host: FixtureExecutionHost,
  fixtureWorkspace: FixtureWorkspace,
  now: () => number,
): DurableRunCoordinator {
  return new DurableRunCoordinator({
    store,
    executionHost: host,
    artifacts: new FixtureArtifacts(),
    workspace: fixtureWorkspace,
    runtimes: {
      parse(value) {
        assertRuntimeDescriptor(value);
        if (value.runtimeId !== "fake" || value.configurationVersion !== "fixture-v1") {
          throw new TypeError("Invalid fixture descriptor");
        }
        return structuredClone(value);
      },
      async create() {
        return new FakeRuntimeAdapter({ nodes: {} });
      },
    },
    owner,
    observeProcess: async () => ({ state: "absent", observedAtMs: now() }),
  });
}

async function seedInterruptedRun(
  store: InMemoryDurableRunStore,
  setup: DurableRunCoordinator,
): Promise<PersistedExecutionRef> {
  await setup.createRun(workflow, { runId: "recovery", workspace, descriptor });
  const lease = await store.acquireReleased({
    runId: "recovery",
    ownerId: randomUUID(),
    owner: oldOwner,
  });
  const loaded = await store.load("recovery", "complete-history");
  if (!loaded) {
    throw new Error("Seeded run was not found");
  }
  const negotiation = await probeRuntime(new FakeRuntimeAdapter({ nodes: {} }), "isolated");
  const attempt = 1;
  const context = buildContext({
    workflow,
    state: loaded.state,
    nodeId: "work",
    attempt,
    workspace,
  });
  const request = {
    runId: "recovery",
    workflowInstanceId: loaded.state.workflowInstanceId,
    nodeId: "work",
    nodeKind: "agent" as const,
    attempt,
    role: { id: "worker" },
    workspace,
    context: context.envelope,
    budget: context.envelope.budget!,
    requiredOutputSchema: context.envelope.requiredOutputSchema!,
    toolPolicy: { allowMutations: true },
  };
  const prepared = createPrepareExecution({
    runId: "recovery",
    executionId: randomUUID(),
    generation: lease.generation,
    coordinator: oldOwner,
    descriptor,
    request,
  });
  const persisted: PersistedExecutionRef = { ...prepared.plan, manifestDigest: hash };
  const payloads: RunEventPayload[] = [
    { type: "RuntimeNegotiated", negotiation },
    { type: "AttemptScheduled", nodeId: "work", attempt, runtimeId: "fake" },
    {
      type: "AttemptPrepared",
      nodeId: "work",
      attempt,
      execution: prepared.plan,
      workspaceCheckpoint: checkpoint(),
    },
    { type: "AttemptStartAuthorized", nodeId: "work", attempt, execution: persisted },
  ];
  const transition = materializeEvents(loaded.state, "recovery", payloads);
  const events = [...loaded.events, ...transition.events];
  await store.commit({
    lease,
    operationId: "seed-attempt",
    expectedSequence: loaded.state.sequence,
    events: transition.events,
    snapshot: createRunSnapshot(workflow, events),
  });
  return persisted;
}

async function observePauseBeforeCrash(store: InMemoryDurableRunStore): Promise<void> {
  const control = await store.submitControl({
    runId: "recovery",
    operationId: "pause-before-crash",
    action: "pause",
  });
  const lease = await store.inspectLease("recovery");
  const loaded = await store.load("recovery", "complete-history");
  if (!lease || !loaded) {
    throw new Error("Interrupted run has no current ownership");
  }
  const transition = materializeEvents(loaded.state, "recovery", [
    {
      type: "ControlRequestObserved",
      operationId: control.operationId,
      action: control.action,
      recordedAtMs: control.recordedAtMs,
    },
  ]);
  await store.commit({
    lease: { runId: lease.runId, ownerId: lease.ownerId, generation: lease.generation },
    operationId: "observe-before-crash",
    expectedSequence: loaded.state.sequence,
    events: transition.events,
    handlesControlOperationId: control.operationId,
  });
}

function eventTypes(events: readonly { type: string }[]): string[] {
  return events.map(({ type }) => type);
}

function executionStatus(
  result: ExecutionResult | CommandExecution,
): "succeeded" | "failed" | "blocked" | "cancelled" {
  if ("status" in result) {
    return result.status;
  }
  return result.failure ? "failed" : "succeeded";
}

describe("durable run coordinator", () => {
  it("persists preparation and start authority before authorizing the execution host", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new FixtureExecutionHost();
    host.verifyAuthorization(async () => {
      const loaded = await store.load("start", "complete-history");
      expect(eventTypes(loaded?.events ?? [])).toContain("AttemptStartAuthorized");
    });
    const state = await coordinator(store, host, new FixtureWorkspace(["clean"]), () => now).start(
      workflow,
      { runId: "start", workspace, descriptor },
    );
    expect(state.status).toBe("succeeded");
    expect(host.prepared).toHaveLength(1);
    expect(host.authorized).toHaveLength(1);
    const loaded = await store.load("start", "complete-history");
    expect(eventTypes(loaded?.events ?? [])).toEqual(
      expect.arrayContaining([
        "AttemptScheduled",
        "AttemptPrepared",
        "AttemptStartAuthorized",
        "AttemptSucceeded",
        "RunCompleted",
      ]),
    );
    expect(await store.inspectLease("start")).toMatchObject({ released: true });
    now += 1;
  });

  it("routes command attempts through the same prepared and authorized boundary", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new FixtureExecutionHost();
    host.result = {
      output: {
        passed: true,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 2,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      stdout: Buffer.from("ok"),
      stderr: Buffer.alloc(0),
    };
    const state = await coordinator(store, host, new FixtureWorkspace(["clean"]), () => now).start(
      commandWorkflow,
      { runId: "command", workspace, descriptor },
    );
    expect(state.status).toBe("succeeded");
    expect(host.prepared[0]).toMatchObject({ plan: { kind: "command" } });
    const loaded = await store.load("command", "complete-history");
    expect(eventTypes(loaded?.events ?? [])).toContain("CommandCompleted");
  });

  it("orphans a clean interrupted attempt and starts a freshly numbered replacement", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setupHost = new FixtureExecutionHost();
    const setup = coordinator(store, setupHost, new FixtureWorkspace(["clean"]), () => now);
    await seedInterruptedRun(store, setup);
    now = 20_000;
    const recoveryHost = new FixtureExecutionHost();
    const state = await coordinator(
      store,
      recoveryHost,
      new FixtureWorkspace(["clean"]),
      () => now,
    ).resume("recovery", "resume-clean");
    expect(state.status).toBe("succeeded");
    expect(state.nodes.work?.attempts).toHaveLength(2);
    expect(state.nodes.work?.attempts[0]).toMatchObject({ status: "orphaned" });
    expect(state.nodes.work?.attempts[1]).toMatchObject({ status: "succeeded" });
    expect(recoveryHost.authorized).toHaveLength(1);
  });

  it("retains a dirty orphan workspace and pauses without a replacement", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setup = coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    );
    await seedInterruptedRun(store, setup);
    now = 20_000;
    const recoveryHost = new FixtureExecutionHost();
    const state = await coordinator(
      store,
      recoveryHost,
      new FixtureWorkspace(["dirty"]),
      () => now,
    ).resume("recovery", "resume-dirty");
    expect(state.status).toBe("paused");
    expect(state.pauseReason).toEqual({ kind: "workspace-conflict", differences: ["head-commit"] });
    expect(state.nodes.work?.attempts[0]?.status).toBe("orphaned");
    expect(recoveryHost.authorized).toHaveLength(0);
  });

  it("records recovery-blocked and starts nothing when execution identity is unknown", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setup = coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    );
    const execution = await seedInterruptedRun(store, setup);
    now = 20_000;
    const recoveryHost = new FixtureExecutionHost();
    recoveryHost.inspectResult = {
      state: "unknown",
      execution,
      reason: "supervisor-lost",
    };
    const state = await coordinator(
      store,
      recoveryHost,
      new FixtureWorkspace(["clean"]),
      () => now,
    ).resume("recovery", "resume-unknown");
    expect(state.status).toBe("recovery-blocked");
    expect(state.recoveryBlock).toEqual({
      operationId: "resume-unknown",
      reason: {
        kind: "execution-unknown",
        executionId: execution.executionId,
        detail: "supervisor-lost",
      },
    });
    expect(recoveryHost.authorized).toHaveLength(0);
  });

  it("completes an already observed pause after the old coordinator dies", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setup = coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    );
    await seedInterruptedRun(store, setup);
    await observePauseBeforeCrash(store);
    expect(await store.pendingControls("recovery")).toEqual([]);
    now = 20_000;
    const state = await coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    ).resume("recovery", "replacement-operation");
    expect(state.status).toBe("paused");
    expect(state.pauseReason).toEqual({
      kind: "operator",
      operationId: "pause-before-crash",
    });
    const loaded = await store.load("recovery", "complete-history");
    expect(loaded?.events.filter((event) => event.type === "ControlRequestObserved")).toHaveLength(
      1,
    );
  });

  it("refuses absent-owner takeover until the exact lease expires", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setup = coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    );
    await seedInterruptedRun(store, setup);
    const before = await store.load("recovery", "execution");
    const blocked = setup.resume("recovery", "too-early");
    await expect(blocked).rejects.toBeInstanceOf(RunOwnershipBlockedError);
    await expect(blocked).rejects.toMatchObject({ reason: "lease-active" });
    const after = await store.load("recovery", "execution");
    expect(after?.state.sequence).toBe(before?.state.sequence);
  });

  it("observes an active pause request before confirmed cancellation", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new FixtureExecutionHost();
    host.hold = true;
    const engine = coordinator(store, host, new FixtureWorkspace(["clean"]), () => now);
    const running = engine.start(workflow, { runId: "pause-active", workspace, descriptor });
    await host.authorization;
    await engine.submitControl("pause-active", "pause", "pause-operation");
    const state = await running;
    expect(state.status).toBe("paused");
    expect(state.nodes.work?.attempts[0]?.status).toBe("cancelled");
    expect(state.pauseReason).toEqual({ kind: "operator", operationId: "pause-operation" });
    expect(await store.pendingControls("pause-active")).toEqual([]);
    const loaded = await store.load("pause-active", "complete-history");
    const types = eventTypes(loaded?.events ?? []);
    expect(types.indexOf("ControlRequestObserved")).toBeLessThan(
      types.indexOf("ExecutionCleanupObserved"),
    );
    expect(types.indexOf("WorkspaceObserved")).toBeLessThan(types.indexOf("AttemptCancelled"));
  });

  it("records a duration timeout before cleanup and fails the exhausted attempt", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new FixtureExecutionHost();
    host.hold = true;
    const state = await coordinator(store, host, new FixtureWorkspace(["clean"]), () => now).start(
      timeoutWorkflow,
      { runId: "timeout", workspace, descriptor },
    );
    expect(state.status).toBe("failed");
    expect(state.nodes.work?.attempts[0]).toMatchObject({
      status: "failed",
      timeout: { cancellation: "succeeded" },
      failure: { category: "budget-exhausted" },
    });
    const loaded = await store.load("timeout", "complete-history");
    const types = eventTypes(loaded?.events ?? []);
    expect(types.indexOf("AttemptTimeoutRequested")).toBeLessThan(
      types.indexOf("AttemptCancellationCompleted"),
    );
    expect(types.indexOf("AttemptCancellationCompleted")).toBeLessThan(
      types.indexOf("ExecutionCleanupObserved"),
    );
    expect(types.indexOf("ExecutionCleanupObserved")).toBeLessThan(types.indexOf("AttemptFailed"));
  });

  it("blocks timeout recovery when execution cleanup is not confirmed", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new FixtureExecutionHost();
    host.hold = true;
    host.cancelState = "unknown";
    const state = await coordinator(store, host, new FixtureWorkspace(["clean"]), () => now).start(
      timeoutWorkflow,
      { runId: "timeout-unknown", workspace, descriptor },
    );
    expect(state.status).toBe("recovery-blocked");
    expect(state.nodes.work?.attempts[0]).toMatchObject({
      status: "running",
      timeout: { cancellation: "failed" },
      cleanup: [{ cause: "timeout", outcome: "unknown" }],
    });
    expect(state.recoveryBlock?.reason).toEqual({
      kind: "cleanup-unknown",
      executionId: host.prepared[0]?.plan.executionId,
    });
  });

  it("renews an owned lease on the independent five-second cadence", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const store = new InMemoryDurableRunStore(() => now);
      const setup = coordinator(
        store,
        new FixtureExecutionHost(),
        new FixtureWorkspace(["clean"]),
        () => now,
      );
      await setup.createRun(workflow, { runId: "heartbeat", workspace, descriptor });
      const lease = await store.acquireReleased({
        runId: "heartbeat",
        ownerId: randomUUID(),
        owner,
      });
      const loaded = await store.load("heartbeat", "execution");
      if (!loaded) {
        throw new Error("Heartbeat fixture run was not found");
      }
      const session = new OwnedRunSession({
        store,
        lease,
        workflow,
        loaded,
        createOperationId: randomUUID,
      });
      now = 6_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await store.inspectLease("heartbeat")).toMatchObject({
        renewedAtMs: 6_000,
        expiresAtMs: 21_000,
      });
      await session.stop();
      await store.release(lease);
    } finally {
      vi.useRealTimers();
    }
  });
});
