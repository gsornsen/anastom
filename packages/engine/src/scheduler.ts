import type { WorkflowDefinition } from "@anastom/core";

import type { RunState } from "./events.js";

/**
 * Find pending nodes whose declared dependencies have all succeeded, in authored node order.
 */
export function findExecutableNodes(workflow: WorkflowDefinition, state: RunState): string[] {
  return workflow.nodeOrder.filter((nodeId) => {
    const nodeState = state.nodes[nodeId];
    const node = workflow.nodes[nodeId];
    return (
      nodeState?.status === "pending" &&
      node !== undefined &&
      node.needs.every((dependency) => state.nodes[dependency]?.status === "succeeded")
    );
  });
}

/**
 * Return ready nodes in authored order for deterministic sequential scheduling.
 */
export function findReadyNodes(workflow: WorkflowDefinition, state: RunState): string[] {
  return workflow.nodeOrder.filter((nodeId) => state.nodes[nodeId]?.status === "ready");
}
