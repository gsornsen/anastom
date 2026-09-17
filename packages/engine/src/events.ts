import type { JsonValue, NodeStatus } from "@anastom/core";
import type {
  ArtifactRef,
  ExecutionFailure,
  RuntimeEvent,
  RuntimeDescriptor,
  WorkspaceCheckpoint,
  WorkspaceDifference,
  WorkspaceRef,
  RuntimeNegotiation,
  RuntimeUsage,
} from "@anastom/runtime-contract";
import type { CommandReport } from "./command.js";
import type { ExecutionPlanRef, PersistedExecutionRef } from "./execution-host.js";
import { assertRunEvent } from "./event-validation.js";

/**
 * The lifecycle state of the complete run, reconstructed from ordered events.
 */
type RunStatus =
  "running" | "blocked" | "succeeded" | "failed" | "paused" | "cancelled" | "recovery-blocked";
/**
 * The lifecycle state of one scheduled node execution.
 */
type AttemptStatus =
  | "scheduled"
  | "prepared"
  | "running"
  | "orphaned"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Evidence that prevents recovery from claiming an execution is absent. */
export type RecoveryBlockReason =
  | {
      kind: "execution-unknown";
      executionId: string;
      detail:
        | "invalid-record"
        | "identity-mismatch"
        | "boot-mismatch"
        | "supervisor-unreachable"
        | "supervisor-lost"
        | "cleanup-unconfirmed";
    }
  | { kind: "cleanup-unknown"; executionId: string };

/** Typed operator or safety-policy evidence attached to pause transitions. */
export type PauseReason =
  | { kind: "operator"; operationId: string }
  | { kind: "workspace-conflict"; differences: WorkspaceDifference[] }
  | { kind: "attempt-budget-exhausted"; nodeId: string; attempts: number }
  | { kind: "runtime-unavailable"; runtimeId: string }
  | { kind: "policy-violation"; runtimeId: string };

/**
 * Execution identity, result, and timeout diagnostics for a single node attempt.
 */
export interface AttemptState {
  number: number;
  runtimeId: string;
  status: AttemptStatus;
  failure?: ExecutionFailure;
  /** Ordered identity evidence; absent source in old histories remains unspecified. */
  identity?: Extract<RuntimeEvent, { type: "metadata" }>[];
  /** Final token observation, never an acceptance or billing decision. */
  usage?: RuntimeUsage;
  timeout?: {
    cancellation?: "succeeded" | "failed" | "unavailable";
    lateStatus?: "succeeded" | "failed" | "blocked" | "cancelled";
  };
  executionPlan?: ExecutionPlanRef;
  execution?: PersistedExecutionRef;
  workspaceCheckpoint?: WorkspaceCheckpoint;
  cleanup?: Array<{
    executionId: string;
    cause: "pause" | "cancel" | "timeout" | "recovery";
    outcome: "confirmed" | "unknown";
  }>;
  orphan?: {
    executionId: string;
    lostGeneration: number;
    reason: "coordinator-lost" | "launch-interrupted";
    workspaceObservation: WorkspaceCheckpoint;
    workspaceDifferences: WorkspaceDifference[];
    terminalArtifactId?: string;
  };
}

/**
 * A node's event-derived status, ordered attempts, validated output, and verification evidence.
 */
interface NodeRunState {
  id: string;
  status: NodeStatus;
  attempts: AttemptState[];
  output?: JsonValue;
  failure?: ExecutionFailure;
  blockedReason?: string;
  command?: CommandReport;
  pauseReason?: PauseReason;
}

/**
 * The run's materialized view; persisted events, rather than this object, are authoritative.
 */
export interface RunState {
  runId: string;
  workflowInstanceId: string;
  workflowId: string;
  workflowVersion: string;
  status: RunStatus;
  sequence: number;
  inputs: Record<string, JsonValue>;
  nodes: Record<string, NodeRunState>;
  workspace?: WorkspaceRef;
  runtimeNegotiation?: RuntimeNegotiation;
  runtimeDescriptor?: RuntimeDescriptor;
  pauseReason?: PauseReason;
  recoveryBlock?: { operationId: string; reason: RecoveryBlockReason };
  artifacts?: ArtifactRef[];
  workspaceObservation?: { headCommit: string; changedFiles: string[]; diffArtifactId: string };
}

/**
 * Typed transitions and evidence observations before run identity and sequence are attached.
 */
export type RunEventPayload =
  | { type: "RuntimeNegotiated"; negotiation: RuntimeNegotiation }
  | { type: "RuntimeConfigured"; descriptor: RuntimeDescriptor }
  | { type: "WorkspaceAssigned"; workspace: WorkspaceRef }
  | { type: "ArtifactProduced"; nodeId: string; attempt: number; artifact: ArtifactRef }
  | {
      type: "WorkspaceObserved";
      nodeId: string;
      attempt: number;
      headCommit: string;
      changedFiles: string[];
      diffArtifactId: string;
    }
  | { type: "CommandCompleted"; nodeId: string; attempt: number; output: CommandReport }
  | { type: "AttemptTimeoutRequested"; nodeId: string; attempt: number }
  | {
      type: "AttemptCancellationCompleted";
      nodeId: string;
      attempt: number;
      outcome: "succeeded" | "failed" | "unavailable";
    }
  | {
      type: "LateResultObserved";
      nodeId: string;
      attempt: number;
      status: "succeeded" | "failed" | "blocked" | "cancelled";
    }
  | {
      type: "RunCreated";
      workflowInstanceId: string;
      workflowId: string;
      workflowVersion: string;
      nodeIds: string[];
      inputs: Record<string, JsonValue>;
    }
  | {
      type: "NodeReady";
      nodeId: string;
      reason: "dependencies-satisfied" | "retry" | "resumed" | "recovered";
    }
  | { type: "AttemptScheduled"; nodeId: string; attempt: number; runtimeId: string }
  | {
      type: "AttemptPrepared";
      nodeId: string;
      attempt: number;
      execution: ExecutionPlanRef;
      workspaceCheckpoint: WorkspaceCheckpoint;
    }
  | {
      type: "AttemptStartAuthorized";
      nodeId: string;
      attempt: number;
      execution: PersistedExecutionRef;
    }
  | { type: "AttemptStarted"; nodeId: string; attempt: number }
  | { type: "RuntimeEventObserved"; nodeId: string; attempt: number; event: RuntimeEvent }
  | { type: "AttemptSucceeded"; nodeId: string; attempt: number; output: JsonValue }
  | { type: "AttemptFailed"; nodeId: string; attempt: number; failure: ExecutionFailure }
  | { type: "AttemptBlocked"; nodeId: string; attempt: number; reason: string }
  | { type: "AttemptCancelled"; nodeId: string; attempt: number; reason: string }
  | { type: "NodeSucceeded"; nodeId: string }
  | { type: "NodeFailed"; nodeId: string; failure: ExecutionFailure }
  | { type: "NodeBlocked"; nodeId: string; reason: string }
  | {
      type: "AttemptOrphaned";
      nodeId: string;
      attempt: number;
      executionId: string;
      lostGeneration: number;
      reason: "coordinator-lost" | "launch-interrupted";
      workspaceObservation: WorkspaceCheckpoint;
      workspaceDifferences: WorkspaceDifference[];
      terminalArtifactId?: string;
    }
  | {
      type: "ControlRequestObserved";
      operationId: string;
      action: "pause" | "cancel";
      recordedAtMs: number;
    }
  | {
      type: "ExecutionCleanupObserved";
      nodeId: string;
      attempt: number;
      executionId: string;
      cause: "pause" | "cancel" | "timeout" | "recovery";
      outcome: "confirmed" | "unknown";
    }
  | { type: "NodePaused"; nodeId: string }
  | { type: "NodePaused"; nodeId: string; reason: PauseReason }
  | { type: "NodeCancelled"; nodeId: string; reason: string }
  | { type: "RunPaused" }
  | { type: "RunPaused"; reason: PauseReason }
  | { type: "RunResumed" }
  | { type: "RunResumed"; operationId: string }
  | { type: "RunRecoveryBlocked"; operationId: string; reason: RecoveryBlockReason }
  | { type: "RunBlocked"; reason: string }
  | { type: "RunCancelled"; reason: string }
  | { type: "RunCancelled"; operationId: string; reason: string }
  | { type: "RunCompleted"; outcome: "succeeded" | "failed" };

/**
 * One validated, monotonically sequenced event in a run's immutable history.
 */
export type RunEvent = RunEventPayload & { runId: string; sequence: number };

/**
 * Signals a transition that would contradict the current run or node state.
 * @public
 */
export class InvalidTransitionError extends Error {
  /**
   * Construct an error explaining the violated event transition.
   */
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

function requireNode(state: RunState, nodeId: string): NodeRunState {
  if (!Object.hasOwn(state.nodes, nodeId)) {
    throw new InvalidTransitionError(`Unknown node ${JSON.stringify(nodeId)}`);
  }
  return state.nodes[nodeId] as NodeRunState;
}

function requireNodeStatus(node: NodeRunState, eventType: string, allowed: NodeStatus[]): void {
  if (!allowed.includes(node.status)) {
    throw new InvalidTransitionError(
      `${eventType} is invalid for node ${node.id} in ${node.status} state`,
    );
  }
}

function requireCurrentAttempt(
  node: NodeRunState,
  attempt: number,
  status: AttemptStatus,
): AttemptState {
  const current = node.attempts.at(-1);
  if (current === undefined || current.number !== attempt || current.status !== status) {
    throw new InvalidTransitionError(
      `Attempt ${attempt} for node ${node.id} must be the current ${status} attempt`,
    );
  }
  return current;
}

/**
 * Validate and apply one event to a cloned state, enforcing sequence and transition invariants.
 * @throws InvalidTransitionError for contradictory history; input state is never mutated.
 */
export function applyRunEvent(current: RunState | undefined, event: RunEvent): RunState {
  assertRunEvent(event);
  if (current === undefined) {
    if (event.type !== "RunCreated" || event.sequence !== 1) {
      throw new InvalidTransitionError("The first event must be RunCreated at sequence 1");
    }
    const nodes = Object.fromEntries(
      event.nodeIds.map((nodeId) => [
        nodeId,
        { id: nodeId, status: "pending" as const, attempts: [] },
      ]),
    );
    return {
      runId: event.runId,
      workflowInstanceId: event.workflowInstanceId,
      workflowId: event.workflowId,
      workflowVersion: event.workflowVersion,
      status: "running",
      sequence: event.sequence,
      inputs: structuredClone(event.inputs),
      nodes,
    };
  }

  if (event.runId !== current.runId) {
    throw new InvalidTransitionError("Event runId does not match state");
  }
  if (event.sequence !== current.sequence + 1) {
    throw new InvalidTransitionError(
      `Expected event sequence ${current.sequence + 1}, received ${event.sequence}`,
    );
  }
  if (event.type === "RunCreated") {
    throw new InvalidTransitionError("RunCreated can only be the first event");
  }
  if (["succeeded", "failed", "cancelled"].includes(current.status)) {
    throw new InvalidTransitionError("A terminal run cannot accept more events");
  }

  const state = structuredClone(current);
  state.sequence = event.sequence;

  switch (event.type) {
    case "RuntimeConfigured":
      if (
        state.runtimeDescriptor ||
        Object.values(state.nodes).some((node) => node.attempts.length)
      ) {
        throw new InvalidTransitionError("Runtime configuration must occur once before attempts");
      }
      if (
        state.runtimeNegotiation &&
        state.runtimeNegotiation.runtimeId !== event.descriptor.runtimeId
      ) {
        throw new InvalidTransitionError("Runtime configuration does not match negotiation");
      }
      state.runtimeDescriptor = structuredClone(event.descriptor);
      break;
    case "RuntimeNegotiated":
      if (
        state.runtimeNegotiation ||
        Object.values(state.nodes).some((node) => node.attempts.length)
      ) {
        throw new InvalidTransitionError("Runtime negotiation must occur once before attempts");
      }
      if (
        state.runtimeDescriptor &&
        state.runtimeDescriptor.runtimeId !== event.negotiation.runtimeId
      ) {
        throw new InvalidTransitionError("Runtime negotiation does not match configuration");
      }
      state.runtimeNegotiation = structuredClone(event.negotiation);
      break;
    case "WorkspaceAssigned":
    case "ArtifactProduced":
    case "WorkspaceObserved":
    case "CommandCompleted":
      applyObservationEvent(state, event);
      break;
    case "AttemptTimeoutRequested":
    case "AttemptCancellationCompleted":
    case "LateResultObserved":
      applyTimeoutEvent(state, event);
      break;
    case "ControlRequestObserved":
    case "ExecutionCleanupObserved":
      applyOperationalEvent(state, event);
      break;
    case "AttemptScheduled":
    case "AttemptPrepared":
    case "AttemptStartAuthorized":
    case "AttemptStarted":
    case "RuntimeEventObserved":
    case "AttemptSucceeded":
    case "AttemptFailed":
    case "AttemptBlocked":
    case "AttemptCancelled":
    case "AttemptOrphaned":
      applyAttemptEvent(state, event);
      break;
    case "NodeReady":
    case "NodeSucceeded":
    case "NodeFailed":
    case "NodeBlocked":
    case "NodePaused":
    case "NodeCancelled":
      applyNodeEvent(state, event);
      break;
    case "RunPaused":
    case "RunResumed":
    case "RunBlocked":
    case "RunCancelled":
    case "RunCompleted":
    case "RunRecoveryBlocked":
      applyLifecycleEvent(state, event);
      break;
  }

  return state;
}

type OperationalEvent = Extract<
  RunEvent,
  { type: "ControlRequestObserved" | "ExecutionCleanupObserved" }
>;

/** Keep mutable controls out of state while retaining immutable execution-cleanup evidence. */
function applyOperationalEvent(state: RunState, event: OperationalEvent): void {
  if (event.type === "ControlRequestObserved") {
    return;
  }
  const node = requireNode(state, event.nodeId);
  const attempt = node.attempts.at(-1);
  if (
    !attempt ||
    attempt.number !== event.attempt ||
    !["prepared", "running", "orphaned"].includes(attempt.status) ||
    attempt.executionPlan?.executionId !== event.executionId
  ) {
    throw new InvalidTransitionError("Cleanup evidence must identify the current owned execution");
  }
  const cleanup = (attempt.cleanup ??= []);
  if (
    cleanup.some((item) => item.executionId === event.executionId && item.cause === event.cause)
  ) {
    throw new InvalidTransitionError("Cleanup evidence was already recorded for this cause");
  }
  cleanup.push({ executionId: event.executionId, cause: event.cause, outcome: event.outcome });
}

/**
 * Rebuild state from a complete contiguous event history, rejecting missing or contradictory evidence.
 */
export function replayRun(events: readonly RunEvent[]): RunState {
  if (events.length === 0) {
    throw new InvalidTransitionError("Cannot replay an empty event stream");
  }
  let state: RunState | undefined;
  for (const event of events) {
    state = applyRunEvent(state, event);
  }
  if (state === undefined) {
    throw new InvalidTransitionError("Cannot replay an empty event stream");
  }
  return state;
}

/**
 * Attach run identity and consecutive sequences to payloads while validating the entire transition.
 */
export function materializeEvents(
  current: RunState | undefined,
  runId: string,
  payloads: readonly RunEventPayload[],
): { events: RunEvent[]; state: RunState } {
  const events: RunEvent[] = [];
  let state = current;
  for (const payload of payloads) {
    const event: RunEvent = { ...payload, runId, sequence: (state?.sequence ?? 0) + 1 };
    state = applyRunEvent(state, event);
    events.push(event);
  }
  if (state === undefined) {
    throw new InvalidTransitionError("A transition must contain at least one event");
  }
  return { events, state };
}

type ObservationEvent = Extract<
  RunEvent,
  { type: "WorkspaceAssigned" | "ArtifactProduced" | "WorkspaceObserved" | "CommandCompleted" }
>;

/** Apply observation transitions after run identity and sequence checks. */
function applyObservationEvent(state: RunState, event: ObservationEvent): void {
  switch (event.type) {
    case "WorkspaceAssigned":
      if (state.status !== "running" || state.workspace !== undefined) {
        throw new InvalidTransitionError("Workspace can only be assigned once to a running run");
      }
      state.workspace = structuredClone(event.workspace);
      break;
    case "ArtifactProduced": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["ready", "running"]);
      if (node.status === "running") {
        requireCurrentAttempt(node, event.attempt, "running");
      } else {
        const attempt = node.attempts.at(-1);
        if (
          !attempt ||
          attempt.number !== event.attempt ||
          (attempt.status !== "scheduled" && attempt.status !== "prepared")
        ) {
          throw new InvalidTransitionError(
            "Pre-start artifact evidence must identify the current scheduled attempt",
          );
        }
      }
      if (
        event.artifact.producer.runId !== state.runId ||
        event.artifact.producer.nodeId !== event.nodeId ||
        event.artifact.producer.attempt !== event.attempt
      ) {
        throw new InvalidTransitionError("Artifact producer mismatch");
      }
      (state.artifacts ??= []).push(structuredClone(event.artifact));
      break;
    }
    case "WorkspaceObserved": {
      const node = requireNode(state, event.nodeId);
      requireCurrentAttempt(node, event.attempt, "running");
      if (!state.artifacts?.some((artifact) => artifact.id === event.diffArtifactId)) {
        throw new InvalidTransitionError("Workspace diff artifact is missing");
      }
      state.workspaceObservation = {
        headCommit: event.headCommit,
        changedFiles: [...event.changedFiles],
        diffArtifactId: event.diffArtifactId,
      };
      break;
    }
    case "CommandCompleted": {
      const node = requireNode(state, event.nodeId);
      requireCurrentAttempt(node, event.attempt, "running");
      node.command = structuredClone(event.output);
      break;
    }
  }
}

type TimeoutEvent = Extract<
  RunEvent,
  { type: "AttemptTimeoutRequested" | "AttemptCancellationCompleted" | "LateResultObserved" }
>;

/** Apply timeout transitions after run identity and sequence checks. */
function applyTimeoutEvent(state: RunState, event: TimeoutEvent): void {
  switch (event.type) {
    case "AttemptTimeoutRequested": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) {
        throw new InvalidTransitionError("Attempt timeout was already requested");
      }
      attempt.timeout = {};
      break;
    }
    case "AttemptCancellationCompleted": {
      const attempt = requireCurrentAttempt(
        requireNode(state, event.nodeId),
        event.attempt,
        "running",
      );
      if (!attempt.timeout || attempt.timeout.cancellation) {
        throw new InvalidTransitionError("Cancellation requires one pending timeout");
      }
      attempt.timeout.cancellation = event.outcome;
      break;
    }
    case "LateResultObserved": {
      const attempt = requireCurrentAttempt(
        requireNode(state, event.nodeId),
        event.attempt,
        "running",
      );
      if (!attempt.timeout?.cancellation || attempt.timeout.lateStatus) {
        throw new InvalidTransitionError("Late result requires completed timeout cancellation");
      }
      attempt.timeout.lateStatus = event.status;
      break;
    }
  }
}

type AttemptEvent = Extract<
  RunEvent,
  {
    type:
      | "AttemptScheduled"
      | "AttemptPrepared"
      | "AttemptStartAuthorized"
      | "AttemptStarted"
      | "RuntimeEventObserved"
      | "AttemptSucceeded"
      | "AttemptFailed"
      | "AttemptBlocked"
      | "AttemptCancelled"
      | "AttemptOrphaned";
  }
>;

type OwnedAttemptEvent = Extract<
  AttemptEvent,
  { type: "AttemptPrepared" | "AttemptStartAuthorized" | "AttemptOrphaned" }
>;

function isOwnedAttemptEvent(event: AttemptEvent): event is OwnedAttemptEvent {
  return (
    event.type === "AttemptPrepared" ||
    event.type === "AttemptStartAuthorized" ||
    event.type === "AttemptOrphaned"
  );
}

/** Apply attempt transitions after run identity and sequence checks. */
function applyAttemptEvent(state: RunState, event: AttemptEvent): void {
  if (isOwnedAttemptEvent(event)) {
    applyOwnedAttemptEvent(state, event);
    return;
  }
  switch (event.type) {
    case "AttemptScheduled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["ready"]);
      if (event.attempt !== node.attempts.length + 1) {
        throw new InvalidTransitionError(
          `Expected attempt ${node.attempts.length + 1} for node ${node.id}`,
        );
      }
      if (
        event.runtimeId !== "command" &&
        state.runtimeDescriptor &&
        state.runtimeDescriptor.runtimeId !== event.runtimeId
      ) {
        throw new InvalidTransitionError("Scheduled runtime does not match its descriptor");
      }
      node.attempts.push({
        number: event.attempt,
        runtimeId: event.runtimeId,
        status: "scheduled",
      });
      break;
    }
    case "AttemptStarted": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["ready"]);
      if (state.runtimeDescriptor) {
        throw new InvalidTransitionError(
          "A configured durable runtime requires prepared start authorization",
        );
      }
      requireCurrentAttempt(node, event.attempt, "scheduled").status = "running";
      node.status = "running";
      break;
    }
    case "RuntimeEventObserved": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (event.event.type === "usage") {
        if (attempt.usage) {
          throw new InvalidTransitionError("An attempt may have only one final usage observation");
        }
        attempt.usage = structuredClone(event.event);
      }
      if (event.event.type === "metadata") {
        (attempt.identity ??= []).push(structuredClone(event.event));
      }
      break;
    }
    case "AttemptSucceeded": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) {
        throw new InvalidTransitionError("A timed-out attempt cannot succeed");
      }
      attempt.status = "succeeded";
      node.output = structuredClone(event.output);
      delete node.failure;
      break;
    }
    case "AttemptFailed": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (
        attempt.timeout &&
        (event.failure.category !== "budget-exhausted" || !attempt.timeout.cancellation)
      ) {
        throw new InvalidTransitionError(
          "A timed-out attempt requires completed cancellation and a budget failure",
        );
      }
      attempt.status = "failed";
      attempt.failure = { ...event.failure };
      node.failure = { ...event.failure };
      break;
    }
    case "AttemptBlocked": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) {
        throw new InvalidTransitionError("A timed-out attempt cannot become blocked");
      }
      attempt.status = "blocked";
      break;
    }
    case "AttemptCancelled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) {
        throw new InvalidTransitionError("A timed-out attempt must record a budget failure");
      }
      attempt.status = "cancelled";
      break;
    }
  }
}

/** Apply prepare, authorize, and orphan transitions around an owned execution. */
function applyOwnedAttemptEvent(state: RunState, event: OwnedAttemptEvent): void {
  switch (event.type) {
    case "AttemptPrepared":
      applyAttemptPrepared(state, event);
      break;
    case "AttemptStartAuthorized":
      applyAttemptStartAuthorized(state, event);
      break;
    case "AttemptOrphaned":
      applyAttemptOrphaned(state, event);
      break;
  }
}

function applyAttemptPrepared(
  state: RunState,
  event: Extract<OwnedAttemptEvent, { type: "AttemptPrepared" }>,
): void {
  const node = requireNode(state, event.nodeId);
  requireNodeStatus(node, event.type, ["ready"]);
  const attempt = requireCurrentAttempt(node, event.attempt, "scheduled");
  const expectedKind = attempt.runtimeId === "command" ? "command" : "runtime";
  if (
    event.execution.runId !== state.runId ||
    event.execution.generation < 1 ||
    (state.workspace && event.workspaceCheckpoint.workspaceId !== state.workspace.id) ||
    event.execution.kind !== expectedKind
  ) {
    throw new InvalidTransitionError("Prepared attempt evidence does not match the run");
  }
  if (
    expectedKind === "runtime" &&
    (!state.runtimeDescriptor || state.runtimeDescriptor.runtimeId !== attempt.runtimeId)
  ) {
    throw new InvalidTransitionError("Prepared attempt runtime does not match its descriptor");
  }
  if (
    event.workspaceCheckpoint.diffArtifactId &&
    !state.artifacts?.some(
      (artifact) =>
        artifact.id === event.workspaceCheckpoint.diffArtifactId &&
        artifact.producer.runId === state.runId &&
        artifact.producer.nodeId === event.nodeId &&
        artifact.producer.attempt === event.attempt,
    )
  ) {
    throw new InvalidTransitionError("Prepared workspace diff artifact is missing");
  }
  attempt.status = "prepared";
  attempt.executionPlan = structuredClone(event.execution);
  attempt.workspaceCheckpoint = structuredClone(event.workspaceCheckpoint);
}

function applyAttemptStartAuthorized(
  state: RunState,
  event: Extract<OwnedAttemptEvent, { type: "AttemptStartAuthorized" }>,
): void {
  const node = requireNode(state, event.nodeId);
  requireNodeStatus(node, event.type, ["ready"]);
  const attempt = requireCurrentAttempt(node, event.attempt, "prepared");
  const plan = attempt.executionPlan;
  if (
    !plan ||
    plan.version !== event.execution.version ||
    plan.runId !== event.execution.runId ||
    plan.executionId !== event.execution.executionId ||
    plan.kind !== event.execution.kind ||
    plan.generation !== event.execution.generation ||
    plan.planDigest !== event.execution.planDigest
  ) {
    throw new InvalidTransitionError("Authorized execution does not match its prepared plan");
  }
  attempt.status = "running";
  attempt.execution = structuredClone(event.execution);
  node.status = "running";
}

function applyAttemptOrphaned(
  state: RunState,
  event: Extract<OwnedAttemptEvent, { type: "AttemptOrphaned" }>,
): void {
  const node = requireNode(state, event.nodeId);
  requireNodeStatus(node, event.type, ["ready", "running"]);
  const attempt = node.attempts.at(-1);
  if (
    !attempt ||
    attempt.number !== event.attempt ||
    !["prepared", "running"].includes(attempt.status) ||
    attempt.executionPlan?.executionId !== event.executionId ||
    attempt.executionPlan.generation !== event.lostGeneration
  ) {
    throw new InvalidTransitionError("Orphan evidence must identify the latest owned attempt");
  }
  if (
    event.terminalArtifactId &&
    !state.artifacts?.some((artifact) => artifact.id === event.terminalArtifactId)
  ) {
    throw new InvalidTransitionError("Orphan terminal artifact is missing");
  }
  if (
    event.workspaceObservation.diffArtifactId &&
    !state.artifacts?.some(
      (artifact) =>
        artifact.id === event.workspaceObservation.diffArtifactId &&
        artifact.producer.runId === state.runId &&
        artifact.producer.nodeId === event.nodeId &&
        artifact.producer.attempt === event.attempt,
    )
  ) {
    throw new InvalidTransitionError("Orphan workspace diff artifact is missing");
  }
  attempt.status = "orphaned";
  attempt.orphan = {
    executionId: event.executionId,
    lostGeneration: event.lostGeneration,
    reason: event.reason,
    workspaceObservation: structuredClone(event.workspaceObservation),
    workspaceDifferences: [...event.workspaceDifferences],
    ...(event.terminalArtifactId ? { terminalArtifactId: event.terminalArtifactId } : {}),
  };
  node.status = "running";
}

type NodeEvent = Extract<
  RunEvent,
  {
    type:
      "NodeReady" | "NodeSucceeded" | "NodeFailed" | "NodeBlocked" | "NodePaused" | "NodeCancelled";
  }
>;

/** Apply node transitions after run identity and sequence checks. */
function applyNodeEvent(state: RunState, event: NodeEvent): void {
  switch (event.type) {
    case "NodeReady": {
      const node = requireNode(state, event.nodeId);
      const allowed: Record<typeof event.reason, NodeStatus[]> = {
        retry: ["running"],
        resumed: ["paused"],
        recovered: ["running"],
        "dependencies-satisfied": ["pending"],
      };
      requireNodeStatus(node, event.type, allowed[event.reason]);
      if (event.reason === "retry" && node.attempts.at(-1)?.status !== "failed") {
        throw new InvalidTransitionError(`Node ${node.id} cannot retry without a failed attempt`);
      }
      if (event.reason === "recovered" && node.attempts.at(-1)?.status !== "orphaned") {
        throw new InvalidTransitionError(
          `Node ${node.id} cannot recover without an orphaned attempt`,
        );
      }
      node.status = "ready";
      delete node.pauseReason;
      break;
    }
    case "NodeSucceeded": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      requireCurrentAttempt(node, node.attempts.length, "succeeded");
      node.status = "succeeded";
      break;
    }
    case "NodeFailed": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      requireCurrentAttempt(node, node.attempts.length, "failed");
      node.status = "failed";
      node.failure = { ...event.failure };
      break;
    }
    case "NodeBlocked": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["pending", "ready", "running"]);
      if (node.status === "running") {
        requireCurrentAttempt(node, node.attempts.length, "blocked");
      }
      node.status = "blocked";
      node.blockedReason = event.reason;
      break;
    }
    case "NodePaused": {
      const node = requireNode(state, event.nodeId);
      if ("reason" in event) {
        requireNodeStatus(node, event.type, ["pending", "ready", "running"]);
        if (
          node.status === "running" &&
          !(["cancelled", "orphaned"] as AttemptStatus[]).includes(
            node.attempts.at(-1)?.status ?? "scheduled",
          )
        ) {
          throw new InvalidTransitionError(
            "A running node can pause only after cancellation or orphaning",
          );
        }
        node.pauseReason = structuredClone(event.reason);
      } else {
        requireNodeStatus(node, event.type, ["pending", "ready"]);
      }
      node.status = "paused";
      break;
    }
    case "NodeCancelled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["pending", "ready", "running", "blocked", "paused"]);
      if (
        node.status === "running" &&
        !(["cancelled", "orphaned"] as AttemptStatus[]).includes(
          node.attempts.at(-1)?.status ?? "scheduled",
        )
      ) {
        throw new InvalidTransitionError(
          "A running node can cancel only after attempt cancellation or orphaning",
        );
      }
      node.status = "cancelled";
      node.blockedReason = event.reason;
      break;
    }
  }
}

type LifecycleEvent = Extract<
  RunEvent,
  {
    type:
      | "RunPaused"
      | "RunResumed"
      | "RunBlocked"
      | "RunCancelled"
      | "RunCompleted"
      | "RunRecoveryBlocked";
  }
>;

/** Apply lifecycle transitions after run identity and sequence checks. */
function applyLifecycleEvent(state: RunState, event: LifecycleEvent): void {
  switch (event.type) {
    case "RunPaused":
      applyRunPaused(state, event);
      break;
    case "RunResumed":
      applyRunResumed(state, event);
      break;
    case "RunBlocked":
      if (state.status !== "running") {
        throw new InvalidTransitionError(`RunBlocked is invalid in ${state.status} state`);
      }
      state.status = "blocked";
      break;
    case "RunCancelled":
      if (
        !(["running", "blocked", "paused", "recovery-blocked"] as RunStatus[]).includes(
          state.status,
        )
      ) {
        throw new InvalidTransitionError(`RunCancelled is invalid in ${state.status} state`);
      }
      if (
        "operationId" in event &&
        Object.values(state.nodes).some(
          (node) => !["succeeded", "failed", "cancelled"].includes(node.status),
        )
      ) {
        throw new InvalidTransitionError(
          "Durable cancellation requires every nonterminal node to be cancelled",
        );
      }
      state.status = "cancelled";
      break;
    case "RunRecoveryBlocked":
      applyRunRecoveryBlocked(state, event);
      break;
    case "RunCompleted":
      if (state.status !== "running") {
        throw new InvalidTransitionError(`RunCompleted is invalid in ${state.status} state`);
      }
      if (
        event.outcome === "succeeded" &&
        Object.values(state.nodes).some((node) => node.status !== "succeeded")
      ) {
        throw new InvalidTransitionError("A run cannot succeed before every node succeeds");
      }
      if (
        event.outcome === "failed" &&
        Object.values(state.nodes).every((node) => node.status !== "failed")
      ) {
        throw new InvalidTransitionError("A run cannot fail without a failed node");
      }
      state.status = event.outcome;
      break;
  }
}

function applyRunPaused(
  state: RunState,
  event: Extract<LifecycleEvent, { type: "RunPaused" }>,
): void {
  if (state.status !== "running" && !("reason" in event && state.status === "recovery-blocked")) {
    throw new InvalidTransitionError(`RunPaused is invalid in ${state.status} state`);
  }
  if ("reason" in event && Object.values(state.nodes).some((node) => node.status === "running")) {
    throw new InvalidTransitionError(
      "A durable pause requires every active node to stop before the run pauses",
    );
  }
  state.status = "paused";
  if ("reason" in event) {
    state.pauseReason = structuredClone(event.reason);
  }
}

function applyRunResumed(
  state: RunState,
  event: Extract<LifecycleEvent, { type: "RunResumed" }>,
): void {
  if (
    state.status !== "paused" &&
    !("operationId" in event && state.status === "recovery-blocked")
  ) {
    throw new InvalidTransitionError(`RunResumed is invalid in ${state.status} state`);
  }
  if (
    state.status === "recovery-blocked" &&
    Object.values(state.nodes).some((node) => {
      const attemptStatus = node.attempts.at(-1)?.status;
      return (
        attemptStatus === "prepared" ||
        attemptStatus === "running" ||
        (attemptStatus === "orphaned" && node.status !== "ready" && node.status !== "paused")
      );
    })
  ) {
    throw new InvalidTransitionError(
      "Recovery must make every affected attempt schedulable or paused before resuming",
    );
  }
  state.status = "running";
  delete state.pauseReason;
  delete state.recoveryBlock;
}

function applyRunRecoveryBlocked(
  state: RunState,
  event: Extract<LifecycleEvent, { type: "RunRecoveryBlocked" }>,
): void {
  if (!(
    state.status === "running" ||
    state.status === "paused" ||
    state.status === "recovery-blocked"
  )) {
    throw new InvalidTransitionError(`RunRecoveryBlocked is invalid in ${state.status} state`);
  }
  const executionId = event.reason.executionId;
  const attempt = Object.values(state.nodes)
    .map((node) => node.attempts.at(-1))
    .find((candidate) => candidate?.executionPlan?.executionId === executionId);
  if (!attempt) {
    throw new InvalidTransitionError("Recovery block does not match an owned execution");
  }
  if (
    event.reason.kind === "cleanup-unknown" &&
    !attempt.cleanup?.some(
      (cleanup) => cleanup.executionId === executionId && cleanup.outcome === "unknown",
    )
  ) {
    throw new InvalidTransitionError("Cleanup recovery block requires unknown cleanup evidence");
  }
  state.status = "recovery-blocked";
  state.recoveryBlock = {
    operationId: event.operationId,
    reason: structuredClone(event.reason),
  };
}
