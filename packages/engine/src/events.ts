import type { JsonValue, NodeStatus } from "@anastom/core";
import type {
  ArtifactRef,
  ExecutionFailure,
  RuntimeEvent,
  WorkspaceRef,
} from "@anastom/runtime-contract";
import type { CommandReport } from "./command.js";
import { assertRunEvent } from "./event-validation.js";

/**
 * The lifecycle state of the complete run, reconstructed from ordered events.
 */
export type RunStatus = "running" | "blocked" | "succeeded" | "failed" | "paused" | "cancelled";
/**
 * The lifecycle state of one scheduled node execution.
 */
export type AttemptStatus =
  "scheduled" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";

/**
 * Execution identity, result, and timeout diagnostics for a single node attempt.
 */
export interface AttemptState {
  number: number;
  runtimeId: string;
  status: AttemptStatus;
  failure?: ExecutionFailure;
  timeout?: {
    cancellation?: "succeeded" | "failed" | "unavailable";
    lateStatus?: "succeeded" | "failed" | "blocked" | "cancelled";
  };
}

/**
 * A node's event-derived status, ordered attempts, validated output, and verification evidence.
 */
export interface NodeRunState {
  id: string;
  status: NodeStatus;
  attempts: AttemptState[];
  output?: JsonValue;
  failure?: ExecutionFailure;
  blockedReason?: string;
  command?: CommandReport;
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
  artifacts?: ArtifactRef[];
  workspaceObservation?: { headCommit: string; changedFiles: string[]; diffArtifactId: string };
}

/**
 * Typed transitions and evidence observations before run identity and sequence are attached.
 */
export type RunEventPayload =
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
  | { type: "NodeReady"; nodeId: string; reason: "dependencies-satisfied" | "retry" | "resumed" }
  | { type: "AttemptScheduled"; nodeId: string; attempt: number; runtimeId: string }
  | { type: "AttemptStarted"; nodeId: string; attempt: number }
  | { type: "RuntimeEventObserved"; nodeId: string; attempt: number; event: RuntimeEvent }
  | { type: "AttemptSucceeded"; nodeId: string; attempt: number; output: JsonValue }
  | { type: "AttemptFailed"; nodeId: string; attempt: number; failure: ExecutionFailure }
  | { type: "AttemptBlocked"; nodeId: string; attempt: number; reason: string }
  | { type: "AttemptCancelled"; nodeId: string; attempt: number; reason: string }
  | { type: "NodeSucceeded"; nodeId: string }
  | { type: "NodeFailed"; nodeId: string; failure: ExecutionFailure }
  | { type: "NodeBlocked"; nodeId: string; reason: string }
  | { type: "NodePaused"; nodeId: string }
  | { type: "NodeCancelled"; nodeId: string; reason: string }
  | { type: "RunPaused" }
  | { type: "RunResumed" }
  | { type: "RunBlocked"; reason: string }
  | { type: "RunCancelled"; reason: string }
  | { type: "RunCompleted"; outcome: "succeeded" | "failed" };

/**
 * One validated, monotonically sequenced event in a run's immutable history.
 */
export type RunEvent = RunEventPayload & { runId: string; sequence: number };

/**
 * Signals a transition that would contradict the current run or node state.
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
  const node = state.nodes[nodeId];
  if (node === undefined) {
    throw new InvalidTransitionError(`Unknown node ${JSON.stringify(nodeId)}`);
  }
  return node;
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
    case "AttemptScheduled":
    case "AttemptStarted":
    case "RuntimeEventObserved":
    case "AttemptSucceeded":
    case "AttemptFailed":
    case "AttemptBlocked":
    case "AttemptCancelled":
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
      applyLifecycleEvent(state, event);
      break;
  }

  return state;
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
      requireNodeStatus(node, event.type, ["running"]);
      requireCurrentAttempt(node, event.attempt, "running");
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
      | "AttemptStarted"
      | "RuntimeEventObserved"
      | "AttemptSucceeded"
      | "AttemptFailed"
      | "AttemptBlocked"
      | "AttemptCancelled";
  }
>;

/** Apply attempt transitions after run identity and sequence checks. */
function applyAttemptEvent(state: RunState, event: AttemptEvent): void {
  switch (event.type) {
    case "AttemptScheduled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["ready"]);
      if (event.attempt !== node.attempts.length + 1) {
        throw new InvalidTransitionError(
          `Expected attempt ${node.attempts.length + 1} for node ${node.id}`,
        );
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
      requireCurrentAttempt(node, event.attempt, "scheduled").status = "running";
      node.status = "running";
      break;
    }
    case "RuntimeEventObserved": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      requireCurrentAttempt(node, event.attempt, "running");
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
        "dependencies-satisfied": ["pending"],
      };
      requireNodeStatus(node, event.type, allowed[event.reason]);
      if (event.reason === "retry" && node.attempts.at(-1)?.status !== "failed") {
        throw new InvalidTransitionError(`Node ${node.id} cannot retry without a failed attempt`);
      }
      node.status = "ready";
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
      requireNodeStatus(node, event.type, ["pending", "ready"]);
      node.status = "paused";
      break;
    }
    case "NodeCancelled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["pending", "ready", "running", "blocked", "paused"]);
      if (node.status === "running") {
        requireCurrentAttempt(node, node.attempts.length, "cancelled");
      }
      node.status = "cancelled";
      node.blockedReason = event.reason;
      break;
    }
  }
}

type LifecycleEvent = Extract<
  RunEvent,
  { type: "RunPaused" | "RunResumed" | "RunBlocked" | "RunCancelled" | "RunCompleted" }
>;

/** Apply lifecycle transitions after run identity and sequence checks. */
function applyLifecycleEvent(state: RunState, event: LifecycleEvent): void {
  switch (event.type) {
    case "RunPaused":
      if (state.status !== "running") {
        throw new InvalidTransitionError(`RunPaused is invalid in ${state.status} state`);
      }
      state.status = "paused";
      break;
    case "RunResumed":
      if (state.status !== "paused") {
        throw new InvalidTransitionError(`RunResumed is invalid in ${state.status} state`);
      }
      state.status = "running";
      break;
    case "RunBlocked":
      if (state.status !== "running") {
        throw new InvalidTransitionError(`RunBlocked is invalid in ${state.status} state`);
      }
      state.status = "blocked";
      break;
    case "RunCancelled":
      if (!(["running", "blocked", "paused"] as RunStatus[]).includes(state.status)) {
        throw new InvalidTransitionError(`RunCancelled is invalid in ${state.status} state`);
      }
      state.status = "cancelled";
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
