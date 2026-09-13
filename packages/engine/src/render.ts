import { digestJson, type WorkflowDefinition } from "@anastom/core";
import type { RunEvent } from "./events.js";

import type { RunState } from "./events.js";

export function renderWorkflowGraph(workflow: WorkflowDefinition): string {
  const dependents = new Map<string, string[]>();
  for (const nodeId of workflow.nodeOrder) dependents.set(nodeId, []);
  for (const nodeId of workflow.nodeOrder) {
    for (const dependency of workflow.nodes[nodeId]?.needs ?? []) dependents.get(dependency)?.push(nodeId);
  }
  return [
    `${workflow.metadata.id}@${workflow.metadata.version}`,
    ...workflow.nodeOrder.map((nodeId) => {
      const node = workflow.nodes[nodeId];
      const outgoing = dependents.get(nodeId) ?? [];
      return `${nodeId} [${node?.kind ?? "unknown"}] -> ${outgoing.length === 0 ? "(end)" : outgoing.join(", ")}`;
    }),
  ].join("\n");
}

export function renderRunStatus(state: RunState, workflow: WorkflowDefinition): string {
  return [
    `Run ${state.runId} [${state.status}]`,
    `Workflow ${state.workflowId}@${state.workflowVersion}`,
    ...workflow.nodeOrder.map((nodeId) => {
      const node = state.nodes[nodeId];
      const failure = node?.failure === undefined ? "" : ` (${node.failure.category}: ${node.failure.message})`;
      return `${nodeId}: ${node?.status ?? "unknown"} attempts=${node?.attempts.length ?? 0}${failure}`;
    }),
  ].join("\n");
}

export function renderRunInspection(state: RunState, workflow: WorkflowDefinition, events: readonly RunEvent[]): string {
  return [
    renderRunStatus(state, workflow),
    "Definition: " + digestJson(workflow),
    ...(state.workspace && state.workspace.mode !== "memory" ? [
      "Workspace: " + state.workspace.path + " [" + state.workspace.mode + "]",
      "Base: " + state.workspace.baseCommit,
      ...(state.workspace.mode === "isolated" ? ["Branch: " + state.workspace.branch] : []),
    ] : []),
    ...(state.workspaceObservation ? ["Head: " + state.workspaceObservation.headCommit, "Changed files: " + state.workspaceObservation.changedFiles.join(", ")] : []),
    ...Object.values(state.nodes).flatMap((node) => [
      ...node.attempts.map((attempt) => `Attempt ${node.id}/${attempt.number}: ${attempt.runtimeId} ${attempt.status}${attempt.failure ? " (" + attempt.failure.category + ": " + attempt.failure.message + ")" : ""}${attempt.timeout ? " timeout cancellation=" + attempt.timeout.cancellation + " late=" + (attempt.timeout.lateStatus ?? "none") : ""}`),
      ...(node.command ? [
        `Verification: passed=${node.command.passed} exit=${node.command.exitCode} signal=${node.command.signal} durationMs=${Math.round(node.command.durationMs)}`,
        `Verification output: stdoutBytes=${node.command.stdoutBytes} truncated=${node.command.stdoutTruncated}; stderrBytes=${node.command.stderrBytes} truncated=${node.command.stderrTruncated}`,
      ] : []),
    ]),
    ...(state.artifacts ?? []).map((artifact) => `Artifact ${artifact.type}: ${artifact.uri} (${artifact.digest})`),
    "Events:",
    ...events.map((event) => `  ${event.sequence}: ${event.type}${"nodeId" in event ? " " + event.nodeId : ""}${"attempt" in event ? "/" + event.attempt : ""}${event.type === "RuntimeEventObserved" && event.event.type === "metadata" ? " " + event.event.provider + "/" + event.event.model : ""}`),
  ].join("\n");
}
