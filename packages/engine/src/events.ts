import type { JsonValue, NodeStatus } from "@anastom/core";
import type { ArtifactRef, ExecutionFailure, RuntimeEvent, WorkspaceRef } from "@anastom/runtime-contract";
import type { CommandReport } from "./command.js";
import { assertRunEvent } from "./event-validation.js";

export type RunStatus = "running" | "blocked" | "succeeded" | "failed" | "paused" | "cancelled";
export type AttemptStatus = "scheduled" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";

export interface AttemptState {
  number: number;
  runtimeId: string;
  status: AttemptStatus;
  failure?: ExecutionFailure;
  timeout?: { cancellation?: "succeeded" | "failed" | "unavailable"; lateStatus?: "succeeded" | "failed" | "blocked" | "cancelled" };
}

export interface NodeRunState {
  id: string;
  status: NodeStatus;
  attempts: AttemptState[];
  output?: JsonValue;
  failure?: ExecutionFailure;
  blockedReason?: string;
  command?: CommandReport;
}

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

export type RunEventPayload =
  | { type: "WorkspaceAssigned"; workspace: WorkspaceRef }
  | { type: "ArtifactProduced"; nodeId: string; attempt: number; artifact: ArtifactRef }
  | { type: "WorkspaceObserved"; nodeId: string; attempt: number; headCommit: string; changedFiles: string[]; diffArtifactId: string }
  | { type: "CommandCompleted"; nodeId: string; attempt: number; output: CommandReport }
  | { type: "AttemptTimeoutRequested"; nodeId: string; attempt: number }
  | { type: "AttemptCancellationCompleted"; nodeId: string; attempt: number; outcome: "succeeded" | "failed" | "unavailable" }
  | { type: "LateResultObserved"; nodeId: string; attempt: number; status: "succeeded" | "failed" | "blocked" | "cancelled" }
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

export type RunEvent = RunEventPayload & { runId: string; sequence: number };

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

function requireNode(state: RunState, nodeId: string): NodeRunState {
  const node = state.nodes[nodeId];
  if (node === undefined) throw new InvalidTransitionError(`Unknown node ${JSON.stringify(nodeId)}`);
  return node;
}

function requireNodeStatus(node: NodeRunState, eventType: string, allowed: NodeStatus[]): void {
  if (!allowed.includes(node.status)) {
    throw new InvalidTransitionError(`${eventType} is invalid for node ${node.id} in ${node.status} state`);
  }
}

function requireCurrentAttempt(node: NodeRunState, attempt: number, status: AttemptStatus): AttemptState {
  const current = node.attempts.at(-1);
  if (current === undefined || current.number !== attempt || current.status !== status) {
    throw new InvalidTransitionError(
      `Attempt ${attempt} for node ${node.id} must be the current ${status} attempt`,
    );
  }
  return current;
}

export function applyRunEvent(current: RunState | undefined, event: RunEvent): RunState {
  assertRunEvent(event);
  if (current === undefined) {
    if (event.type !== "RunCreated" || event.sequence !== 1) {
      throw new InvalidTransitionError("The first event must be RunCreated at sequence 1");
    }
    const nodes = Object.fromEntries(
      event.nodeIds.map((nodeId) => [nodeId, { id: nodeId, status: "pending" as const, attempts: [] }]),
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

  if (event.runId !== current.runId) throw new InvalidTransitionError("Event runId does not match state");
  if (event.sequence !== current.sequence + 1) {
    throw new InvalidTransitionError(`Expected event sequence ${current.sequence + 1}, received ${event.sequence}`);
  }
  if (event.type === "RunCreated") throw new InvalidTransitionError("RunCreated can only be the first event");
  if (["succeeded", "failed", "cancelled"].includes(current.status)) throw new InvalidTransitionError("A terminal run cannot accept more events");

  const state = structuredClone(current);
  state.sequence = event.sequence;

  switch (event.type) {
    case "WorkspaceAssigned":
      if (state.status !== "running" || state.workspace !== undefined) throw new InvalidTransitionError("Workspace can only be assigned once to a running run");
      state.workspace = structuredClone(event.workspace);
      break;
    case "ArtifactProduced": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      requireCurrentAttempt(node, event.attempt, "running");
      if (event.artifact.producer.runId !== state.runId || event.artifact.producer.nodeId !== event.nodeId || event.artifact.producer.attempt !== event.attempt) throw new InvalidTransitionError("Artifact producer mismatch");
      (state.artifacts ??= []).push(structuredClone(event.artifact));
      break;
    }
    case "WorkspaceObserved": {
      const node = requireNode(state, event.nodeId);
      requireCurrentAttempt(node, event.attempt, "running");
      if (!state.artifacts?.some((artifact) => artifact.id === event.diffArtifactId)) throw new InvalidTransitionError("Workspace diff artifact is missing");
      state.workspaceObservation = { headCommit: event.headCommit, changedFiles: [...event.changedFiles], diffArtifactId: event.diffArtifactId };
      break;
    }
    case "CommandCompleted": {
      const node = requireNode(state, event.nodeId);
      requireCurrentAttempt(node, event.attempt, "running");
      node.command = structuredClone(event.output);
      break;
    }
    case "AttemptTimeoutRequested": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) throw new InvalidTransitionError("Attempt timeout was already requested");
      attempt.timeout = {};
      break;
    }
    case "AttemptCancellationCompleted": {
      const attempt = requireCurrentAttempt(requireNode(state, event.nodeId), event.attempt, "running");
      if (!attempt.timeout || attempt.timeout.cancellation) throw new InvalidTransitionError("Cancellation requires one pending timeout");
      attempt.timeout.cancellation = event.outcome;
      break;
    }
    case "LateResultObserved": {
      const attempt = requireCurrentAttempt(requireNode(state, event.nodeId), event.attempt, "running");
      if (!attempt.timeout?.cancellation || attempt.timeout.lateStatus) throw new InvalidTransitionError("Late result requires completed timeout cancellation");
      attempt.timeout.lateStatus = event.status;
      break;
    }
    case "NodeReady": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, event.reason === "retry" ? ["running"] : event.reason === "resumed" ? ["paused"] : ["pending"]);
      if (event.reason === "retry" && node.attempts.at(-1)?.status !== "failed") {
        throw new InvalidTransitionError(`Node ${node.id} cannot retry without a failed attempt`);
      }
      node.status = "ready";
      break;
    }
    case "AttemptScheduled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["ready"]);
      if (event.attempt !== node.attempts.length + 1) {
        throw new InvalidTransitionError(`Expected attempt ${node.attempts.length + 1} for node ${node.id}`);
      }
      node.attempts.push({ number: event.attempt, runtimeId: event.runtimeId, status: "scheduled" });
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
      if (attempt.timeout) throw new InvalidTransitionError("A timed-out attempt cannot succeed");
      attempt.status = "succeeded";
      node.output = structuredClone(event.output);
      delete node.failure;
      break;
    }
    case "AttemptFailed": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout && (event.failure.category !== "budget-exhausted" || !attempt.timeout.cancellation)) throw new InvalidTransitionError("A timed-out attempt requires completed cancellation and a budget failure");
      attempt.status = "failed";
      attempt.failure = { ...event.failure };
      node.failure = { ...event.failure };
      break;
    }
    case "AttemptBlocked": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) throw new InvalidTransitionError("A timed-out attempt cannot become blocked");
      attempt.status = "blocked";
      break;
    }
    case "AttemptCancelled": {
      const node = requireNode(state, event.nodeId);
      requireNodeStatus(node, event.type, ["running"]);
      const attempt = requireCurrentAttempt(node, event.attempt, "running");
      if (attempt.timeout) throw new InvalidTransitionError("A timed-out attempt must record a budget failure");
      attempt.status = "cancelled";
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
      if (node.status === "running") requireCurrentAttempt(node, node.attempts.length, "blocked");
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
      if (node.status === "running") requireCurrentAttempt(node, node.attempts.length, "cancelled");
      node.status = "cancelled";
      node.blockedReason = event.reason;
      break;
    }
    case "RunPaused":
      if (state.status !== "running") throw new InvalidTransitionError(`RunPaused is invalid in ${state.status} state`);
      state.status = "paused";
      break;
    case "RunResumed":
      if (state.status !== "paused") throw new InvalidTransitionError(`RunResumed is invalid in ${state.status} state`);
      state.status = "running";
      break;
    case "RunBlocked":
      if (state.status !== "running") throw new InvalidTransitionError(`RunBlocked is invalid in ${state.status} state`);
      state.status = "blocked";
      break;
    case "RunCancelled":
      if (!(["running", "blocked", "paused"] as RunStatus[]).includes(state.status)) {
        throw new InvalidTransitionError(`RunCancelled is invalid in ${state.status} state`);
      }
      state.status = "cancelled";
      break;
    case "RunCompleted":
      if (state.status !== "running") throw new InvalidTransitionError(`RunCompleted is invalid in ${state.status} state`);
      if (event.outcome === "succeeded" && Object.values(state.nodes).some((node) => node.status !== "succeeded")) {
        throw new InvalidTransitionError("A run cannot succeed before every node succeeds");
      }
      if (event.outcome === "failed" && Object.values(state.nodes).every((node) => node.status !== "failed")) {
        throw new InvalidTransitionError("A run cannot fail without a failed node");
      }
      state.status = event.outcome;
      break;
  }

  return state;
}

export function replayRun(events: readonly RunEvent[]): RunState {
  if (events.length === 0) throw new InvalidTransitionError("Cannot replay an empty event stream");
  let state: RunState | undefined;
  for (const event of events) state = applyRunEvent(state, event);
  if (state === undefined) throw new InvalidTransitionError("Cannot replay an empty event stream");
  return state;
}

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
  if (state === undefined) throw new InvalidTransitionError("A transition must contain at least one event");
  return { events, state };
}
