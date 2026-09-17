import {
  digestJson,
  type NodeStatus,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@anastom/core";
import type { ArtifactRef, LiveRunEvent, RunPhase, RuntimeUsage } from "@anastom/runtime-contract";
import { assertLiveRunEvent } from "@anastom/runtime-contract";

import type { CommandReport } from "./command.js";
import { replayRun, type RunEvent } from "./events.js";
import { resolveRunWorkflowGraph } from "./graph.js";

const LIVE_LOG_MAX_BYTES = 2 * 1024;
const LIVE_ATTEMPT_LOG_MAX_BYTES = 64 * 1024;
const LIVE_ATTEMPT_LOG_MAX_MESSAGES = 128;
const omittedLogMessage = "Additional public runtime messages omitted";

/** Runtime/model identity retained for one attempt without provider-private account data. */
interface EvidenceRuntimeIdentity {
  provider: string;
  model: string;
  source?: "configured" | "reported";
  runtimeVersion?: string;
}

/** Workspace and immutable diff references measured around one attempt. */
interface AttemptWorkspaceEvidence {
  workspaceId?: string;
  baseCommit?: string;
  headCommit: string;
  changedFiles: readonly string[];
  diffArtifactId: string;
  patchDigest?: string;
}

/** Evidence for one bounded attempt, reconstructed without reading artifact bodies. */
interface AttemptEvidence {
  attempt: number;
  decision:
    | "scheduled"
    | "prepared"
    | "running"
    | "orphaned"
    | "blocked"
    | "succeeded"
    | "failed"
    | "cancelled";
  runtimeId: string;
  inputContextDigest?: string;
  executionPlanDigest?: string;
  identities: readonly EvidenceRuntimeIdentity[];
  usage?: RuntimeUsage;
  outputReport?: ArtifactRef;
  artifacts: readonly ArtifactRef[];
  workspace?: AttemptWorkspaceEvidence;
  decisionSequence?: number;
}

/** Dependency decision that permitted a phase to become ready. */
interface PermittingEvidence {
  nodeId: string;
  decision: "succeeded";
  sequence: number;
}

interface PhaseActorEvidence {
  kind: "controller" | "command" | "runtime";
  runtimeIds?: readonly string[];
  identities?: readonly EvidenceRuntimeIdentity[];
}

/** One executable workflow phase and the exact evidence that advanced it. */
interface PhaseEvidence {
  nodeId: string;
  kind: WorkflowNode["kind"];
  phase: RunPhase;
  decision: NodeStatus;
  actor: PhaseActorEvidence;
  decisionSequence?: number;
  permittedBy: readonly PermittingEvidence[];
  attempts: readonly AttemptEvidence[];
  artifacts: readonly ArtifactRef[];
  integration?: {
    preparationDigest: string;
    parentCommit: string;
    expectedCommit: string;
    committedCommit?: string;
  };
}

/**
 * A deterministic evidence view over immutable workflow history and artifact references.
 * It contains no artifact bodies and is never an independent source of workflow state.
 */
export interface EvidenceLedger {
  version: "anastom.dev/evidence-ledger/v1alpha1";
  runId: string;
  throughSequence: number;
  workflow: { id: string; version: string; digest: string };
  decision:
    "running" | "blocked" | "succeeded" | "failed" | "paused" | "cancelled" | "recovery-blocked";
  phases: readonly PhaseEvidence[];
}

/** Classify an executable node for stable presentation without giving the label policy authority. */
function classifyRunPhase(node: WorkflowNode): RunPhase {
  if (node.kind === "integration") {
    return "integration";
  }
  if (node.kind === "command" || node.kind === "verifier") {
    return "verification";
  }
  if (node.id === "analysis") {
    return "analysis";
  }
  if (node.id === "planning") {
    return "planning";
  }
  if (node.id.startsWith("review.") || node.role?.includes("reviewer")) {
    return "review";
  }
  if (node.id.startsWith("implement.") || node.id === "integrator") {
    return "implementation";
  }
  return "execution";
}

/** Project exact durable history into an immutable, content-reference-only evidence ledger. */
export function projectEvidenceLedger(
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
): EvidenceLedger {
  const state = replayRun(events);
  const graph = resolveRunWorkflowGraph(workflow, state);
  const nodeSucceededAt = new Map(
    events
      .filter(
        (event): event is Extract<RunEvent, { type: "NodeSucceeded" }> =>
          event.type === "NodeSucceeded",
      )
      .map((event) => [event.nodeId, event.sequence]),
  );
  const phases = graph.nodeOrder.map((nodeId): PhaseEvidence => {
    const node = graph.nodes[nodeId];
    const nodeState = state.nodes[nodeId];
    if (!node || !nodeState) {
      throw new Error(`Evidence projection cannot resolve node ${JSON.stringify(nodeId)}`);
    }
    const nodeEvents = events.filter((event) => "nodeId" in event && event.nodeId === nodeId);
    const artifacts = nodeEvents
      .filter(
        (event): event is Extract<RunEvent, { type: "ArtifactProduced" }> =>
          event.type === "ArtifactProduced",
      )
      .map((event) => structuredClone(event.artifact));
    const integration = nodeEvents.find(
      (event): event is Extract<RunEvent, { type: "IntegrationPrepared" }> =>
        event.type === "IntegrationPrepared",
    );
    const committed = nodeEvents.find(
      (event): event is Extract<RunEvent, { type: "IntegrationCommitted" }> =>
        event.type === "IntegrationCommitted",
    );
    const decisionSequence = terminalNodeSequence(nodeEvents);
    const acceptedPatch = events.find(
      (event): event is Extract<RunEvent, { type: "TaskPatchAccepted" }> =>
        event.type === "TaskPatchAccepted" && event.patch.nodeId === nodeId,
    );
    const attempts = nodeState.attempts.map((attempt) =>
      projectAttemptEvidence({
        attempt: attempt.number,
        runtimeId: attempt.runtimeId,
        decision: attempt.status,
        nodeEvents,
        acceptedPatch,
      }),
    );
    return {
      nodeId,
      kind: node.kind,
      phase: classifyRunPhase(node),
      decision: nodeState.status,
      actor: phaseActor(node, attempts),
      ...(decisionSequence === undefined ? {} : { decisionSequence }),
      permittedBy: node.needs.flatMap((dependency): PermittingEvidence[] => {
        const sequence = nodeSucceededAt.get(dependency);
        if (sequence === undefined) {
          return [];
        }
        return [{ nodeId: dependency, decision: "succeeded", sequence }];
      }),
      attempts,
      artifacts,
      ...(integration
        ? {
            integration: {
              preparationDigest: integration.preparation.preparationDigest,
              parentCommit: integration.preparation.parentCommit,
              expectedCommit: integration.preparation.expectedCommit,
              ...(committed ? { committedCommit: committed.commit } : {}),
            },
          }
        : {}),
    };
  });
  return {
    version: "anastom.dev/evidence-ledger/v1alpha1",
    runId: state.runId,
    throughSequence: state.sequence,
    workflow: {
      id: state.workflowId,
      version: state.workflowVersion,
      digest: digestJson(workflow),
    },
    decision: state.status,
    phases,
  };
}

function phaseActor(node: WorkflowNode, attempts: readonly AttemptEvidence[]): PhaseActorEvidence {
  if (node.kind === "integration") {
    return { kind: "controller" };
  }
  if ((node.kind === "command" || node.kind === "verifier") && node.command) {
    return { kind: "command" };
  }
  return {
    kind: "runtime",
    runtimeIds: [...new Set(attempts.map((attempt) => attempt.runtimeId))],
    identities: attempts.flatMap((attempt) => attempt.identities),
  };
}

function projectAttemptEvidence(options: {
  attempt: number;
  runtimeId: string;
  decision: AttemptEvidence["decision"];
  nodeEvents: readonly RunEvent[];
  acceptedPatch?: Extract<RunEvent, { type: "TaskPatchAccepted" }>;
}): AttemptEvidence {
  const { attempt, runtimeId, decision, nodeEvents } = options;
  const attemptEvents = nodeEvents.filter(
    (event) => "attempt" in event && event.attempt === attempt,
  );
  const prepared = attemptEvents.find(
    (event): event is Extract<RunEvent, { type: "AttemptPrepared" }> =>
      event.type === "AttemptPrepared",
  );
  const artifacts = attemptEvents
    .filter(
      (event): event is Extract<RunEvent, { type: "ArtifactProduced" }> =>
        event.type === "ArtifactProduced",
    )
    .map((event) => structuredClone(event.artifact));
  const identities = attemptEvents.flatMap((event): EvidenceRuntimeIdentity[] =>
    event.type === "RuntimeEventObserved" && event.event.type === "metadata"
      ? [structuredClone(event.event)]
      : [],
  );
  const usage = attemptEvents.find(
    (
      event,
    ): event is Extract<RunEvent, { type: "RuntimeEventObserved" }> & {
      event: RuntimeUsage;
    } => event.type === "RuntimeEventObserved" && event.event.type === "usage",
  )?.event;
  const context = artifacts.find((artifact) => artifact.type === "context");
  const outputReport = artifacts.find(
    (artifact) => artifact.type === "worker-report" || artifact.type === "command-result",
  );
  const observed = attemptEvents.find(
    (event): event is Extract<RunEvent, { type: "WorkspaceObserved" }> =>
      event.type === "WorkspaceObserved",
  );
  const patch =
    options.acceptedPatch?.patch.attempt === attempt ? options.acceptedPatch : undefined;
  let workspaceIdentity: {
    workspaceId?: string;
    baseCommit?: string;
    patchDigest?: string;
  } = {};
  if (patch) {
    workspaceIdentity = {
      workspaceId: patch.patch.workspaceId,
      baseCommit: patch.patch.baseCommit,
      patchDigest: patch.patch.patchDigest,
    };
  } else if (prepared) {
    workspaceIdentity = {
      workspaceId: prepared.workspaceCheckpoint.workspaceId,
      baseCommit: prepared.workspaceCheckpoint.baseCommit,
    };
  }
  return {
    attempt,
    decision,
    runtimeId,
    ...(context ? { inputContextDigest: context.digest } : {}),
    ...(prepared ? { executionPlanDigest: prepared.execution.planDigest } : {}),
    identities,
    ...(usage ? { usage: structuredClone(usage) } : {}),
    ...(outputReport ? { outputReport: structuredClone(outputReport) } : {}),
    artifacts,
    ...(observed
      ? {
          workspace: {
            ...workspaceIdentity,
            headCommit: observed.headCommit,
            changedFiles: [...observed.changedFiles],
            diffArtifactId: observed.diffArtifactId,
          },
        }
      : {}),
    ...terminalAttemptSequence(attemptEvents),
  };
}

function terminalAttemptSequence(events: readonly RunEvent[]): { decisionSequence?: number } {
  const event = events.findLast((candidate) =>
    [
      "AttemptSucceeded",
      "AttemptFailed",
      "AttemptBlocked",
      "AttemptCancelled",
      "AttemptOrphaned",
    ].includes(candidate.type),
  );
  return event ? { decisionSequence: event.sequence } : {};
}

function terminalNodeSequence(events: readonly RunEvent[]): number | undefined {
  return events.findLast((event) =>
    ["NodeSucceeded", "NodeFailed", "NodeBlocked", "NodePaused", "NodeCancelled"].includes(
      event.type,
    ),
  )?.sequence;
}

function boundedLiveMessage(message: string): { message: string; messageTruncated?: true } {
  const printable = Array.from(message, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const bytes = Buffer.from(printable);
  if (bytes.length <= LIVE_LOG_MAX_BYTES) {
    return { message: printable };
  }
  let end = LIVE_LOG_MAX_BYTES;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return { message: bytes.subarray(0, end).toString("utf8"), messageTruncated: true };
}

/**
 * Derive presentation-safe live events from authoritative history.
 * Repeating this function with the same history produces byte-equivalent JSON values.
 */
export function projectLiveRunEvents(
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
): LiveRunEvent[] {
  const state = replayRun(events);
  return new LiveRunProjector(workflow).project(state, events);
}

interface AttemptLogProjectionState {
  retainedMessages: number;
  retainedBytes: number;
  pendingDropped: number;
  omissionReported: boolean;
  identity: {
    runId: string;
    nodeId: string;
    phase: RunPhase;
    attempt: number;
  };
}

/**
 * Stateful bounded projector for newly committed batches; instantiate once per displayed run.
 * The same state machine powers full-history replay through {@link projectLiveRunEvents}.
 */
export class LiveRunProjector {
  private readonly attempts = new Map<string, AttemptLogProjectionState>();

  /** Bind one immutable workflow definition for static and event-expanded node classification. */
  constructor(private readonly workflow: WorkflowDefinition) {}

  /** Project a committed batch using its already-folded authoritative state. */
  project(state: ReturnType<typeof replayRun>, events: readonly RunEvent[]): LiveRunEvent[] {
    const graph = resolveRunWorkflowGraph(this.workflow, state);
    const phase = (nodeId: string): RunPhase => {
      const node = graph.nodes[nodeId];
      if (!node) {
        throw new Error(`Live projection cannot resolve node ${JSON.stringify(nodeId)}`);
      }
      return classifyRunPhase(node);
    };
    const projected: LiveRunEvent[] = [];
    for (const event of events) {
      if (terminalAttemptEvent(event)) {
        projected.push(...this.flushAttempt(event.nodeId, event.attempt, event.sequence));
      } else if (terminalRunEvent(event)) {
        projected.push(...this.flushAll(event.sequence));
      }
      const observations = projectLiveEvent(event, phase);
      for (const observation of observations) {
        if (observation.type === "log") {
          projected.push(...this.acceptLog(observation));
        } else {
          projected.push(observation);
        }
      }
    }
    projected.forEach(assertLiveRunEvent);
    return projected;
  }

  private acceptLog(event: Extract<LiveRunEvent, { type: "log" }>): LiveRunEvent[] {
    const key = attemptKey(event.nodeId, event.attempt);
    const state = this.attempts.get(key) ?? {
      retainedMessages: 0,
      retainedBytes: 0,
      pendingDropped: 0,
      omissionReported: false,
      identity: {
        runId: event.runId,
        nodeId: event.nodeId,
        phase: event.phase,
        attempt: event.attempt,
      },
    };
    this.attempts.set(key, state);
    const bytes = Buffer.byteLength(event.message);
    if (
      state.retainedMessages < LIVE_ATTEMPT_LOG_MAX_MESSAGES &&
      state.retainedBytes + bytes <= LIVE_ATTEMPT_LOG_MAX_BYTES
    ) {
      state.retainedMessages++;
      state.retainedBytes += bytes;
      return [event];
    }
    const dropped = (event.droppedMessages ?? 0) + 1;
    if (!state.omissionReported) {
      state.omissionReported = true;
      return [this.omissionEvent(state, event.sequence, dropped)];
    }
    state.pendingDropped += dropped;
    return [];
  }

  private flushAttempt(nodeId: string, attempt: number, sequence: number): LiveRunEvent[] {
    const key = attemptKey(nodeId, attempt);
    const state = this.attempts.get(key);
    this.attempts.delete(key);
    return state && state.pendingDropped > 0
      ? [this.omissionEvent(state, sequence, state.pendingDropped)]
      : [];
  }

  private flushAll(sequence: number): LiveRunEvent[] {
    const events = [...this.attempts.values()].flatMap((state) =>
      state.pendingDropped > 0 ? [this.omissionEvent(state, sequence, state.pendingDropped)] : [],
    );
    this.attempts.clear();
    return events;
  }

  private omissionEvent(
    state: AttemptLogProjectionState,
    sequence: number,
    droppedMessages: number,
  ): Extract<LiveRunEvent, { type: "log" }> {
    return {
      version: "anastom.dev/live-run-event/v1alpha1",
      runId: state.identity.runId,
      sequence,
      type: "log",
      nodeId: state.identity.nodeId,
      phase: state.identity.phase,
      attempt: state.identity.attempt,
      message: omittedLogMessage,
      droppedMessages,
    };
  }
}

function attemptKey(nodeId: string, attempt: number): string {
  return `${nodeId}\u0000${attempt}`;
}

function terminalAttemptEvent(event: RunEvent): event is Extract<
  RunEvent,
  {
    type:
      | "AttemptSucceeded"
      | "AttemptFailed"
      | "AttemptBlocked"
      | "AttemptCancelled"
      | "AttemptOrphaned";
  }
> {
  return [
    "AttemptSucceeded",
    "AttemptFailed",
    "AttemptBlocked",
    "AttemptCancelled",
    "AttemptOrphaned",
  ].includes(event.type);
}

function terminalRunEvent(
  event: RunEvent,
): event is Extract<RunEvent, { type: "RunCompleted" | "RunBlocked" | "RunCancelled" }> {
  return ["RunCompleted", "RunBlocked", "RunCancelled"].includes(event.type);
}

function projectLiveEvent(event: RunEvent, phase: (nodeId: string) => RunPhase): LiveRunEvent[] {
  const base = {
    version: "anastom.dev/live-run-event/v1alpha1" as const,
    runId: event.runId,
    sequence: event.sequence,
  };
  const node = (nodeId: string) => ({ ...base, nodeId, phase: phase(nodeId) });
  const attempt = (nodeId: string, number: number) => ({ ...node(nodeId), attempt: number });
  switch (event.type) {
    case "RunCreated":
      return [{ ...base, type: "run", status: "created" }];
    case "RunPaused":
      return [{ ...base, type: "run", status: "paused" }];
    case "RunResumed":
      return [{ ...base, type: "run", status: "running" }];
    case "RunRecoveryBlocked":
      return [{ ...base, type: "run", status: "recovery-blocked" }];
    case "RunBlocked":
      return [{ ...base, type: "run", status: "blocked" }];
    case "RunCancelled":
      return [{ ...base, type: "run", status: "cancelled" }];
    case "RunCompleted":
      return [{ ...base, type: "run", status: event.outcome }];
    case "WorkflowExpanded":
      return [
        {
          ...base,
          type: "graph",
          status: "expanded",
          nodeCount: event.expansion.nodeOrder.length,
          planDigest: event.plan.planDigest,
          expansionDigest: event.expansion.expansionDigest,
        },
      ];
    case "NodeReady":
      return [{ ...node(event.nodeId), type: "node", status: "ready" }];
    case "NodeSucceeded":
      return [{ ...node(event.nodeId), type: "node", status: "succeeded" }];
    case "NodeFailed":
      return [
        {
          ...node(event.nodeId),
          type: "node",
          status: "failed",
          failureCategory: event.failure.category,
        },
      ];
    case "NodeBlocked":
      return [{ ...node(event.nodeId), type: "node", status: "blocked" }];
    case "NodePaused":
      return [{ ...node(event.nodeId), type: "node", status: "paused" }];
    case "NodeCancelled":
      return [{ ...node(event.nodeId), type: "node", status: "cancelled" }];
    case "AttemptScheduled":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "attempt",
          status: "scheduled",
          runtimeId: event.runtimeId,
        },
      ];
    case "AttemptPrepared":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "attempt",
          status: "prepared",
          planDigest: event.execution.planDigest,
        },
      ];
    case "AttemptStartAuthorized":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "attempt",
          status: "authorized",
          planDigest: event.execution.planDigest,
        },
      ];
    case "AttemptStarted":
      return [{ ...attempt(event.nodeId, event.attempt), type: "attempt", status: "running" }];
    case "AttemptTimeoutRequested":
      return [{ ...attempt(event.nodeId, event.attempt), type: "attempt", status: "timed-out" }];
    case "AttemptOrphaned":
      return [{ ...attempt(event.nodeId, event.attempt), type: "attempt", status: "orphaned" }];
    case "AttemptSucceeded":
      return [{ ...attempt(event.nodeId, event.attempt), type: "attempt", status: "succeeded" }];
    case "AttemptFailed":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "attempt",
          status: "failed",
          failureCategory: event.failure.category,
        },
      ];
    case "AttemptBlocked":
      return [{ ...attempt(event.nodeId, event.attempt), type: "attempt", status: "blocked" }];
    case "AttemptCancelled":
      return [{ ...attempt(event.nodeId, event.attempt), type: "attempt", status: "cancelled" }];
    case "RuntimeEventObserved":
      return projectRuntimeObservation(event, attempt(event.nodeId, event.attempt));
    case "ArtifactProduced": {
      const artifact = {
        id: event.artifact.id,
        type: event.artifact.type,
        mediaType: event.artifact.mediaType,
        uri: event.artifact.uri,
        digest: event.artifact.digest,
      };
      return [{ ...attempt(event.nodeId, event.attempt), type: "artifact", artifact }];
    }
    case "WorkspaceAssigned":
      return [
        {
          ...base,
          type: "workspace",
          status: "assigned",
          workspaceId: event.workspace.id,
          mode: event.workspace.mode,
          ...(event.workspace.mode === "memory"
            ? {}
            : {
                path: event.workspace.path,
                baseCommit: event.workspace.baseCommit,
                ...(event.workspace.mode === "isolated" ? { branch: event.workspace.branch } : {}),
              }),
        },
      ];
    case "NodeWorkspaceAssigned":
      return [
        {
          ...base,
          type: "workspace",
          status: "assigned",
          workspaceId: event.workspace.id,
          mode: event.workspace.mode,
          ...(event.workspace.mode === "memory"
            ? {}
            : {
                path: event.workspace.path,
                baseCommit: event.workspace.baseCommit,
                ...(event.workspace.mode === "isolated" ? { branch: event.workspace.branch } : {}),
              }),
          nodeId: event.nodeId,
        },
      ];
    case "WorkspaceObserved":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "workspace",
          status: "observed",
          headCommit: event.headCommit,
          changedFiles: [...event.changedFiles],
          diffArtifactId: event.diffArtifactId,
        },
      ];
    case "TaskPatchAccepted":
      return [
        {
          ...node(event.patch.nodeId),
          type: "workspace",
          status: "patch-accepted",
          attempt: event.patch.attempt,
          workspaceId: event.patch.workspaceId,
          patchDigest: event.patch.patchDigest,
          changedFiles: [...event.patch.changedFiles],
        },
      ];
    case "IntegrationPrepared":
      return [
        {
          ...node(event.nodeId),
          type: "integration",
          status: "prepared",
          preparationDigest: event.preparation.preparationDigest,
        },
      ];
    case "IntegrationCommitted":
      return [
        { ...node(event.nodeId), type: "integration", status: "committed", commit: event.commit },
      ];
    case "IntegrationFailed":
      return [
        {
          ...node(event.nodeId),
          type: "integration",
          status: "failed",
          failureCategory: event.failure.category,
        },
      ];
    case "CommandCompleted":
      return [verificationEvent(event.output, attempt(event.nodeId, event.attempt))];
    case "ControlRequestObserved":
      return [
        {
          ...base,
          type: "control",
          status: "requested",
          action: event.action,
          operationId: event.operationId,
        },
      ];
    case "ExecutionCleanupObserved":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "control",
          status: "cleanup",
          outcome: event.outcome,
        },
      ];
    case "AttemptCancellationCompleted":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "control",
          status: "cancellation-completed",
          outcome: event.outcome,
        },
      ];
    case "LateResultObserved":
      return [
        {
          ...attempt(event.nodeId, event.attempt),
          type: "control",
          status: "late-result",
          outcome: event.status,
        },
      ];
    default:
      return [];
  }
}

function projectRuntimeObservation(
  event: Extract<RunEvent, { type: "RuntimeEventObserved" }>,
  base: Omit<Extract<LiveRunEvent, { type: "log" }>, "type" | "message">,
): LiveRunEvent[] {
  if (event.event.type === "log") {
    return [
      {
        ...base,
        type: "log",
        ...boundedLiveMessage(event.event.message),
        ...(event.event.droppedLogs ? { droppedMessages: event.event.droppedLogs } : {}),
      },
    ];
  }
  if (event.event.type === "metadata") {
    const identity = {
      provider: event.event.provider,
      model: event.event.model,
      ...(event.event.source ? { source: event.event.source } : {}),
      ...(event.event.runtimeVersion ? { runtimeVersion: event.event.runtimeVersion } : {}),
    };
    return [{ ...base, type: "runtime", ...identity }];
  }
  if (event.event.type === "usage") {
    return [{ ...base, type: "usage", usage: structuredClone(event.event) }];
  }
  return [];
}

function verificationEvent(
  report: CommandReport,
  base: Omit<Extract<LiveRunEvent, { type: "verification" }>, "type" | keyof CommandReport>,
): Extract<LiveRunEvent, { type: "verification" }> {
  return { ...base, type: "verification", ...structuredClone(report) };
}
