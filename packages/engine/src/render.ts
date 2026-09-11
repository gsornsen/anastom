import type { WorkflowDefinition } from "@anastom/core";

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
