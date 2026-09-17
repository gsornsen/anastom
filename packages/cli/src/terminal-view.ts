import { resolveRunWorkflowGraph } from "@anastom/engine";
import type { RuntimeUsage } from "@anastom/runtime-contract";

import type { DurableRunInspection } from "./durable.js";
import { terminalSafeText } from "./live.js";

const activityLimit = 12;

/** One node row selected from authoritative graph state and public attempt observations. */
export interface TerminalNodeView {
  nodeId: string;
  phase: string;
  status: string;
  needs: readonly string[];
  attempt?: number;
  attemptStatus?: string;
  runtime?: { provider: string; model: string };
  usage?: RuntimeUsage;
}

/** Bounded disposable presentation state for one durable terminal frame. */
export interface TerminalRunView {
  runId: string;
  workflowId: string;
  status: string;
  sequence: number;
  ownerState: DurableRunInspection["ownership"]["ownerState"];
  pendingControls: readonly { action: "pause" | "cancel"; operationId: string }[];
  nodes: readonly TerminalNodeView[];
  activity: readonly { sequence: number; text: string; tone: string }[];
}

/**
 * Project a complete durable inspection into bounded presentation-only terminal state.
 * @throws When complete public history or evidence is absent from the inspection.
 */
export function projectTerminalRunView(inspection: DurableRunInspection): TerminalRunView {
  if (!inspection.liveEvents || !inspection.evidence) {
    throw new Error("Terminal projection requires complete public run history");
  }
  const liveEvents = inspection.liveEvents;
  const graph = resolveRunWorkflowGraph(inspection.workflow, inspection.state);
  const phases = new Map(
    inspection.evidence.phases.map((phase) => [phase.nodeId, phase.phase] as const),
  );
  const nodes = graph.nodeOrder.map((nodeId): TerminalNodeView => {
    const graphNode = graph.nodes[nodeId];
    const stateNode = inspection.state.nodes[nodeId];
    if (!graphNode || !stateNode) {
      throw new Error(`Terminal projection cannot resolve node ${JSON.stringify(nodeId)}`);
    }
    const latestAttempt = stateNode.attempts.at(-1);
    const runtime = latestAttempt
      ? liveEvents.findLast(
          (event) =>
            event.type === "runtime" &&
            event.nodeId === nodeId &&
            event.attempt === latestAttempt.number,
        )
      : undefined;
    const usage = latestAttempt
      ? liveEvents.findLast(
          (event) =>
            event.type === "usage" &&
            event.nodeId === nodeId &&
            event.attempt === latestAttempt.number,
        )
      : undefined;
    return {
      nodeId,
      phase: phases.get(nodeId) ?? "execution",
      status: stateNode.status,
      needs: [...graphNode.needs],
      ...(latestAttempt
        ? { attempt: latestAttempt.number, attemptStatus: latestAttempt.status }
        : {}),
      ...(runtime && runtime.type === "runtime"
        ? { runtime: { provider: runtime.provider, model: runtime.model } }
        : {}),
      ...(usage && usage.type === "usage" ? { usage: usage.usage } : {}),
    };
  });
  return {
    runId: inspection.state.runId,
    workflowId: inspection.state.workflowId,
    status: inspection.state.status,
    sequence: inspection.state.sequence,
    ownerState: inspection.ownership.ownerState,
    pendingControls: inspection.pendingControls.map(({ action, operationId }) => ({
      action,
      operationId,
    })),
    nodes,
    activity: liveEvents
      .flatMap((event) => {
        const activity = describeActivity(event);
        return activity ? [{ sequence: event.sequence, ...activity }] : [];
      })
      .slice(-activityLimit),
  };
}

function describeActivity(
  event: NonNullable<DurableRunInspection["liveEvents"]>[number],
): { text: string; tone: string } | undefined {
  switch (event.type) {
    case "log":
      return {
        text: `${event.nodeId}/${event.attempt} ${terminalSafeText(event.message)}${event.droppedMessages ? ` (dropped=${event.droppedMessages})` : ""}`,
        tone: "normal",
      };
    case "integration":
      return {
        text: `${event.nodeId} integration ${event.status}${event.commit ? ` ${event.commit.slice(0, 12)}` : ""}`,
        tone: event.status === "failed" ? "bad" : "good",
      };
    case "verification":
      return {
        text: `${event.nodeId}/${event.attempt} verification ${event.passed ? "passed" : "failed"} (${Math.round(event.durationMs)} ms)`,
        tone: event.passed ? "good" : "bad",
      };
    case "control":
      return {
        text: `control ${event.status}${"action" in event ? ` ${event.action}` : ""}${"outcome" in event ? ` ${event.outcome}` : ""}`,
        tone: "warn",
      };
    case "run":
      return { text: `run ${event.status}`, tone: statusTone(event.status) };
    case "node":
      return {
        text: `${event.phase} ${event.nodeId} ${event.status}`,
        tone: statusTone(event.status),
      };
    default:
      return undefined;
  }
}

function statusTone(status: string): string {
  if (["succeeded", "passed", "committed"].includes(status)) {
    return "good";
  }
  if (["failed", "blocked", "recovery-blocked", "cancelled"].includes(status)) {
    return "bad";
  }
  if (["paused", "timed-out", "orphaned"].includes(status)) {
    return "warn";
  }
  return "normal";
}
