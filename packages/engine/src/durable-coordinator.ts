import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  expandSdlcPlan,
  normalizeFeaturePlan,
  parseReviewReport,
  validateJsonValue,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@anastom/core";
import {
  RuntimePreflightError,
  assertExecutionResult,
  assertRuntimeDescriptor,
  assertRuntimeEvent,
  probeRuntime,
  type ArtifactRef,
  type ExecutionFailure,
  type ExecutionRequest,
  type ExecutionResult,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type RuntimeNegotiation,
  type WorkspaceCheckpoint,
  type WorkspaceDifference,
  type WorkspaceRef,
} from "@anastom/runtime-contract";

import type { ArtifactStore, ArtifactWrite } from "./artifacts.js";
import { buildContext } from "./context.js";
import {
  createRunSnapshot,
  assertLocalProcessIdentity,
  RunStoreError,
  type ControlReceipt,
  type ControlRequest,
  type DurableRunStore,
  type LoadedRunWithHistory,
  type LocalProcessIdentity,
  type ProcessObservation,
  type RunLease,
  type RunLeaseToken,
} from "./durable-store.js";
import { OwnedRunSession } from "./durable-session.js";
import type { CommandExecution } from "./command.js";
import {
  createPrepareExecution,
  type ExecutionHost,
  type ExecutionObservation,
  type ExecutionPlanRef,
  type OwnedExecution,
  type PrepareExecution,
} from "./execution-host.js";
import {
  materializeEvents,
  type AttemptState,
  type PauseReason,
  type RecoveryBlockReason,
  type RunEvent,
  type RunEventPayload,
  type RunState,
  type IntegrationPreparationEvidence,
} from "./events.js";
import { RunNotFoundError } from "./engine.js";
import { resolveRunWorkflowGraph, resolveRunWorkflowNode } from "./graph.js";
import { findExecutableNodes, findReadyNodes } from "./scheduler.js";

const CONTROL_POLL_INTERVAL_MS = 500;
const LOG_ARTIFACT_MAX_BYTES = 1024 * 1024;

/** Exact workspace capture and comparison operations supplied by the workspace package. */
export interface DurableWorkspaceBoundary {
  /** Capture stable content and ownership evidence without changing the Git index. */
  capture(workspace: WorkspaceRef): Promise<{ checkpoint: WorkspaceCheckpoint; diff: string }>;
  /** Compare every dimension that can authorize an automatic replacement attempt. */
  compare(
    expected: WorkspaceCheckpoint,
    observed: WorkspaceCheckpoint,
  ): { matches: boolean; differences: WorkspaceDifference[] };
  /** Create one owned task workspace at the current exact integration commit. */
  createTaskWorkspace?(options: {
    runId: string;
    taskId: string;
    baseCommit: string;
  }): Promise<Extract<WorkspaceRef, { mode: "isolated" }>>;
  /** Validate and capture an implementation patch against its declared scope. */
  captureAcceptedPatch?(options: {
    runId: string;
    taskId: string;
    workspace: Extract<WorkspaceRef, { mode: "isolated" }>;
    mutationScopes: readonly string[];
  }): Promise<{
    version: "anastom.dev/accepted-workspace-patch/v1alpha1";
    workspaceId: string;
    baseCommit: string;
    headCommit: string;
    changedFiles: readonly string[];
    mutationScopes: readonly string[];
    patch: Uint8Array;
    patchDigest: string;
  }>;
  /** Compute a deterministic integration commit without moving its branch. */
  prepareIntegration?(options: {
    runId: string;
    patches: readonly {
      taskId: string;
      accepted: {
        version: "anastom.dev/accepted-workspace-patch/v1alpha1";
        workspaceId: string;
        baseCommit: string;
        headCommit: string;
        changedFiles: readonly string[];
        mutationScopes: readonly string[];
        patch: Uint8Array;
        patchDigest: string;
      };
    }[];
  }): Promise<IntegrationPreparationEvidence>;
  /** Reconcile the prepared parent/result pair and synchronize the owned worktree. */
  reconcileIntegration?(options: {
    runId: string;
    preparation: IntegrationPreparationEvidence;
  }): Promise<{ outcome: "committed"; commit: string }>;
}

/** Exact descriptor registry supplied by the composition root without vendor imports in the engine. */
export interface CoordinatorRuntimeRegistry {
  /** Parse one persisted descriptor through its concrete runtime codec. */
  parse(value: unknown): RuntimeDescriptor;
  /** Reconstruct an adapter from only the parsed credential-free descriptor. */
  create(descriptor: RuntimeDescriptor): Promise<RuntimeAdapter>;
}

/** Dependencies for local fenced orchestration and recovery. */
export interface DurableRunCoordinatorOptions {
  /** Fenced event, lease, control, integrity, and snapshot persistence. */
  store: DurableRunStore;
  /** Shared runtime and command process-ownership boundary. */
  executionHost: ExecutionHost;
  /** Immutable public evidence storage. */
  artifacts: ArtifactStore;
  /** Stable filesystem workspace capture and exact comparison. */
  workspace: DurableWorkspaceBoundary;
  /** Exact descriptor parser and adapter reconstruction registry. */
  runtimes: CoordinatorRuntimeRegistry;
  /** Sanitized identity of the current coordinator process. */
  owner: LocalProcessIdentity;
  /** Observe the process identity recorded by a prior lease without signalling it. */
  observeProcess: (owner: LocalProcessIdentity) => Promise<ProcessObservation>;
  /** Injectable cryptographic UUIDv4 run factory for deterministic tests. */
  createRunId?: () => string;
  /** Injectable cryptographic UUIDv4 lease-owner factory for deterministic tests. */
  createOwnerId?: () => string;
  /** Injectable safe idempotency-operation factory for deterministic tests. */
  createOperationId?: () => string;
  /** Injectable cryptographic UUIDv4 execution factory for deterministic tests. */
  createExecutionId?: () => string;
}

/** Durable inputs that must exist before the first owned run record is created. */
export interface CreateDurableRunOptions {
  /** Optional caller-selected safe run identity; defaults to UUIDv4. */
  runId?: string;
  /** Complete values for every authored workflow input. */
  inputs?: Record<string, JsonValue>;
  /** Authenticated filesystem workspace; in-memory workspaces are not recoverable. */
  workspace: Exclude<WorkspaceRef, { mode: "memory" }>;
  /** Optional per-node filesystem assignments used when independent nodes may run together. */
  nodeWorkspaces?: Readonly<Record<string, Exclude<WorkspaceRef, { mode: "memory" }>>>;
  /** Exact credential-free runtime selection persisted before any attempt. */
  descriptor: RuntimeDescriptor;
}

/** Stable reasons why automatic lease acquisition refused to mutate a run. */
export type RunOwnershipBlockReason = "lease-active" | "owner-alive" | "owner-unknown";

/** Read-only ownership refusal raised before a replacement lease is acquired. */
export class RunOwnershipBlockedError extends Error {
  /** Machine-readable refusal reason for CLI exit and status behavior. */
  readonly reason: RunOwnershipBlockReason;
  /** Exact lease observed before the refusal. */
  readonly lease: RunLease;
  /** Optional local process observation that prevented takeover. */
  readonly observation?: ProcessObservation;

  /** Construct a refusal without changing ownership or durable run state. */
  constructor(reason: RunOwnershipBlockReason, lease: RunLease, observation?: ProcessObservation) {
    super(`Run ownership is unavailable: ${reason}`);
    this.name = "RunOwnershipBlockedError";
    this.reason = reason;
    this.lease = structuredClone(lease);
    this.observation = observation ? structuredClone(observation) : undefined;
  }
}

interface CheckpointEvidence {
  checkpoint: WorkspaceCheckpoint;
  artifact?: ArtifactRef;
}

interface RuntimeDriveResult {
  kind: "result";
  result: ExecutionResult | CommandExecution;
  logs: Buffer;
}

interface RuntimeDriveTimeout {
  kind: "timeout";
  observation: ExecutionObservation;
  logs: Buffer;
}

type RuntimeDriveOutcome = RuntimeDriveResult | RuntimeDriveTimeout;

interface RuntimeDriveStopped {
  kind: "stopped";
}

type ConcurrentDriveOutcome = RuntimeDriveOutcome | RuntimeDriveStopped;

interface PreparedAttempt {
  node: WorkflowNode;
  nodeId: string;
  attempt: number;
  request: ExecutionRequest;
  plan: ExecutionPlanRef;
  launch: PrepareExecution;
  checkpoint: WorkspaceCheckpoint;
}

interface ActiveAttempt {
  prepared: PreparedAttempt;
  owned: OwnedExecution;
  abort: AbortController;
  outcome: Promise<ConcurrentDriveOutcome>;
}

type ActiveTurn =
  | { kind: "control"; control: ControlRequest }
  | { kind: "completed"; nodeId: string; outcome: ConcurrentDriveOutcome }
  | { kind: "failed"; nodeId: string; error: unknown };

interface FinishResultOptions {
  prepared: PreparedAttempt;
  result: ExecutionResult;
  evidence: readonly RunEventPayload[];
  comparison: { matches: boolean; differences: WorkspaceDifference[] };
}

interface ReconcileAttemptOptions {
  nodeId: string;
  control?: ControlRequest;
  controlAlreadyObserved: boolean;
  operationId: string;
}

interface RecoveredAbsenceOptions {
  nodeId: string;
  attempt: AttemptState;
  plan: ExecutionPlanRef;
  control?: ControlRequest;
  operationId: string;
}

interface CheckpointOptions {
  workspace: WorkspaceRef;
  nodeId: string;
  attempt: number;
  alwaysPersistDiff: boolean;
}

/**
 * Vendor-neutral coordinator for fenced starts, heartbeat, controls, and crash recovery.
 * It never imports SQLite, a concrete runtime, or a concrete workspace implementation.
 */
export class DurableRunCoordinator {
  private readonly store: DurableRunStore;
  private readonly executionHost: ExecutionHost;
  private readonly artifacts: ArtifactStore;
  private readonly workspace: DurableWorkspaceBoundary;
  private readonly runtimes: CoordinatorRuntimeRegistry;
  private readonly owner: LocalProcessIdentity;
  private readonly observeProcess: (owner: LocalProcessIdentity) => Promise<ProcessObservation>;
  private readonly createRunId: () => string;
  private readonly createOwnerId: () => string;
  private readonly createOperationId: () => string;
  private readonly createExecutionId: () => string;

  /** Bind abstract durable, execution, workspace, artifact, runtime, and process boundaries. */
  constructor(options: DurableRunCoordinatorOptions) {
    assertLocalProcessIdentity(options.owner);
    this.store = options.store;
    this.executionHost = options.executionHost;
    this.artifacts = options.artifacts;
    this.workspace = options.workspace;
    this.runtimes = options.runtimes;
    this.owner = structuredClone(options.owner);
    this.observeProcess = options.observeProcess;
    this.createRunId = options.createRunId ?? randomUUID;
    this.createOwnerId = options.createOwnerId ?? randomUUID;
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.createExecutionId = options.createExecutionId ?? randomUUID;
  }

  /** Create initial durable state and release it at a safe scheduling boundary. */
  async createRun(
    workflow: WorkflowDefinition,
    options: CreateDurableRunOptions,
  ): Promise<RunState> {
    const session = await this.initializeOwnedRun(workflow, options);
    return this.finishOwnedSession(session, async () => session.state);
  }

  /** Create and coordinate a new run until it becomes terminal, paused, or recovery-blocked. */
  async start(workflow: WorkflowDefinition, options: CreateDurableRunOptions): Promise<RunState> {
    const descriptor = this.parseDescriptor(options.descriptor);
    const session = await this.initializeOwnedRun(workflow, { ...options, descriptor });
    return this.finishOwnedSession(session, () => this.coordinateRunning(session, descriptor));
  }

  /** Submit a deduplicated pause or cancel request without acquiring the run lease. */
  async submitControl(
    runId: string,
    action: "pause" | "cancel",
    operationId = this.createOperationId(),
  ): Promise<ControlReceipt> {
    return this.store.submitControl({ runId, action, operationId });
  }

  /**
   * Acquire released ownership or safely take over an expired absent owner, then reconcile and run.
   * Live, unexpired, foreign-host, and unknown owners are refused without mutation.
   */
  async resume(runId: string, operationId = this.createOperationId()): Promise<RunState> {
    const loaded = await this.requireCompleteRun(runId);
    if (isTerminalRun(loaded.state) || loaded.state.status === "blocked") {
      return loaded.state;
    }
    if (!loaded.state.runtimeDescriptor) {
      throw new RunStoreError("corrupt-store", `Run ${runId} has no runtime descriptor`);
    }
    const descriptor = this.parseDescriptor(loaded.state.runtimeDescriptor);
    const lease = await this.acquireForRecovery(runId);
    const session = new OwnedRunSession({
      store: this.store,
      lease,
      workflow: loaded.workflow,
      loaded,
      createOperationId: this.createOperationId,
    });
    return this.finishOwnedSession(session, () =>
      this.coordinateRecovered(session, loaded.events, descriptor, operationId),
    );
  }

  /** Load folded durable state without acquiring ownership or contacting a runtime. */
  async inspect(runId: string): Promise<RunState | null> {
    return (await this.store.load(runId, "execution"))?.state ?? null;
  }

  private async initializeOwnedRun(
    workflow: WorkflowDefinition,
    options: CreateDurableRunOptions,
  ): Promise<OwnedRunSession> {
    const descriptor = this.parseDescriptor(options.descriptor);
    validateDurableRunInputs(workflow, options.inputs ?? {}, {
      workspace: options.workspace,
      descriptor,
      nodeWorkspaces: options.nodeWorkspaces,
    });
    const runId = options.runId ?? this.createRunId();
    const created = materializeEvents(undefined, runId, [
      {
        type: "RunCreated",
        workflowInstanceId: `${runId}:root`,
        workflowId: workflow.metadata.id,
        workflowVersion: workflow.metadata.version,
        nodeIds: [...workflow.nodeOrder],
        inputs: structuredClone(options.inputs ?? {}),
      },
    ]);
    const initialized = materializeEvents(created.state, runId, [
      { type: "RuntimeConfigured", descriptor },
      { type: "WorkspaceAssigned", workspace: structuredClone(options.workspace) },
      ...Object.entries(options.nodeWorkspaces ?? {}).map(([nodeId, workspace]) => ({
        type: "NodeWorkspaceAssigned" as const,
        nodeId,
        workspace: structuredClone(workspace),
      })),
      ...findExecutableNodes(workflow, created.state).map((nodeId) => ({
        type: "NodeReady" as const,
        nodeId,
        reason: "dependencies-satisfied" as const,
      })),
    ]);
    const events = [...created.events, ...initialized.events];
    const snapshot = createRunSnapshot(workflow, events);
    const receipt = await this.store.createOwned({
      runId,
      workflow,
      initialEvents: events,
      ownerId: this.createOwnerId(),
      owner: this.owner,
      operationId: this.createOperationId(),
      snapshot,
    });
    return new OwnedRunSession({
      store: this.store,
      lease: receipt.lease,
      workflow,
      loaded: { state: initialized.state, eventPrefixDigest: snapshot.eventPrefixDigest },
      createOperationId: this.createOperationId,
    });
  }

  private async finishOwnedSession(
    session: OwnedRunSession,
    operation: () => Promise<RunState>,
  ): Promise<RunState> {
    let result: RunState | undefined;
    let failure: unknown;
    try {
      result = await operation();
    } catch (error) {
      failure = error;
    }
    await session.stop();
    try {
      await this.store.release(session.lease);
    } catch (releaseError) {
      failure ??= releaseError;
    }
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error("Owned run operation failed", { cause: failure });
    }
    if (!result) {
      throw new Error("Owned run operation completed without state");
    }
    return result;
  }

  private async acquireForRecovery(runId: string): Promise<RunLeaseToken> {
    const acquisition = { runId, ownerId: this.createOwnerId(), owner: this.owner };
    const lease = await this.store.inspectLease(runId);
    if (!lease) {
      throw new RunStoreError("corrupt-store", `Run ${runId} has no ownership record`);
    }
    if (lease.released) {
      return this.store.acquireReleased(acquisition);
    }
    const observation = await this.observeProcess(lease.owner);
    if (observation.state === "alive") {
      throw new RunOwnershipBlockedError("owner-alive", lease, observation);
    }
    if (observation.state === "unknown") {
      throw new RunOwnershipBlockedError("owner-unknown", lease, observation);
    }
    if (observation.observedAtMs < lease.expiresAtMs) {
      throw new RunOwnershipBlockedError("lease-active", lease, observation);
    }
    return this.store.takeoverExpired({
      ...acquisition,
      observedLease: lease,
      ownerAbsence: observation,
    });
  }

  private async coordinateRecovered(
    session: OwnedRunSession,
    events: readonly RunEvent[],
    descriptor: RuntimeDescriptor,
    operationId: string,
  ): Promise<RunState> {
    const outstanding = outstandingObservedControl(events);
    const pending = outstanding ?? (await this.store.pendingControls(session.lease.runId, 1))[0];
    if (!(await this.reconcileInterruptedIntegration(session, operationId))) {
      return session.state;
    }
    const active = currentOwnedAttempts(session.state);
    if (active.length > 0) {
      if (pending && outstanding === undefined) {
        await this.observeControl(session, pending);
      }
      for (const owned of active) {
        if (
          !owned.attempt.executionPlan ||
          (owned.attempt.status === "running" && !owned.attempt.execution)
        ) {
          throw new RunStoreError(
            "corrupt-store",
            `Run ${session.lease.runId} has incomplete execution ownership evidence`,
          );
        }
        await this.reconcileOwnedAttempt(session, {
          nodeId: owned.nodeId,
          ...(pending ? { control: pending } : {}),
          controlAlreadyObserved: true,
          operationId,
        });
      }
      if (session.state.status === "recovery-blocked") {
        return session.state;
      }
      if (pending) {
        await this.finishRecoveredControl(session, currentOrphanedNodeIds(session.state), pending);
      } else {
        await this.continueOrphaned(session, descriptor, operationId);
      }
    } else if (pending) {
      await this.applyBoundaryControl(session, pending, outstanding === undefined);
    }
    if (pending) {
      return session.state;
    }
    if (session.state.status === "recovery-blocked") {
      if (currentOrphanedNodeIds(session.state).length === 0) {
        return session.state;
      }
      await this.continueOrphaned(session, descriptor, operationId);
    }
    if (session.state.status === "paused") {
      await this.resumePaused(session, descriptor, operationId);
    }
    if (session.state.status !== "running") {
      return session.state;
    }
    return this.coordinateRunning(session, descriptor);
  }

  private async reconcileInterruptedIntegration(
    session: OwnedRunSession,
    operationId: string,
  ): Promise<boolean> {
    const prepared = Object.entries(session.state.integrations ?? {}).find(
      ([, integration]) => integration.committed === undefined,
    );
    if (!prepared) {
      return true;
    }
    return this.reconcilePreparedIntegration(
      session,
      prepared[0],
      prepared[1].preparation,
      operationId,
    );
  }

  private async coordinateRunning(
    session: OwnedRunSession,
    descriptor: RuntimeDescriptor,
  ): Promise<RunState> {
    const active = new Map<string, ActiveAttempt>();
    while (session.state.status === "running") {
      const boundaryControl = (await this.store.pendingControls(session.lease.runId, 1))[0];
      if (boundaryControl) {
        if (active.size === 0) {
          await this.applyBoundaryControl(session, boundaryControl, true);
        } else {
          await this.finishConcurrentControl(session, active, boundaryControl, true);
        }
        continue;
      }
      const readyBeforeExpansion = findReadyNodes(session.workflow, session.state);
      if (readyBeforeExpansion.length === 0) {
        const executable = findExecutableNodes(session.workflow, session.state);
        if (executable.length > 0) {
          await this.provisionTaskWorkspaces(session, executable);
          await session.commit(
            executable.map((nodeId) => ({
              type: "NodeReady" as const,
              nodeId,
              reason: "dependencies-satisfied" as const,
            })),
          );
        }
      }
      const capacity =
        resolveRunWorkflowGraph(session.workflow, session.state).maxParallel - active.size;
      const selected = findReadyNodes(session.workflow, session.state).slice(0, capacity);
      if (await this.scheduleReadyNodes(session, descriptor, active, selected)) {
        continue;
      }
      if (session.state.status !== "running") {
        continue;
      }
      if (active.size === 0) {
        if (Object.values(session.state.nodes).every((node) => node.status === "succeeded")) {
          await session.commit([{ type: "RunCompleted", outcome: "succeeded" }], {
            snapshot: true,
          });
          continue;
        }
        throw new Error("Durable scheduler has no active or schedulable node");
      }
      const turn = await this.waitForActiveTurn(session, active);
      if (turn.kind === "control") {
        await this.finishConcurrentControl(session, active, turn.control, true);
        continue;
      }
      const completed = active.get(turn.nodeId);
      active.delete(turn.nodeId);
      if (!completed) {
        throw new Error("Completed durable execution is not active");
      }
      if (turn.kind === "failed") {
        await Promise.allSettled(
          [...active.values()].map(({ prepared }) => this.executionHost.terminate(prepared.plan)),
        );
        throw turn.error;
      }
      if (turn.outcome.kind === "timeout") {
        await this.finishTimeout(session, completed.prepared, turn.outcome);
      } else if (turn.outcome.kind === "result") {
        await this.finishExecution(session, completed.prepared, turn.outcome);
      } else if (turn.outcome.kind !== "stopped") {
        throw new Error("Concurrent execution returned an unexpected control outcome");
      }
      await this.settleConcurrentRun(session, active);
    }
    return session.state;
  }

  private async scheduleReadyNodes(
    session: OwnedRunSession,
    descriptor: RuntimeDescriptor,
    active: Map<string, ActiveAttempt>,
    nodeIds: readonly string[],
  ): Promise<boolean> {
    for (const nodeId of nodeIds) {
      const selectedNode = resolveRunWorkflowNode(session.workflow, session.state, nodeId);
      if (selectedNode?.kind === "integration") {
        await this.executeIntegrationNode(session, nodeId);
        return true;
      }
      if (!(await this.ensureAttemptBudget(session, nodeId))) {
        return false;
      }
      const workspace = assignedWorkspace(session.state, nodeId);
      if (!workspace) {
        throw new Error("Ready durable node has no filesystem workspace");
      }
      const preflight = await this.preflight(session, descriptor, workspace);
      if (!preflight.ok) {
        if (active.size > 0) {
          await this.cancelConcurrentAttempts(session, active, {
            nodeTransition: "paused",
            reason: preflight.reason,
            cause: "pause",
            operationId: this.createOperationId(),
          });
        } else {
          await this.pauseForPreflight(session, preflight.reason);
        }
        return false;
      }
      active.set(nodeId, await this.startReadyNode(session, nodeId, descriptor));
    }
    return false;
  }

  private async startReadyNode(
    session: OwnedRunSession,
    nodeId: string,
    descriptor: RuntimeDescriptor,
  ): Promise<ActiveAttempt> {
    let prepared: PreparedAttempt | undefined;
    try {
      const attempt = await this.prepareAttempt(session, nodeId, descriptor);
      prepared = attempt;
      const persisted = await session.guard(() => this.executionHost.prepare(attempt.launch));
      await session.commit([
        {
          type: "AttemptStartAuthorized",
          nodeId,
          attempt: attempt.attempt,
          execution: persisted,
        },
      ]);
      const owned = await session.guard(() => this.executionHost.authorize(persisted));
      const abort = new AbortController();
      const outcome = this.driveExecution(session, attempt, owned, abort.signal);
      void outcome.catch(() => undefined);
      return { prepared: attempt, owned, abort, outcome };
    } catch (error) {
      if (prepared) {
        await this.executionHost.terminate(prepared.plan).catch(() => undefined);
      }
      throw error;
    }
  }

  private async waitForActiveTurn(
    session: OwnedRunSession,
    active: ReadonlyMap<string, ActiveAttempt>,
  ): Promise<ActiveTurn> {
    const completions = [...active].map(([nodeId, attempt]) =>
      attempt.outcome.then(
        (outcome): ActiveTurn => ({ kind: "completed", nodeId, outcome }),
        (error: unknown): ActiveTurn => ({ kind: "failed", nodeId, error }),
      ),
    );
    for (;;) {
      const turn = await session.guard(() =>
        Promise.race([
          ...completions,
          new Promise<{ kind: "poll" }>((resolve) => {
            setTimeout(() => resolve({ kind: "poll" }), CONTROL_POLL_INTERVAL_MS);
          }),
        ]),
      );
      if (turn.kind !== "poll") {
        return turn;
      }
      const control = (await this.store.pendingControls(session.lease.runId, 1))[0];
      if (control) {
        return { kind: "control", control };
      }
    }
  }

  private async finishConcurrentControl(
    session: OwnedRunSession,
    active: Map<string, ActiveAttempt>,
    control: ControlRequest,
    observe: boolean,
  ): Promise<void> {
    if (observe) {
      await this.observeControl(session, control);
    }
    const reason: PauseReason = { kind: "operator", operationId: control.operationId };
    await this.cancelConcurrentAttempts(session, active, {
      cause: control.action,
      operationId: control.operationId,
      ...(control.action === "pause"
        ? { nodeTransition: "paused", reason, runTransition: "paused" }
        : {
            nodeTransition: "cancelled",
            reason: "operator",
            runTransition: "cancelled",
          }),
    });
  }

  private async cancelConcurrentAttempts(
    session: OwnedRunSession,
    active: Map<string, ActiveAttempt>,
    options:
      | {
          cause: "pause" | "cancel";
          operationId: string;
          nodeTransition: "paused";
          reason: PauseReason;
          runTransition?: "paused";
        }
      | {
          cause: "pause" | "cancel";
          operationId: string;
          nodeTransition: "cancelled";
          reason: string;
          runTransition?: "cancelled";
        },
  ): Promise<void> {
    const attempts = [...active.values()];
    for (const attempt of attempts) {
      attempt.abort.abort();
    }
    const observations = await Promise.all(
      attempts.map(async ({ owned, prepared }) =>
        owned.cancel().catch((): ExecutionObservation => ({
          state: "unknown",
          execution: prepared.plan,
          reason: "cleanup-unconfirmed",
        })),
      ),
    );
    await Promise.allSettled(attempts.map(({ outcome }) => outcome));
    active.clear();
    const payloads: RunEventPayload[] = [];
    const unresolved: string[] = [];
    for (const [index, activeAttempt] of attempts.entries()) {
      const { prepared } = activeAttempt;
      const observation = observations[index]!;
      const confirmed = observation.state === "absent";
      payloads.push({
        type: "ExecutionCleanupObserved",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        executionId: prepared.plan.executionId,
        cause: options.cause,
        outcome: confirmed ? "confirmed" : "unknown",
      });
      if (!confirmed) {
        unresolved.push(prepared.plan.executionId);
        continue;
      }
      const finalCheckpoint = await this.captureCheckpoint(session, {
        workspace: prepared.request.workspace,
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        alwaysPersistDiff: true,
      });
      if (!finalCheckpoint.artifact) {
        throw new Error("Cancelled workspace capture did not publish its diff artifact");
      }
      payloads.push(
        {
          type: "ArtifactProduced",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          artifact: finalCheckpoint.artifact,
        },
        {
          type: "WorkspaceObserved",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          headCommit: finalCheckpoint.checkpoint.headCommit,
          changedFiles: finalCheckpoint.checkpoint.changedFiles,
          diffArtifactId: finalCheckpoint.artifact.id,
        },
        {
          type: "AttemptCancelled",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          reason:
            options.nodeTransition === "paused" ? `pause-${options.reason.kind}` : options.reason,
        },
      );
      if (options.nodeTransition === "paused") {
        payloads.push({
          type: "NodePaused",
          nodeId: prepared.nodeId,
          reason: options.reason,
        });
      } else {
        payloads.push({
          type: "NodeCancelled",
          nodeId: prepared.nodeId,
          reason: options.reason,
        });
      }
    }
    if (unresolved.length > 0) {
      payloads.push({
        type: "RunRecoveryBlocked",
        operationId: options.operationId,
        reason:
          unresolved.length === 1
            ? { kind: "cleanup-unknown", executionId: unresolved[0]! }
            : { kind: "cleanup-unknown-set", executionIds: unresolved },
      });
    } else if (options.runTransition === "paused") {
      payloads.push({ type: "RunPaused", reason: options.reason });
    } else if (options.runTransition === "cancelled") {
      const activeNodeIds = new Set(attempts.map(({ prepared }) => prepared.nodeId));
      payloads.push(...cancelNodePayloads(session.state, "operator", activeNodeIds), {
        type: "RunCancelled",
        operationId: options.operationId,
        reason: "operator",
      });
    }
    await session.commit(payloads, { snapshot: true });
  }

  private async settleConcurrentRun(
    session: OwnedRunSession,
    active: Map<string, ActiveAttempt>,
  ): Promise<void> {
    const failed = Object.values(session.state.nodes).find((node) => node.status === "failed");
    const blocked = Object.values(session.state.nodes).find((node) => node.status === "blocked");
    const cancelled = Object.values(session.state.nodes).find(
      (node) => node.status === "cancelled",
    );
    if (!failed && !blocked && !cancelled) {
      return;
    }
    if (active.size > 0) {
      let siblingReason = "sibling-cancelled";
      if (failed) {
        siblingReason = "sibling-failed";
      } else if (blocked) {
        siblingReason = "sibling-blocked";
      }
      await this.cancelConcurrentAttempts(session, active, {
        cause: "cancel",
        operationId: this.createOperationId(),
        nodeTransition: "cancelled",
        reason: siblingReason,
      });
    }
    if (session.state.status === "recovery-blocked") {
      return;
    }
    if (failed) {
      await session.commit(
        [
          ...blockedNodePayloads(session.state, failed.id, "A dependency failed"),
          { type: "RunCompleted", outcome: "failed" },
        ],
        { snapshot: true },
      );
    } else if (blocked) {
      await session.commit(
        [
          ...blockedNodePayloads(session.state, blocked.id, blocked.blockedReason ?? "Run blocked"),
          { type: "RunBlocked", reason: blocked.blockedReason ?? "Run blocked" },
        ],
        { snapshot: true },
      );
    } else if (cancelled) {
      await session.commit(
        [
          ...cancelNodePayloads(session.state, "execution-cancelled"),
          { type: "RunCancelled", reason: "execution-cancelled" },
        ],
        { snapshot: true },
      );
    }
  }

  private async prepareAttempt(
    session: OwnedRunSession,
    nodeId: string,
    descriptor: RuntimeDescriptor,
  ): Promise<PreparedAttempt> {
    const state = session.state;
    const node = resolveRunWorkflowNode(session.workflow, state, nodeId);
    const nodeState = state.nodes[nodeId];
    const workspace = assignedWorkspace(state, nodeId);
    if (!node || !nodeState || nodeState.status !== "ready" || !workspace) {
      throw new Error("Ready durable attempt is missing its node or filesystem workspace");
    }
    const attempt = nodeState.attempts.length + 1;
    const checkpoint = await this.captureCheckpoint(session, {
      workspace,
      nodeId,
      attempt,
      alwaysPersistDiff: false,
    });
    const context = buildContext({ workflow: session.workflow, state, nodeId, attempt, workspace });
    const contextArtifact = await this.writeArtifact(session, {
      nodeId,
      attempt,
      type: "context",
      mediaType: "application/json",
      bytes: context.bytes,
    });
    const request: ExecutionRequest = {
      runId: state.runId,
      workflowInstanceId: state.workflowInstanceId,
      nodeId,
      nodeKind: node.kind,
      attempt,
      ...(node.role ? { role: { id: node.role } } : {}),
      workspace,
      context: context.envelope,
      budget: context.envelope.budget!,
      requiredOutputSchema: context.envelope.requiredOutputSchema!,
      toolPolicy: { allowMutations: node.mutation === "isolated" },
    };
    const unplanned = {
      runId: state.runId,
      executionId: this.createExecutionId(),
      generation: session.lease.generation,
      coordinator: this.owner,
    };
    const runsCommand =
      (node.kind === "command" || node.kind === "verifier") && node.command !== undefined;
    const input = runsCommand
      ? createPrepareExecution({ ...unplanned, command: node.command!, workspace })
      : createPrepareExecution({ ...unplanned, descriptor, request });
    const artifactPayloads: RunEventPayload[] = [
      { type: "ArtifactProduced", nodeId, attempt, artifact: contextArtifact },
      ...(checkpoint.artifact
        ? [{ type: "ArtifactProduced" as const, nodeId, attempt, artifact: checkpoint.artifact }]
        : []),
    ];
    await session.commit(
      [
        {
          type: "AttemptScheduled",
          nodeId,
          attempt,
          runtimeId: runsCommand ? "command" : descriptor.runtimeId,
        },
        ...artifactPayloads,
        {
          type: "AttemptPrepared",
          nodeId,
          attempt,
          execution: input.plan,
          workspaceCheckpoint: checkpoint.checkpoint,
        },
      ],
      { snapshot: true },
    );
    return {
      node,
      nodeId,
      attempt,
      request,
      plan: input.plan,
      launch: input,
      checkpoint: checkpoint.checkpoint,
    };
  }

  private async driveExecution(
    session: OwnedRunSession,
    prepared: PreparedAttempt,
    owned: OwnedExecution,
    signal = new AbortController().signal,
  ): Promise<ConcurrentDriveOutcome> {
    const iterator = owned.events()[Symbol.asyncIterator]();
    const collection = owned.collect();
    void collection.catch(() => undefined);
    let next = iterator.next();
    const logs: Buffer[] = [];
    let logBytes = 0;
    const observations = new PublicObservationFilter();
    const maxDurationMs = prepared.request.budget.maxDurationMs;
    const deadline = maxDurationMs === undefined ? undefined : Date.now() + maxDurationMs;
    for (;;) {
      const turn = await session.guard(() => waitForExecutionTurn(next, deadline));
      if (signal.aborted) {
        await iterator.return?.().catch(() => undefined);
        return { kind: "stopped" };
      }
      if (turn.kind === "event") {
        if (turn.value.done) {
          const result = await session.guard(() => collection);
          return { kind: "result", result, logs: Buffer.concat(logs) };
        }
        const event = turn.value.value;
        assertRuntimeEvent(event);
        if (observations.accept(event)) {
          await session.commit([
            {
              type: "RuntimeEventObserved",
              nodeId: prepared.nodeId,
              attempt: prepared.attempt,
              event,
            },
          ]);
          if (event.type === "log" && logBytes < LOG_ARTIFACT_MAX_BYTES) {
            const bytes = Buffer.from(`${event.message}\n`).subarray(
              0,
              LOG_ARTIFACT_MAX_BYTES - logBytes,
            );
            logs.push(bytes);
            logBytes += bytes.length;
          }
        }
        next = iterator.next();
        continue;
      }
      if (turn.kind === "timeout") {
        await session.commit([
          {
            type: "AttemptTimeoutRequested",
            nodeId: prepared.nodeId,
            attempt: prepared.attempt,
          },
        ]);
        const cancellation = owned.cancel().catch((): ExecutionObservation => ({
          state: "unknown",
          execution: prepared.plan,
          reason: "cleanup-unconfirmed",
        }));
        await iterator.return?.().catch(() => undefined);
        return {
          kind: "timeout",
          observation: await cancellation,
          logs: Buffer.concat(logs),
        };
      }
      continue;
    }
  }

  private async finishExecution(
    session: OwnedRunSession,
    prepared: PreparedAttempt,
    driven: RuntimeDriveResult,
  ): Promise<void> {
    const evidence: RunEventPayload[] = [];
    let result: ExecutionResult;
    if (prepared.plan.kind === "command") {
      const command = driven.result as CommandExecution;
      for (const [type, mediaType, bytes] of [
        ["stdout", "text/plain", command.stdout],
        ["stderr", "text/plain", command.stderr],
        ["command-result", "application/json", canonicalJson(command.output)],
      ] as const) {
        const artifact = await this.writeArtifact(session, {
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          type,
          mediaType,
          bytes,
        });
        evidence.push({
          type: "ArtifactProduced",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          artifact,
        });
      }
      evidence.push({
        type: "CommandCompleted",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        output: command.output,
      });
      result = command.failure
        ? { status: "failed", failure: command.failure }
        : {
            status: "succeeded",
            output: structuredClone(command.output) as unknown as JsonValue,
          };
    } else {
      result = driven.result as ExecutionResult;
      assertExecutionResult(result);
      const logs = await this.writeArtifact(session, {
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        type: "logs",
        mediaType: "text/plain",
        bytes: driven.logs,
      });
      evidence.push({
        type: "ArtifactProduced",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        artifact: logs,
      });
      if (result.status === "succeeded") {
        const report = await this.writeArtifact(session, {
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          type: "worker-report",
          mediaType: "application/json",
          bytes: canonicalJson(result.output),
        });
        evidence.push({
          type: "ArtifactProduced",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          artifact: report,
        });
      }
    }
    const workspace = prepared.request.workspace;
    if (!workspace || workspace.mode === "memory") {
      throw new Error("Durable attempt lost its filesystem workspace");
    }
    const finalCheckpoint = await this.captureCheckpoint(session, {
      workspace,
      nodeId: prepared.nodeId,
      attempt: prepared.attempt,
      alwaysPersistDiff: true,
    });
    if (!finalCheckpoint.artifact) {
      throw new Error("Final workspace capture did not publish its diff artifact");
    }
    evidence.push({
      type: "ArtifactProduced",
      nodeId: prepared.nodeId,
      attempt: prepared.attempt,
      artifact: finalCheckpoint.artifact,
    });
    evidence.push({
      type: "WorkspaceObserved",
      nodeId: prepared.nodeId,
      attempt: prepared.attempt,
      headCommit: finalCheckpoint.checkpoint.headCommit,
      changedFiles: finalCheckpoint.checkpoint.changedFiles,
      diffArtifactId: finalCheckpoint.artifact.id,
    });
    const comparison = this.workspace.compare(prepared.checkpoint, finalCheckpoint.checkpoint);
    if (workspace.mode === "readonly" && !comparison.matches) {
      result = {
        status: "failed",
        failure: { category: "policy-violation", message: "Readonly workspace was mutated" },
      };
    }
    await this.finishResult(session, { prepared, result, evidence, comparison });
  }

  private async finishResult(
    session: OwnedRunSession,
    options: FinishResultOptions,
  ): Promise<void> {
    const { prepared, comparison } = options;
    const evidence = [...options.evidence];
    let { result } = options;
    let expansionPayload: Extract<RunEventPayload, { type: "WorkflowExpanded" }> | undefined;
    const configured = session.workflow.definedSdlc;
    if (
      result.status === "succeeded" &&
      configured &&
      prepared.nodeId === configured.planningNodeId
    ) {
      try {
        const plan = normalizeFeaturePlan(result.output, configured.feature.policies);
        expansionPayload = {
          type: "WorkflowExpanded",
          sourceNodeId: prepared.nodeId,
          plan,
          expansion: expandSdlcPlan(configured.feature, configured.methodology, plan),
        };
      } catch {
        result = {
          status: "failed",
          failure: {
            category: "schema-violation",
            message: "Planner output violates the configured Feature planning policy",
          },
        };
      }
    }
    if (result.status === "blocked") {
      const reason = result.reason;
      await session.commit(
        [
          ...evidence,
          { type: "AttemptBlocked", nodeId: prepared.nodeId, attempt: prepared.attempt, reason },
          { type: "NodeBlocked", nodeId: prepared.nodeId, reason },
        ],
        { snapshot: true },
      );
      return;
    }
    if (result.status === "cancelled") {
      await session.commit(
        [
          ...evidence,
          {
            type: "AttemptCancelled",
            nodeId: prepared.nodeId,
            attempt: prepared.attempt,
            reason: result.reason,
          },
          { type: "NodeCancelled", nodeId: prepared.nodeId, reason: result.reason },
        ],
        { snapshot: true },
      );
      return;
    }
    const failure = normalizedFailure(prepared.node, result);
    if (failure) {
      const terminal: RunEventPayload[] = [
        ...evidence,
        {
          type: "AttemptFailed",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          failure,
        },
      ];
      if (!comparison.matches) {
        const reason: PauseReason = {
          kind: "workspace-conflict",
          differences: comparison.differences,
        };
        terminal.push(
          { type: "NodePaused", nodeId: prepared.nodeId, reason },
          { type: "RunPaused", reason },
        );
      } else if (prepared.attempt < prepared.node.attemptBudget.maxAttempts) {
        terminal.push({ type: "NodeReady", nodeId: prepared.nodeId, reason: "retry" });
      } else {
        terminal.push({ type: "NodeFailed", nodeId: prepared.nodeId, failure });
      }
      await session.commit(terminal, { snapshot: true });
      return;
    }
    if (result.status !== "succeeded") {
      throw new Error(`Unhandled execution result ${result.status}`);
    }
    if (prepared.node.patchId) {
      evidence.push(...(await this.acceptTaskPatch(session, prepared)));
    }
    await session.commit(
      [
        ...evidence,
        {
          type: "AttemptSucceeded",
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          output: result.output,
        },
        { type: "NodeSucceeded", nodeId: prepared.nodeId },
        ...(expansionPayload ? [expansionPayload] : []),
      ],
      { snapshot: true },
    );
    const ready = findExecutableNodes(session.workflow, session.state);
    if (ready.length > 0) {
      await this.provisionTaskWorkspaces(session, ready);
      await session.commit(
        ready.map((nodeId) => ({
          type: "NodeReady" as const,
          nodeId,
          reason: "dependencies-satisfied" as const,
        })),
      );
    }
    if (Object.values(session.state.nodes).every((node) => node.status === "succeeded")) {
      await session.commit([{ type: "RunCompleted", outcome: "succeeded" }], { snapshot: true });
    }
  }

  private async provisionTaskWorkspaces(
    session: OwnedRunSession,
    nodeIds: readonly string[],
  ): Promise<void> {
    for (const nodeId of nodeIds) {
      const state = session.state;
      const node = resolveRunWorkflowNode(session.workflow, state, nodeId);
      if (!node?.patchId || state.nodeWorkspaces?.[nodeId]) {
        continue;
      }
      if (!this.workspace.createTaskWorkspace) {
        throw new Error("Defined-SDLC execution requires task-workspace creation");
      }
      const integration = state.workspace;
      if (!integration || integration.mode !== "isolated") {
        throw new Error("Defined-SDLC execution requires an isolated integration workspace");
      }
      const integrationDependency = node.needs
        .map((dependency) => state.nodes[dependency]?.output)
        .find(
          (output): output is { commit: string } =>
            output !== undefined &&
            output !== null &&
            !Array.isArray(output) &&
            typeof output === "object" &&
            typeof output.commit === "string",
        );
      const workspace = await session.guard(() =>
        this.workspace.createTaskWorkspace!({
          runId: state.runId,
          taskId: node.patchId!,
          baseCommit: integrationDependency?.commit ?? integration.baseCommit,
        }),
      );
      await session.commit([{ type: "NodeWorkspaceAssigned", nodeId, workspace }]);
    }
  }

  private async acceptTaskPatch(
    session: OwnedRunSession,
    prepared: PreparedAttempt,
  ): Promise<RunEventPayload[]> {
    if (!this.workspace.captureAcceptedPatch || !prepared.node.patchId) {
      throw new Error("Defined-SDLC execution requires scoped patch capture");
    }
    const workspace = prepared.request.workspace;
    if (workspace.mode !== "isolated") {
      throw new Error("Implementation patch capture requires an isolated workspace");
    }
    const accepted = await session.guard(() =>
      this.workspace.captureAcceptedPatch!({
        runId: session.lease.runId,
        taskId: prepared.node.patchId!,
        workspace,
        mutationScopes: prepared.node.mutationScopes ?? [],
      }),
    );
    const artifact = await this.writeArtifact(session, {
      nodeId: prepared.nodeId,
      attempt: prepared.attempt,
      type: "accepted-patch",
      mediaType: "text/x-diff",
      bytes: accepted.patch,
    });
    if (artifact.digest !== accepted.patchDigest) {
      throw new Error("Accepted patch artifact digest changed during persistence");
    }
    return [
      { type: "ArtifactProduced", nodeId: prepared.nodeId, attempt: prepared.attempt, artifact },
      {
        type: "TaskPatchAccepted",
        patch: {
          taskId: prepared.node.patchId,
          nodeId: prepared.nodeId,
          attempt: prepared.attempt,
          workspaceId: accepted.workspaceId,
          baseCommit: accepted.baseCommit,
          headCommit: accepted.headCommit,
          changedFiles: [...accepted.changedFiles],
          mutationScopes: [...accepted.mutationScopes],
          patchArtifactId: artifact.id,
          patchDigest: artifact.digest,
        },
      },
    ];
  }

  private async executeIntegrationNode(session: OwnedRunSession, nodeId: string): Promise<void> {
    const state = session.state;
    const node = resolveRunWorkflowNode(session.workflow, state, nodeId);
    if (
      node?.kind !== "integration" ||
      !node.controller ||
      !this.workspace.prepareIntegration ||
      !this.workspace.reconcileIntegration ||
      !this.artifacts.read
    ) {
      throw new Error("Defined-SDLC execution requires durable integration services");
    }
    const patches = await Promise.all(
      node.controller.taskIds.map(async (taskId) => {
        const evidence = state.acceptedPatches?.[taskId];
        const artifact = state.artifacts?.find(
          (candidate) => candidate.id === evidence?.patchArtifactId,
        );
        if (!evidence || !artifact) {
          throw new Error(`Integration is missing accepted patch ${JSON.stringify(taskId)}`);
        }
        const patch = await session.guard(() => this.artifacts.read!(artifact));
        return {
          taskId,
          accepted: {
            version: "anastom.dev/accepted-workspace-patch/v1alpha1" as const,
            workspaceId: evidence.workspaceId,
            baseCommit: evidence.baseCommit,
            headCommit: evidence.headCommit,
            changedFiles: [...evidence.changedFiles],
            mutationScopes: [...evidence.mutationScopes],
            patch,
            patchDigest: evidence.patchDigest,
          },
        };
      }),
    );
    let preparation: IntegrationPreparationEvidence;
    try {
      preparation = await session.guard(() =>
        this.workspace.prepareIntegration!({ runId: state.runId, patches }),
      );
    } catch {
      const failure: ExecutionFailure = {
        category: "workspace-conflict",
        message: "Controller-owned integration could not prepare the accepted patches",
      };
      await session.commit(
        [
          { type: "IntegrationFailed", nodeId, failure },
          ...blockedNodePayloads(session.state, nodeId, "Integration failed"),
          { type: "RunCompleted", outcome: "failed" },
        ],
        { snapshot: true },
      );
      return;
    }
    await session.commit([{ type: "IntegrationPrepared", nodeId, preparation }], {
      snapshot: true,
    });
    await this.reconcilePreparedIntegration(session, nodeId, preparation, this.createOperationId());
  }

  private async reconcilePreparedIntegration(
    session: OwnedRunSession,
    nodeId: string,
    preparation: IntegrationPreparationEvidence,
    operationId: string,
  ): Promise<boolean> {
    const resumesBlockedIntegration =
      session.state.status === "recovery-blocked" &&
      session.state.recoveryBlock?.reason.kind === "integration-unknown" &&
      session.state.recoveryBlock.reason.nodeId === nodeId;
    try {
      await this.commitPreparedIntegration(session, nodeId, preparation);
      if (resumesBlockedIntegration) {
        await session.commit([{ type: "RunResumed", operationId }], { snapshot: true });
      }
      return true;
    } catch {
      await session.commit(
        [
          {
            type: "RunRecoveryBlocked",
            operationId,
            reason: {
              kind: "integration-unknown",
              nodeId,
              preparationDigest: preparation.preparationDigest,
            },
          },
        ],
        { snapshot: true },
      );
      return false;
    }
  }

  private async commitPreparedIntegration(
    session: OwnedRunSession,
    nodeId: string,
    preparation: IntegrationPreparationEvidence,
  ): Promise<void> {
    if (!this.workspace.reconcileIntegration) {
      throw new Error("Defined-SDLC execution requires durable integration reconciliation");
    }
    const reconciled = await session.guard(() =>
      this.workspace.reconcileIntegration!({ runId: session.lease.runId, preparation }),
    );
    const integration = session.state.workspace;
    if (!integration || integration.mode !== "isolated") {
      throw new Error("Integration workspace identity is missing");
    }
    const captured = await session.guard(() => this.workspace.capture(integration));
    if (captured.checkpoint.headCommit !== reconciled.commit) {
      throw new Error("Committed integration checkpoint does not match the prepared commit");
    }
    await session.commit(
      [
        {
          type: "IntegrationCommitted",
          nodeId,
          commit: reconciled.commit,
          checkpoint: captured.checkpoint,
        },
      ],
      { snapshot: true },
    );
  }

  private async finishTimeout(
    session: OwnedRunSession,
    prepared: PreparedAttempt,
    driven: RuntimeDriveTimeout,
  ): Promise<void> {
    const cancellation = driven.observation.state === "absent" ? "succeeded" : "failed";
    const cleanup = driven.observation.state === "absent" ? "confirmed" : "unknown";
    const timeoutEvidence: RunEventPayload[] = [
      {
        type: "AttemptCancellationCompleted",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        outcome: cancellation,
      },
      {
        type: "ExecutionCleanupObserved",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        executionId: prepared.plan.executionId,
        cause: "timeout",
        outcome: cleanup,
      },
    ];
    if (driven.observation.state !== "absent") {
      const reason: RecoveryBlockReason = {
        kind: "cleanup-unknown",
        executionId: prepared.plan.executionId,
      };
      await session.commit(
        [
          ...timeoutEvidence,
          { type: "RunRecoveryBlocked", operationId: this.createOperationId(), reason },
        ],
        { snapshot: true },
      );
      return;
    }
    const workspace = prepared.request.workspace;
    if (!workspace || workspace.mode === "memory") {
      throw new Error("Durable attempt lost its filesystem workspace");
    }
    const finalCheckpoint = await this.captureCheckpoint(session, {
      workspace,
      nodeId: prepared.nodeId,
      attempt: prepared.attempt,
      alwaysPersistDiff: true,
    });
    if (!finalCheckpoint.artifact) {
      throw new Error("Final workspace capture did not publish its diff artifact");
    }
    const logs = await this.writeArtifact(session, {
      nodeId: prepared.nodeId,
      attempt: prepared.attempt,
      type: "logs",
      mediaType: "text/plain",
      bytes: driven.logs,
    });
    const evidence: RunEventPayload[] = [
      ...timeoutEvidence,
      {
        type: "ArtifactProduced",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        artifact: logs,
      },
      {
        type: "ArtifactProduced",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        artifact: finalCheckpoint.artifact,
      },
      {
        type: "WorkspaceObserved",
        nodeId: prepared.nodeId,
        attempt: prepared.attempt,
        headCommit: finalCheckpoint.checkpoint.headCommit,
        changedFiles: finalCheckpoint.checkpoint.changedFiles,
        diffArtifactId: finalCheckpoint.artifact.id,
      },
    ];
    await this.finishResult(session, {
      prepared,
      result: {
        status: "failed",
        failure: {
          category: "budget-exhausted",
          message: "Attempt exceeded its duration limit",
        },
      },
      evidence,
      comparison: this.workspace.compare(prepared.checkpoint, finalCheckpoint.checkpoint),
    });
  }

  private async reconcileOwnedAttempt(
    session: OwnedRunSession,
    options: ReconcileAttemptOptions,
  ): Promise<void> {
    const { nodeId, control, operationId } = options;
    const state = session.state;
    const attempt = state.nodes[nodeId]!.attempts.at(-1)!;
    const plan = attempt.executionPlan!;
    if (control && !options.controlAlreadyObserved) {
      await this.observeControl(session, control);
    }
    if (
      !(await this.establishRecoveredAbsence(session, {
        nodeId,
        attempt,
        plan,
        ...(control ? { control } : {}),
        operationId,
      }))
    ) {
      return;
    }
    const workspace = assignedWorkspace(session.state, nodeId);
    if (!workspace || !attempt.workspaceCheckpoint) {
      throw new RunStoreError(
        "corrupt-store",
        `Run ${session.lease.runId} has incomplete workspace recovery evidence`,
      );
    }
    const observed = await this.captureCheckpoint(session, {
      workspace,
      nodeId,
      attempt: attempt.number,
      alwaysPersistDiff: true,
    });
    const comparison = this.workspace.compare(attempt.workspaceCheckpoint, observed.checkpoint);
    const payloads: RunEventPayload[] = [];
    if (observed.artifact) {
      payloads.push({
        type: "ArtifactProduced",
        nodeId,
        attempt: attempt.number,
        artifact: observed.artifact,
      });
    }
    const cause = control?.action ?? "recovery";
    if (!attempt.cleanup?.some((value) => value.cause === cause)) {
      payloads.push({
        type: "ExecutionCleanupObserved",
        nodeId,
        attempt: attempt.number,
        executionId: plan.executionId,
        cause,
        outcome: "confirmed",
      });
    }
    payloads.push({
      type: "AttemptOrphaned",
      nodeId,
      attempt: attempt.number,
      executionId: plan.executionId,
      lostGeneration: plan.generation,
      reason: attempt.status === "prepared" ? "launch-interrupted" : "coordinator-lost",
      workspaceObservation: observed.checkpoint,
      workspaceDifferences: comparison.differences,
    });
    await session.commit(payloads, { snapshot: true });
  }

  private async establishRecoveredAbsence(
    session: OwnedRunSession,
    options: RecoveredAbsenceOptions,
  ): Promise<boolean> {
    const { nodeId, attempt, plan, control, operationId } = options;
    let observation = await session.guard(() => this.executionHost.inspect(plan));
    if (observation.state === "unknown") {
      await this.blockExecutionUnknown(
        session,
        control?.operationId ?? operationId,
        plan,
        observation,
      );
      return false;
    }
    if (observation.state === "absent") {
      return true;
    }
    observation = await session.guard(() => this.executionHost.terminate(plan));
    if (observation.state === "absent") {
      return true;
    }
    const cause = control?.action ?? "recovery";
    const payloads: RunEventPayload[] = [];
    if (!attempt.cleanup?.some((value) => value.cause === cause)) {
      payloads.push({
        type: "ExecutionCleanupObserved",
        nodeId,
        attempt: attempt.number,
        executionId: plan.executionId,
        cause,
        outcome: "unknown",
      });
    }
    payloads.push({
      type: "RunRecoveryBlocked",
      operationId: control?.operationId ?? operationId,
      reason: { kind: "cleanup-unknown", executionId: plan.executionId },
    });
    await session.commit(payloads, { snapshot: true });
    return false;
  }

  private async continueOrphaned(
    session: OwnedRunSession,
    descriptor: RuntimeDescriptor,
    operationId: string,
  ): Promise<void> {
    const state = session.state;
    const nodeIds = currentOrphanedNodeIds(state);
    if (nodeIds.length === 0) {
      throw new Error("Recovery continuation requires an orphaned current attempt");
    }
    let pauseReason: PauseReason | undefined;
    for (const nodeId of nodeIds) {
      const nodeState = state.nodes[nodeId]!;
      const attempt = nodeState.attempts.at(-1)!;
      const node = resolveRunWorkflowNode(session.workflow, state, nodeId);
      if (!attempt.orphan || !node) {
        throw new Error("Recovery continuation lost orphaned attempt evidence");
      }
      if (attempt.orphan.workspaceDifferences.length > 0) {
        pauseReason = {
          kind: "workspace-conflict",
          differences: attempt.orphan.workspaceDifferences,
        };
        break;
      }
      if (attempt.number >= node.attemptBudget.maxAttempts) {
        pauseReason = {
          kind: "attempt-budget-exhausted",
          nodeId,
          attempts: attempt.number,
        };
        break;
      }
    }
    if (pauseReason) {
      await session.commit(
        [
          ...nodeIds.map((nodeId) => ({
            type: "NodePaused" as const,
            nodeId,
            reason: pauseReason,
          })),
          { type: "RunPaused", reason: pauseReason },
        ],
        { snapshot: true },
      );
      return;
    }
    const preflight = await this.preflight(
      session,
      descriptor,
      assignedWorkspace(state, nodeIds[0]!),
    );
    if (!preflight.ok) {
      await session.commit(
        [
          ...nodeIds.map((nodeId) => ({
            type: "NodePaused" as const,
            nodeId,
            reason: preflight.reason,
          })),
          { type: "RunPaused", reason: preflight.reason },
        ],
        { snapshot: true },
      );
      return;
    }
    await session.commit(
      [
        ...nodeIds.map((nodeId) => ({
          type: "NodeReady" as const,
          nodeId,
          reason: "recovered" as const,
        })),
        ...(session.state.status === "recovery-blocked"
          ? [{ type: "RunResumed" as const, operationId }]
          : []),
      ],
      { snapshot: true },
    );
  }

  private async finishRecoveredControl(
    session: OwnedRunSession,
    nodeIds: readonly string[],
    control: ControlRequest,
  ): Promise<void> {
    if (control.action === "pause") {
      const reason: PauseReason = { kind: "operator", operationId: control.operationId };
      await session.commit(
        [
          ...nodeIds.map((nodeId) => ({ type: "NodePaused" as const, nodeId, reason })),
          { type: "RunPaused", reason },
        ],
        { snapshot: true },
      );
      return;
    }
    await session.commit(
      [
        ...cancelNodePayloads(session.state, "operator"),
        { type: "RunCancelled", operationId: control.operationId, reason: "operator" },
      ],
      { snapshot: true },
    );
  }

  private async resumePaused(
    session: OwnedRunSession,
    descriptor: RuntimeDescriptor,
    operationId: string,
  ): Promise<void> {
    const state = session.state;
    const paused = Object.values(state.nodes).filter((node) => node.status === "paused");
    for (const nodeState of paused) {
      const node = resolveRunWorkflowNode(session.workflow, state, nodeState.id);
      const attempt = nodeState.attempts.at(-1);
      if (!node || nodeState.pauseReason?.kind === "attempt-budget-exhausted") {
        return;
      }
      if (attempt && attempt.number >= node.attemptBudget.maxAttempts) {
        return;
      }
      if (nodeState.pauseReason?.kind === "workspace-conflict") {
        const workspace = assignedWorkspace(state, nodeState.id);
        if (!workspace || !attempt?.workspaceCheckpoint) {
          return;
        }
        const observed = await session.guard(() => this.workspace.capture(workspace));
        if (!this.workspace.compare(attempt.workspaceCheckpoint, observed.checkpoint).matches) {
          return;
        }
      }
    }
    const preflight = await this.preflight(session, descriptor);
    if (!preflight.ok) {
      return;
    }
    await session.commit(
      [
        ...paused.map((node) => ({
          type: "NodeReady" as const,
          nodeId: node.id,
          reason: "resumed" as const,
        })),
        { type: "RunResumed", operationId },
      ],
      { snapshot: true },
    );
  }

  private async applyBoundaryControl(
    session: OwnedRunSession,
    control: ControlRequest,
    observe: boolean,
  ): Promise<void> {
    const payloads: RunEventPayload[] = observe ? [controlObservedPayload(control)] : [];
    if (control.action === "pause") {
      if (session.state.status !== "paused") {
        const reason: PauseReason = { kind: "operator", operationId: control.operationId };
        payloads.push({ type: "RunPaused", reason });
      }
    } else {
      payloads.push(...cancelNodePayloads(session.state, "operator"), {
        type: "RunCancelled",
        operationId: control.operationId,
        reason: "operator",
      });
    }
    await session.commit(payloads, {
      snapshot: true,
      ...(observe ? { handlesControlOperationId: control.operationId } : {}),
    });
  }

  private async observeControl(session: OwnedRunSession, control: ControlRequest): Promise<void> {
    await session.commit([controlObservedPayload(control)], {
      handlesControlOperationId: control.operationId,
    });
  }

  private async blockExecutionUnknown(
    session: OwnedRunSession,
    operationId: string,
    plan: ExecutionPlanRef,
    observation: Extract<ExecutionObservation, { state: "unknown" }>,
  ): Promise<void> {
    await session.commit(
      [
        {
          type: "RunRecoveryBlocked",
          operationId,
          reason: {
            kind: "execution-unknown",
            executionId: plan.executionId,
            detail: observation.reason,
          },
        },
      ],
      { snapshot: true },
    );
  }

  private async preflight(
    session: OwnedRunSession,
    descriptor: RuntimeDescriptor,
    selectedWorkspace = session.state.workspace,
  ): Promise<{ ok: true; negotiation: RuntimeNegotiation } | { ok: false; reason: PauseReason }> {
    try {
      const adapter = await session.guard(() => this.runtimes.create(descriptor));
      const workspace = selectedWorkspace;
      if (!workspace || workspace.mode === "memory") {
        throw new Error("Durable runtime preflight requires a filesystem workspace");
      }
      const negotiation = await session.guard(() => probeRuntime(adapter, workspace.mode));
      if (
        !session.state.runtimeNegotiation &&
        Object.values(session.state.nodes).every((node) => node.attempts.length === 0)
      ) {
        await session.commit([{ type: "RuntimeNegotiated", negotiation }]);
      }
      return { ok: true, negotiation };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof RuntimePreflightError && error.category === "policy-violation"
            ? { kind: "policy-violation", runtimeId: descriptor.runtimeId }
            : { kind: "runtime-unavailable", runtimeId: descriptor.runtimeId },
      };
    }
  }

  private async pauseForPreflight(
    session: OwnedRunSession,
    reason: PauseReason,
    activeNodeId?: string,
  ): Promise<void> {
    const payloads: RunEventPayload[] = [];
    if (activeNodeId) {
      payloads.push({ type: "NodePaused", nodeId: activeNodeId, reason });
    }
    payloads.push({ type: "RunPaused", reason });
    await session.commit(payloads, { snapshot: true });
  }

  private async ensureAttemptBudget(session: OwnedRunSession, nodeId: string): Promise<boolean> {
    const node = resolveRunWorkflowNode(session.workflow, session.state, nodeId);
    const nodeState = session.state.nodes[nodeId];
    if (!node || !nodeState) {
      throw new Error("Ready durable node is missing from its workflow");
    }
    if (nodeState.attempts.length < node.attemptBudget.maxAttempts) {
      return true;
    }
    const reason: PauseReason = {
      kind: "attempt-budget-exhausted",
      nodeId,
      attempts: nodeState.attempts.length,
    };
    await session.commit(
      [
        { type: "NodePaused", nodeId, reason },
        { type: "RunPaused", reason },
      ],
      { snapshot: true },
    );
    return false;
  }

  private async captureCheckpoint(
    session: OwnedRunSession,
    options: CheckpointOptions,
  ): Promise<CheckpointEvidence> {
    const capture = await session.guard(() => this.workspace.capture(options.workspace));
    if (!options.alwaysPersistDiff && capture.diff.length === 0) {
      return { checkpoint: structuredClone(capture.checkpoint) };
    }
    const artifact = await this.writeArtifact(session, {
      nodeId: options.nodeId,
      attempt: options.attempt,
      type: "diff",
      mediaType: "text/x-diff",
      bytes: capture.diff,
    });
    return {
      checkpoint: { ...structuredClone(capture.checkpoint), diffArtifactId: artifact.id },
      artifact,
    };
  }

  private async writeArtifact(
    session: OwnedRunSession,
    artifact: Omit<ArtifactWrite, "runId">,
  ): Promise<ArtifactRef> {
    return session.guard(() =>
      this.artifacts.write({
        runId: session.lease.runId,
        ...artifact,
      }),
    );
  }

  private parseDescriptor(value: unknown): RuntimeDescriptor {
    const parsed = this.runtimes.parse(structuredClone(value));
    assertRuntimeDescriptor(parsed);
    if (canonicalJson(parsed) !== canonicalJson(value)) {
      throw new TypeError("Runtime descriptor codec changed persisted fields");
    }
    return structuredClone(parsed);
  }

  private async requireCompleteRun(runId: string): Promise<LoadedRunWithHistory> {
    const loaded = await this.store.load(runId, "complete-history");
    if (!loaded) {
      throw new RunNotFoundError(runId);
    }
    return loaded;
  }
}

class PublicObservationFilter {
  private readonly seen = new Set<string>();
  private usageSeen = false;

  accept(event: RuntimeEvent): boolean {
    if (event.type !== "metadata" && event.type !== "usage") {
      return true;
    }
    const identity = canonicalJson(event);
    if (this.seen.has(identity)) {
      return false;
    }
    if (event.type === "usage" && this.usageSeen) {
      throw new Error("Runtime emitted conflicting final usage");
    }
    this.usageSeen ||= event.type === "usage";
    this.seen.add(identity);
    return true;
  }
}

function validateDurableRunInputs(
  workflow: WorkflowDefinition,
  inputs: Record<string, JsonValue>,
  options: {
    workspace: Exclude<WorkspaceRef, { mode: "memory" }>;
    descriptor: RuntimeDescriptor;
    nodeWorkspaces?: Readonly<Record<string, Exclude<WorkspaceRef, { mode: "memory" }>>>;
  },
): void {
  const { workspace, descriptor, nodeWorkspaces = {} } = options;
  const errors = [
    ...durableInputIssues(workflow, inputs),
    ...durableNodeIssues(workflow, workspace, nodeWorkspaces),
    ...concurrentWorkspaceIssues(workflow, workspace, nodeWorkspaces),
  ];
  if (!descriptor.runtimeId) {
    errors.push("runtime descriptor is missing its runtime ID");
  }
  if (errors.length) {
    throw new Error(`Invalid durable run:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

function durableInputIssues(
  workflow: WorkflowDefinition,
  inputs: Record<string, JsonValue>,
): string[] {
  const missing = Object.keys(workflow.inputs).filter((id) => !Object.hasOwn(inputs, id));
  const unknown = Object.keys(inputs).filter((id) => !Object.hasOwn(workflow.inputs, id));
  const errors = [
    ...(missing.length ? [`missing workflow inputs: ${missing.join(", ")}`] : []),
    ...(unknown.length ? [`unknown workflow inputs: ${unknown.join(", ")}`] : []),
  ];
  for (const [id, definition] of Object.entries(workflow.inputs)) {
    if (!Object.hasOwn(inputs, id)) {
      continue;
    }
    const validation = validateJsonValue(definition.schema, inputs[id] as JsonValue);
    if (!validation.valid) {
      errors.push(`input ${id}: ${validation.errors.join("; ")}`);
    }
  }
  return errors;
}

function durableNodeIssues(
  workflow: WorkflowDefinition,
  workspace: Exclude<WorkspaceRef, { mode: "memory" }>,
  nodeWorkspaces: Readonly<Record<string, Exclude<WorkspaceRef, { mode: "memory" }>>>,
): string[] {
  const errors: string[] = [];
  for (const node of Object.values(workflow.nodes)) {
    if (node.kind !== "agent" && (node.kind !== "command" || !node.command)) {
      errors.push(`unsupported durable node: ${node.id}`);
    }
    if (node.kind === "agent" && node.mutation === undefined) {
      errors.push(`agent mutation intent is required: ${node.id}`);
    }
    const assignedWorkspace = nodeWorkspaces[node.id] ?? workspace;
    if (node.mutation === "isolated" && assignedWorkspace.mode !== "isolated") {
      errors.push(`workspace mode does not match mutation intent: ${node.id}`);
    }
  }
  for (const nodeId of Object.keys(nodeWorkspaces)) {
    if (!Object.hasOwn(workflow.nodes, nodeId)) {
      errors.push(`workspace assigned to unknown node: ${nodeId}`);
    }
  }
  return errors;
}

function concurrentWorkspaceIssues(
  workflow: WorkflowDefinition,
  workspace: Exclude<WorkspaceRef, { mode: "memory" }>,
  nodeWorkspaces: Readonly<Record<string, Exclude<WorkspaceRef, { mode: "memory" }>>>,
): string[] {
  if (workflow.policies.maxParallel === 1) {
    return [];
  }
  const errors: string[] = [];
  const nodes = Object.values(workflow.nodes);
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      const independent =
        !nodeDependsOn(workflow, left.id, right.id) && !nodeDependsOn(workflow, right.id, left.id);
      const leftWorkspace = nodeWorkspaces[left.id] ?? workspace;
      const rightWorkspace = nodeWorkspaces[right.id] ?? workspace;
      if (
        independent &&
        (left.mutation === "isolated" || right.mutation === "isolated") &&
        leftWorkspace.path === rightWorkspace.path
      ) {
        errors.push(
          `concurrent nodes require distinct mutation workspaces: ${left.id}, ${right.id}`,
        );
      }
    }
  }
  return errors;
}

function nodeDependsOn(
  workflow: WorkflowDefinition,
  nodeId: string,
  dependencyId: string,
): boolean {
  const visited = new Set<string>();
  const pending = [...(workflow.nodes[nodeId]?.needs ?? [])];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dependencyId) {
      return true;
    }
    if (!visited.has(current)) {
      visited.add(current);
      pending.push(...(workflow.nodes[current]?.needs ?? []));
    }
  }
  return false;
}

function normalizedFailure(node: WorkflowNode, result: ExecutionResult): ExecutionFailure | null {
  if (result.status === "failed") {
    return result.failure;
  }
  if (result.status !== "succeeded") {
    return null;
  }
  const validation = validateJsonValue(node.output.schema, result.output);
  if (!validation.valid) {
    return {
      category: "schema-violation",
      message: `Output for ${node.id} is invalid: ${validation.errors.join("; ")}`,
    };
  }
  if (node.kind === "verifier") {
    const output = result.output;
    if (
      output === null ||
      Array.isArray(output) ||
      typeof output !== "object" ||
      typeof output.passed !== "boolean"
    ) {
      return {
        category: "schema-violation",
        message: "Verifier output must contain a boolean passed field",
      };
    }
    if (!output.passed) {
      return { category: "verification", message: "Verifier reported that its checks failed" };
    }
  }
  if (node.role === "specification-reviewer" || node.role === "quality-reviewer") {
    let review;
    try {
      review = parseReviewReport(result.output);
    } catch {
      return {
        category: "schema-violation",
        message: `Review output for ${node.id} violates independent-review semantics`,
      };
    }
    if (!review.approved) {
      return {
        category: "human-rejection",
        message: `${node.role} rejected the integrated revision`,
      };
    }
  }
  return null;
}

function blockedNodePayloads(state: RunState, except: string, reason: string): RunEventPayload[] {
  return Object.values(state.nodes)
    .filter((node) => node.id !== except && (node.status === "pending" || node.status === "ready"))
    .map((node) => ({ type: "NodeBlocked", nodeId: node.id, reason }));
}

function cancelNodePayloads(
  state: RunState,
  reason: string,
  except = new Set<string>(),
): RunEventPayload[] {
  return Object.values(state.nodes)
    .filter(
      (node) => !except.has(node.id) && !["succeeded", "failed", "cancelled"].includes(node.status),
    )
    .map((node) => ({ type: "NodeCancelled", nodeId: node.id, reason }));
}

function controlObservedPayload(control: ControlRequest): RunEventPayload {
  return {
    type: "ControlRequestObserved",
    operationId: control.operationId,
    action: control.action,
    recordedAtMs: control.recordedAtMs,
  };
}

function assignedWorkspace(
  state: RunState,
  nodeId: string,
): Exclude<WorkspaceRef, { mode: "memory" }> | undefined {
  const selected = state.nodeWorkspaces?.[nodeId] ?? state.workspace;
  return selected?.mode === "memory" ? undefined : selected;
}

function currentOwnedAttempts(
  state: RunState,
): Array<{ nodeId: string; attempt: RunState["nodes"][string]["attempts"][number] }> {
  return Object.values(state.nodes).flatMap((node) => {
    const attempt = node.attempts.at(-1);
    return attempt && (attempt.status === "prepared" || attempt.status === "running")
      ? [{ nodeId: node.id, attempt }]
      : [];
  });
}

function currentOrphanedNodeIds(state: RunState): string[] {
  return Object.values(state.nodes)
    .filter((node) => node.attempts.at(-1)?.status === "orphaned" && node.status === "running")
    .map(({ id }) => id);
}

function outstandingObservedControl(events: readonly RunEvent[]): ControlRequest | undefined {
  const observed = new Map<string, ControlRequest>();
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type === "ControlRequestObserved") {
      observed.set(event.operationId, {
        runId: event.runId,
        operationId: event.operationId,
        action: event.action,
        recordedAtMs: event.recordedAtMs,
      });
    } else if (
      event.type === "RunPaused" &&
      "reason" in event &&
      event.reason.kind === "operator"
    ) {
      completed.add(event.reason.operationId);
    } else if (event.type === "RunCancelled" && "operationId" in event) {
      completed.add(event.operationId);
    }
  }
  return [...observed.values()].find((control) => !completed.has(control.operationId));
}

function isTerminalRun(state: RunState): boolean {
  return state.status === "succeeded" || state.status === "failed" || state.status === "cancelled";
}

async function waitForExecutionTurn(
  event: Promise<IteratorResult<RuntimeEvent>>,
  deadline: number | undefined,
): Promise<
  { kind: "event"; value: IteratorResult<RuntimeEvent> } | { kind: "poll" } | { kind: "timeout" }
> {
  const remaining = deadline === undefined ? CONTROL_POLL_INTERVAL_MS : deadline - Date.now();
  if (remaining <= 0) {
    return { kind: "timeout" };
  }
  const waitMs = Math.min(CONTROL_POLL_INTERVAL_MS, remaining);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      event.then((value) => ({ kind: "event" as const, value })),
      new Promise<{ kind: "poll" } | { kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          resolve(
            deadline !== undefined && Date.now() >= deadline
              ? { kind: "timeout" }
              : { kind: "poll" },
          );
        }, waitMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
