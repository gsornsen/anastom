import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  canonicalJson,
  compileSdlcFeature,
  digestBytes,
  digestJson,
  loadSdlcMethodology,
  normalizeFeature,
  parseFeatureMarkdown,
  type WorkflowDefinition,
} from "@anastom/core";
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
  projectEvidenceLedger,
  type ArtifactStore,
  type CommandExecution,
  type DurableWorkspaceBoundary,
  type DurableRunCoordinatorOptions,
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
  policies: {
    defaultAttemptBudget: { maxAttempts: 2, maxDurationMs: 30_000 },
    maxParallel: 1,
  },
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
  policies: { defaultAttemptBudget: { maxAttempts: 1, maxDurationMs: 20 }, maxParallel: 1 },
  nodes: {
    work: {
      ...workflow.nodes.work!,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 20 },
    },
  },
};

const concurrentWorkflow: WorkflowDefinition = {
  ...workflow,
  metadata: { id: "test/concurrent", version: "0.1.0" },
  policies: {
    defaultAttemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    maxParallel: 2,
  },
  nodeOrder: ["left", "right", "join"],
  nodes: {
    left: {
      ...workflow.nodes.work!,
      id: "left",
      needs: [],
      mutation: "readonly",
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
    right: {
      ...workflow.nodes.work!,
      id: "right",
      needs: [],
      mutation: "readonly",
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
    join: {
      ...workflow.nodes.work!,
      id: "join",
      needs: ["left", "right"],
      mutation: "readonly",
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
  },
};

const concurrentRecoveryWorkflow: WorkflowDefinition = {
  ...concurrentWorkflow,
  metadata: { id: "test/concurrent-recovery", version: "0.1.0" },
  policies: {
    defaultAttemptBudget: { maxAttempts: 2, maxDurationMs: 30_000 },
    maxParallel: 2,
  },
  nodes: Object.fromEntries(
    Object.entries(concurrentWorkflow.nodes).map(([id, node]) => [
      id,
      { ...node, attemptBudget: { maxAttempts: 2, maxDurationMs: 30_000 } },
    ]),
  ),
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
  private readonly bytes = new Map<string, Uint8Array>();

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
    const reference = {
      id: `artifact-${this.sequence}`,
      type: input.type,
      mediaType: input.mediaType,
      uri: `memory:artifact-${this.sequence}`,
      digest: digestBytes(bytes),
      producer: { runId: input.runId, nodeId: input.nodeId, attempt: input.attempt },
    };
    this.bytes.set(reference.id, Uint8Array.from(bytes));
    return reference;
  }

  async read(artifact: ArtifactRef): Promise<Uint8Array> {
    const bytes = this.bytes.get(artifact.id);
    if (!bytes || digestBytes(bytes) !== artifact.digest) {
      throw new Error("Fixture artifact is missing or corrupt");
    }
    return Uint8Array.from(bytes);
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

class DefinedSdlcWorkspace implements DurableWorkspaceBoundary {
  readonly createdTasks: string[] = [];
  readonly preparedIntegrations: string[][] = [];
  interruptNextReconciliation = false;
  private readonly captures = new Map<string, number>();
  private integrationHead: string;

  constructor(private readonly integration: Extract<WorkspaceRef, { mode: "isolated" }>) {
    this.integrationHead = integration.baseCommit;
  }

  async capture(
    selected: WorkspaceRef,
  ): Promise<{ checkpoint: WorkspaceCheckpoint; diff: string }> {
    if (selected.mode === "memory") {
      throw new Error("Fixture requires a filesystem workspace");
    }
    const count = this.captures.get(selected.id) ?? 0;
    this.captures.set(selected.id, count + 1);
    const mutatingTask = selected.id.includes("--task--");
    const changed = mutatingTask && count > 0;
    const headCommit =
      selected.id === this.integration.id ? this.integrationHead : selected.baseCommit;
    const diff = changed ? `patch:${selected.id}` : "";
    return {
      checkpoint: {
        version: "anastom.dev/workspace-checkpoint/v1alpha1",
        workspaceId: selected.id,
        baseCommit: selected.baseCommit,
        headCommit,
        diffDigest: digestBytes(diff),
        changedFiles: changed ? [`${selected.id}.txt`] : [],
        ignoredDigest: hash,
        ignoredEntryCount: 0,
        ignoredByteCount: 0,
        ownership: {
          repositoryRoot: selected.repoRoot,
          repositoryCommonDirectory: `${selected.repoRoot}/.git`,
          workspacePath: selected.path,
          workspaceGitDirectory: `${selected.repoRoot}/.git/worktrees/${selected.id}`,
          branch: selected.mode === "isolated" ? selected.branch : "readonly",
          manifestDigest: hash,
          registrationDigest: hash,
        },
      },
      diff,
    };
  }

  compare(
    expected: WorkspaceCheckpoint,
    observed: WorkspaceCheckpoint,
  ): { matches: boolean; differences: WorkspaceDifference[] } {
    const matches = expected.diffDigest === observed.diffDigest;
    return { matches, differences: matches ? [] : ["diff-digest"] };
  }

  async createTaskWorkspace(options: {
    runId: string;
    taskId: string;
    baseCommit: string;
  }): Promise<Extract<WorkspaceRef, { mode: "isolated" }>> {
    if (options.baseCommit !== this.integrationHead) {
      throw new Error("Task workspace base does not match integration head");
    }
    this.createdTasks.push(options.taskId);
    const id = `${options.runId}--task--${options.taskId}`;
    return {
      id,
      mode: "isolated",
      repoRoot: this.integration.repoRoot,
      path: `/repo/${id}`,
      baseCommit: options.baseCommit,
      branch: `anastom/${id}`,
    };
  }

  async captureAcceptedPatch(options: {
    taskId: string;
    workspace: Extract<WorkspaceRef, { mode: "isolated" }>;
    mutationScopes: readonly string[];
  }) {
    const patch = Buffer.from(`patch:${options.taskId}`);
    return {
      version: "anastom.dev/accepted-workspace-patch/v1alpha1" as const,
      workspaceId: options.workspace.id,
      baseCommit: options.workspace.baseCommit,
      headCommit: options.workspace.baseCommit,
      changedFiles: [`${options.taskId}.txt`],
      mutationScopes: [...options.mutationScopes],
      patch,
      patchDigest: digestBytes(patch),
    };
  }

  async prepareIntegration(options: {
    patches: readonly {
      taskId: string;
      accepted: { patchDigest: string };
    }[];
  }) {
    const patches = options.patches.map(({ taskId, accepted }) => ({
      taskId,
      digest: accepted.patchDigest,
    }));
    this.preparedIntegrations.push(patches.map(({ taskId }) => taskId));
    const content = {
      version: "anastom.dev/integration-preparation/v1alpha1" as const,
      workspaceId: this.integration.id,
      branch: this.integration.branch,
      parentCommit: this.integrationHead,
      patches,
      tree: digestBytes(`tree:${canonicalJson(patches)}`).slice(7, 47),
      expectedCommit: digestBytes(`commit:${this.integrationHead}:${canonicalJson(patches)}`).slice(
        7,
        47,
      ),
    };
    return { ...content, preparationDigest: digestJson(content) };
  }

  async reconcileIntegration(options: {
    preparation: { parentCommit: string; expectedCommit: string };
  }): Promise<{ outcome: "committed"; commit: string }> {
    if (
      this.integrationHead !== options.preparation.parentCommit &&
      this.integrationHead !== options.preparation.expectedCommit
    ) {
      throw new Error("Integration branch moved unexpectedly");
    }
    this.integrationHead = options.preparation.expectedCommit;
    if (this.interruptNextReconciliation) {
      this.interruptNextReconciliation = false;
      throw new Error("Fixture interrupted integration after moving the branch");
    }
    return { outcome: "committed", commit: this.integrationHead };
  }
}

class FixtureExecutionHost implements ExecutionHost {
  readonly prepared: PrepareExecution[] = [];
  readonly authorized: PersistedExecutionRef[] = [];
  inspectResult: ExecutionObservation | undefined;
  terminateResult: ExecutionObservation | undefined;
  readonly inspectResults = new Map<string, ExecutionObservation>();
  readonly terminateResults = new Map<string, ExecutionObservation>();
  cancelState: "absent" | "unknown" = "absent";
  hold = false;
  result: ExecutionResult | CommandExecution = {
    status: "succeeded",
    output: { summary: "done" },
  };
  readonly results = new Map<string, ExecutionResult | CommandExecution>();

  setResult(nodeId: string, result: ExecutionResult | CommandExecution): void {
    this.results.set(nodeId, structuredClone(result));
  }
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
    const launch = this.prepared.find(({ plan }) => plan.executionId === execution.executionId);
    const nodeId =
      launch && "request" in launch
        ? launch.request.nodeId
        : [...this.results.keys()].find((candidate) => candidate.startsWith("verify."));
    const terminalResult = structuredClone(
      (nodeId === undefined ? undefined : this.results.get(nodeId)) ?? this.result,
    );
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
    return (
      this.inspectResults.get(execution.executionId) ??
      this.inspectResult ?? { state: "absent", execution: structuredClone(execution) }
    );
  }

  async terminate(
    execution: Parameters<ExecutionHost["terminate"]>[0],
  ): Promise<ExecutionObservation> {
    return (
      this.terminateResults.get(execution.executionId) ??
      this.terminateResult ?? { state: "absent", execution: structuredClone(execution) }
    );
  }
}

class ConcurrentExecutionHost implements ExecutionHost {
  readonly prepared: PrepareExecution[] = [];
  readonly authorized: string[] = [];
  readonly cancelled: string[] = [];
  readonly unknownOnCancel = new Set<string>();
  maxActive = 0;
  private active = 0;
  private readonly launches = new Map<string, PrepareExecution>();
  private readonly releases = new Map<string, () => void>();
  private readonly results = new Map<string, ExecutionResult>();

  setResult(nodeId: string, result: ExecutionResult): void {
    this.results.set(nodeId, structuredClone(result));
  }

  release(nodeId: string): void {
    const release = this.releases.get(nodeId);
    if (!release) {
      throw new Error(`Node ${nodeId} is not active`);
    }
    release();
  }

  async prepare(input: PrepareExecution): Promise<PersistedExecutionRef> {
    this.prepared.push(structuredClone(input));
    this.launches.set(input.plan.executionId, structuredClone(input));
    return { ...structuredClone(input.plan), manifestDigest: hash };
  }

  async authorize(execution: PersistedExecutionRef): Promise<OwnedExecution> {
    const launch = this.launches.get(execution.executionId);
    if (!launch || !("request" in launch)) {
      throw new Error("Concurrent fixture lost its runtime launch");
    }
    const nodeId = launch.request.nodeId;
    this.authorized.push(nodeId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    let cancelled = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        this.active -= 1;
      }
    };
    this.releases.set(nodeId, release);
    const selected = this.results.get(nodeId) ?? {
      status: "succeeded" as const,
      output: { summary: `${nodeId} completed` },
    };
    return {
      execution: structuredClone(execution),
      async *events(): AsyncIterable<RuntimeEvent> {
        yield { type: "started" };
        await held;
        yield {
          type: "completed",
          status: cancelled ? "cancelled" : selected.status,
        };
      },
      async collect(): Promise<ExecutionResult> {
        await held;
        finish();
        return cancelled
          ? { status: "cancelled", reason: "controller-cancelled" }
          : structuredClone(selected);
      },
      cancel: async (): Promise<ExecutionObservation> => {
        cancelled = true;
        this.cancelled.push(nodeId);
        release();
        finish();
        if (this.unknownOnCancel.has(nodeId)) {
          return {
            state: "unknown",
            execution,
            reason: "cleanup-unconfirmed",
          };
        }
        return {
          state: "absent",
          execution,
          terminal: { outcome: "cancelled", cleanup: "confirmed", terminalDigest: hash },
        };
      },
    };
  }

  async inspect(execution: Parameters<ExecutionHost["inspect"]>[0]): Promise<ExecutionObservation> {
    return { state: "absent", execution: structuredClone(execution) };
  }

  async terminate(
    execution: Parameters<ExecutionHost["terminate"]>[0],
  ): Promise<ExecutionObservation> {
    return { state: "absent", execution: structuredClone(execution) };
  }
}

function coordinator(
  store: InMemoryDurableRunStore,
  host: ExecutionHost,
  fixtureWorkspace: DurableWorkspaceBoundary,
  options:
    | (() => number)
    | {
        now: () => number;
        observeCommittedEvents: DurableRunCoordinatorOptions["observeCommittedEvents"];
      },
): DurableRunCoordinator {
  const now = typeof options === "function" ? options : options.now;
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
    observeCommittedEvents:
      typeof options === "function" ? undefined : options.observeCommittedEvents,
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

async function seedInterruptedConcurrentRun(
  store: InMemoryDurableRunStore,
  setup: DurableRunCoordinator,
): Promise<PersistedExecutionRef[]> {
  await setup.createRun(concurrentRecoveryWorkflow, {
    runId: "recovery-concurrent",
    workspace,
    descriptor,
  });
  const lease = await store.acquireReleased({
    runId: "recovery-concurrent",
    ownerId: randomUUID(),
    owner: oldOwner,
  });
  const loaded = await store.load("recovery-concurrent", "complete-history");
  if (!loaded) {
    throw new Error("Seeded concurrent run was not found");
  }
  const negotiation = await probeRuntime(new FakeRuntimeAdapter({ nodes: {} }), "isolated");
  const payloads: RunEventPayload[] = [{ type: "RuntimeNegotiated", negotiation }];
  const executions: PersistedExecutionRef[] = [];
  for (const nodeId of ["left", "right"]) {
    const context = buildContext({
      workflow: concurrentRecoveryWorkflow,
      state: loaded.state,
      nodeId,
      attempt: 1,
      workspace,
    });
    const prepared = createPrepareExecution({
      runId: "recovery-concurrent",
      executionId: randomUUID(),
      generation: lease.generation,
      coordinator: oldOwner,
      descriptor,
      request: {
        runId: "recovery-concurrent",
        workflowInstanceId: loaded.state.workflowInstanceId,
        nodeId,
        nodeKind: "agent",
        attempt: 1,
        role: { id: "worker" },
        workspace,
        context: context.envelope,
        budget: context.envelope.budget!,
        requiredOutputSchema: context.envelope.requiredOutputSchema!,
        toolPolicy: { allowMutations: false },
      },
    });
    const persisted: PersistedExecutionRef = { ...prepared.plan, manifestDigest: hash };
    executions.push(persisted);
    payloads.push(
      { type: "AttemptScheduled", nodeId, attempt: 1, runtimeId: "fake" },
      {
        type: "AttemptPrepared",
        nodeId,
        attempt: 1,
        execution: prepared.plan,
        workspaceCheckpoint: checkpoint(),
      },
      { type: "AttemptStartAuthorized", nodeId, attempt: 1, execution: persisted },
    );
  }
  const transition = materializeEvents(loaded.state, "recovery-concurrent", payloads);
  await store.commit({
    lease,
    operationId: "seed-concurrent-attempts",
    expectedSequence: loaded.state.sequence,
    events: transition.events,
    snapshot: createRunSnapshot(concurrentRecoveryWorkflow, [
      ...loaded.events,
      ...transition.events,
    ]),
  });
  return executions;
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
  it("executes a planner-expanded workflow through scoped patches and committed integrations", async () => {
    const feature = normalizeFeature(
      parseFeatureMarkdown(`---
apiVersion: anastom.dev/v1alpha1
kind: Feature
metadata: {id: test/defined-sdlc, version: 0.1.0}
acceptanceCriteria: [Both independent changes are integrated and verified]
verification:
  - id: test
    argv: [pnpm, test]
    maxDuration: 1m
policies: {maxTasks: 2, maxParallel: 2}
---
Implement two independent changes, integrate them, review the result, and verify it.
`),
      "/repo/feature.md",
    );
    const methodology = await loadSdlcMethodology(resolve("methodologies/sdlc/default"));
    const definedWorkflow = compileSdlcFeature(feature, methodology, {
      protectedPaths: ["feature.md"],
    });
    const integrationWorkspace: Extract<WorkspaceRef, { mode: "isolated" }> = {
      id: "defined-sdlc--integration",
      mode: "isolated",
      repoRoot: "/repo",
      path: "/repo/integration",
      baseCommit: "1".repeat(40),
      branch: "anastom/defined-sdlc--integration",
    };
    const workspaceBoundary = new DefinedSdlcWorkspace(integrationWorkspace);
    workspaceBoundary.interruptNextReconciliation = true;
    const host = new FixtureExecutionHost();
    host.setResult("analysis", {
      status: "succeeded",
      output: {
        summary: "The repository has two independent implementation boundaries.",
        boundaries: ["left", "right"],
        risks: [],
      },
    });
    host.setResult("planning", {
      status: "succeeded",
      output: {
        summary: "Implement two independent changes and combine their accepted patches.",
        tasks: [
          {
            id: "left",
            title: "Left change",
            objective: "Implement the complete left-side behavior.",
            acceptanceCriteria: ["Left behavior is complete"],
            dependsOn: [],
            mutationScopes: ["left.txt"],
          },
          {
            id: "right",
            title: "Right change",
            objective: "Implement the complete right-side behavior.",
            acceptanceCriteria: ["Right behavior is complete"],
            dependsOn: [],
            mutationScopes: ["right.txt"],
          },
        ],
        risks: [],
      },
    });
    const worker = {
      status: "succeeded" as const,
      output: {
        summary: "Completed the assigned bounded change and retained reviewable evidence.",
        changedFiles: [],
        notes: [],
      },
    };
    host.setResult("implement.left", worker);
    host.setResult("implement.right", worker);
    host.setResult("integrator", worker);
    const review = {
      status: "succeeded" as const,
      output: {
        approved: true,
        summary: "The integrated revision satisfies the supplied review contract.",
        findings: [],
      },
    };
    host.setResult("review.specification", review);
    host.setResult("review.quality", review);
    host.setResult("verify.test", {
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
    });
    const store = new InMemoryDurableRunStore(() => 1_000);
    const engine = coordinator(store, host, workspaceBoundary, () => 1_000);
    const interrupted = await engine.start(definedWorkflow, {
      runId: "defined-sdlc",
      workspace: integrationWorkspace,
      descriptor,
    });
    expect(interrupted.status).toBe("recovery-blocked");
    expect(interrupted.recoveryBlock?.reason).toMatchObject({
      kind: "integration-unknown",
      nodeId: "integrate.wave-1",
    });
    const state = await engine.resume("defined-sdlc", "resume-integration");

    expect(state.status).toBe("succeeded");
    expect(Object.keys(state.acceptedPatches ?? {})).toEqual([
      "left",
      "right",
      "integration-corrections",
    ]);
    expect(state.integrations?.["integrate.wave-1"]?.committed?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.integrations?.["integrate.final"]?.committed?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(workspaceBoundary.createdTasks).toEqual(["left", "right", "integration-corrections"]);
    expect(workspaceBoundary.preparedIntegrations).toEqual([
      ["left", "right"],
      ["integration-corrections"],
    ]);
    const retained = await store.load("defined-sdlc", "complete-history");
    if (!retained) {
      throw new Error("Completed defined-SDLC run was not retained");
    }
    const ledger = projectEvidenceLedger(definedWorkflow, retained.events);
    expect(ledger.phases.find(({ nodeId }) => nodeId === "implement.left")).toMatchObject({
      actor: { kind: "runtime", runtimeIds: ["fake"] },
      attempts: [
        {
          workspace: {
            workspaceId: "defined-sdlc--task--left",
            patchDigest: digestBytes("patch:left"),
          },
        },
      ],
    });
    expect(ledger.phases.find(({ nodeId }) => nodeId === "integrate.wave-1")).toMatchObject({
      actor: { kind: "controller" },
      integration: { committedCommit: state.integrations?.["integrate.wave-1"]?.committed?.commit },
    });
    expect(ledger.phases.find(({ nodeId }) => nodeId === "verify.test")).toMatchObject({
      actor: { kind: "command" },
    });
  });

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

  it("notifies presentation observers only after commit and ignores observer failures", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const observed: string[] = [];
    const state = await coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      {
        now: () => now,
        observeCommittedEvents(events) {
          observed.push(...eventTypes(events));
          throw new Error("display unavailable");
        },
      },
    ).start(workflow, { runId: "observed", workspace, descriptor });
    const loaded = await store.load("observed", "complete-history");

    expect(state.status).toBe("succeeded");
    expect(observed[0]).toBe("RunCreated");
    expect(observed.at(-1)).toBe("RunCompleted");
    expect(observed).toEqual(eventTypes(loaded?.events ?? []));
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

  it("reconciles every interrupted execution before starting concurrent replacements", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setup = coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    );
    await seedInterruptedConcurrentRun(store, setup);
    now = 20_000;
    const recoveryHost = new FixtureExecutionHost();
    const state = await coordinator(
      store,
      recoveryHost,
      new FixtureWorkspace(["clean"]),
      () => now,
    ).resume("recovery-concurrent", "resume-concurrent");

    expect(state.status).toBe("succeeded");
    expect(state.nodes.left?.attempts.map(({ status }) => status)).toEqual([
      "orphaned",
      "succeeded",
    ]);
    expect(state.nodes.right?.attempts.map(({ status }) => status)).toEqual([
      "orphaned",
      "succeeded",
    ]);
    expect(recoveryHost.authorized).toHaveLength(3);
  });

  it("starts no replacement when one of several interrupted executions is ambiguous", async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const setup = coordinator(
      store,
      new FixtureExecutionHost(),
      new FixtureWorkspace(["clean"]),
      () => now,
    );
    const executions = await seedInterruptedConcurrentRun(store, setup);
    now = 20_000;
    const recoveryHost = new FixtureExecutionHost();
    const ambiguous = executions[1]!;
    recoveryHost.inspectResults.set(ambiguous.executionId, {
      state: "unknown",
      execution: ambiguous,
      reason: "supervisor-lost",
    });
    const state = await coordinator(
      store,
      recoveryHost,
      new FixtureWorkspace(["clean"]),
      () => now,
    ).resume("recovery-concurrent", "resume-ambiguous");

    expect(state.status).toBe("recovery-blocked");
    expect(state.nodes.left?.attempts[0]?.status).toBe("orphaned");
    expect(state.nodes.right?.attempts[0]?.status).toBe("running");
    expect(state.recoveryBlock?.reason).toEqual({
      kind: "execution-unknown",
      executionId: ambiguous.executionId,
      detail: "supervisor-lost",
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

  it("runs independent nodes concurrently and waits for their dependency wave", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new ConcurrentExecutionHost();
    const running = coordinator(store, host, new FixtureWorkspace(["clean"]), () => now).start(
      concurrentWorkflow,
      { runId: "concurrent-success", workspace, descriptor },
    );

    await vi.waitFor(() => expect(host.authorized).toEqual(["left", "right"]));
    expect(host.maxActive).toBe(2);
    host.release("right");
    await vi.waitFor(async () => {
      const state = await store.load("concurrent-success", "execution");
      expect(state?.state.nodes.right?.status).toBe("succeeded");
      expect(state?.state.nodes.left?.status).toBe("running");
      expect(state?.state.nodes.join?.status).toBe("pending");
    });
    host.release("left");
    await vi.waitFor(() => expect(host.authorized).toEqual(["left", "right", "join"]));
    host.release("join");

    const state = await running;
    expect(state.status).toBe("succeeded");
    expect(state.nodes).toMatchObject({
      left: { status: "succeeded" },
      right: { status: "succeeded" },
      join: { status: "succeeded" },
    });
    const loaded = await store.load("concurrent-success", "complete-history");
    expect(loaded?.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: loaded?.events.length ?? 0 }, (_, index) => index + 1),
    );
  });

  it("cancels active siblings before a failed dependency terminates the run", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new ConcurrentExecutionHost();
    host.setResult("right", {
      status: "failed",
      failure: { category: "tool", message: "right failed" },
    });
    const running = coordinator(
      store,
      host,
      new FixtureWorkspace(["clean", "clean", "dirty"]),
      () => now,
    ).start(concurrentWorkflow, {
      runId: "concurrent-failure",
      workspace,
      descriptor,
    });

    await vi.waitFor(() => expect(host.authorized).toEqual(["left", "right"]));
    host.release("right");
    const state = await running;

    expect(state.status).toBe("failed");
    expect(state.nodes.right?.status).toBe("failed");
    expect(state.nodes.left?.status).toBe("cancelled");
    expect(state.nodes.join?.status).toBe("blocked");
    expect(host.cancelled).toEqual(["left"]);
  });

  it("cancels active siblings before pausing a changed workspace that can retry", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new ConcurrentExecutionHost();
    host.setResult("right", {
      status: "failed",
      failure: { category: "schema-violation", message: "right returned invalid output" },
    });
    const running = coordinator(
      store,
      host,
      new FixtureWorkspace(["clean", "clean", "dirty"]),
      () => now,
    ).start(concurrentRecoveryWorkflow, {
      runId: "concurrent-workspace-pause",
      workspace,
      descriptor,
    });

    await vi.waitFor(() => expect(host.authorized).toEqual(["left", "right"]));
    host.release("right");
    const state = await running;

    expect(state.status).toBe("paused");
    expect(state.pauseReason).toEqual({
      kind: "workspace-conflict",
      differences: ["head-commit"],
    });
    expect(state.nodes.right).toMatchObject({
      status: "paused",
      attempts: [{ status: "failed" }],
    });
    expect(state.nodes.left).toMatchObject({
      status: "paused",
      attempts: [{ status: "cancelled" }],
    });
    expect(state.nodes.join?.status).toBe("pending");
    expect(host.cancelled).toEqual(["left"]);
  });

  it("fans an operator pause into every active execution before pausing", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new ConcurrentExecutionHost();
    const engine = coordinator(store, host, new FixtureWorkspace(["clean"]), () => now);
    const running = engine.start(concurrentWorkflow, {
      runId: "concurrent-pause",
      workspace,
      descriptor,
    });

    await vi.waitFor(() => expect(host.authorized).toEqual(["left", "right"]));
    await engine.submitControl("concurrent-pause", "pause", "pause-concurrent");
    const state = await running;

    expect(state.status).toBe("paused");
    expect(state.nodes.left?.status).toBe("paused");
    expect(state.nodes.right?.status).toBe("paused");
    expect(state.nodes.join?.status).toBe("pending");
    expect(new Set(host.cancelled)).toEqual(new Set(["left", "right"]));
    expect(state.recoveryBlock).toBeUndefined();
  });

  it("names every unresolved execution when concurrent cleanup cannot be confirmed", async () => {
    const now = 1_000;
    const store = new InMemoryDurableRunStore(() => now);
    const host = new ConcurrentExecutionHost();
    host.unknownOnCancel.add("left");
    host.unknownOnCancel.add("right");
    const engine = coordinator(store, host, new FixtureWorkspace(["clean"]), () => now);
    const running = engine.start(concurrentWorkflow, {
      runId: "concurrent-unknown-cleanup",
      workspace,
      descriptor,
    });

    await vi.waitFor(() => expect(host.authorized).toEqual(["left", "right"]));
    await engine.submitControl("concurrent-unknown-cleanup", "pause", "pause-concurrent-unknown");
    const state = await running;
    const executionIds = host.prepared.map(({ plan }) => plan.executionId);

    expect(state.status).toBe("recovery-blocked");
    expect(state.recoveryBlock).toEqual({
      operationId: "pause-concurrent-unknown",
      reason: { kind: "cleanup-unknown-set", executionIds },
    });
    expect(new Set(host.cancelled)).toEqual(new Set(["left", "right"]));
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
