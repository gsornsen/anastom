import type { WorkflowDefinition, WorkflowNode } from "@anastom/core";

import type { RunState } from "./events.js";

/** Folded executable graph assembled from the immutable prefix and optional expansion event. */
export interface RunWorkflowGraph {
  nodeOrder: readonly string[];
  nodes: Readonly<Record<string, WorkflowNode>>;
  maxParallel: number;
}

/**
 * Resolve the exact executable graph retained by a run's definition and event-derived expansion.
 * @throws When expansion identity disagrees with its immutable Feature or methodology snapshot.
 */
export function resolveRunWorkflowGraph(
  workflow: WorkflowDefinition,
  state: RunState,
): RunWorkflowGraph {
  const expansion = state.expansion;
  if (!expansion) {
    return {
      nodeOrder: workflow.nodeOrder,
      nodes: workflow.nodes,
      maxParallel: workflow.policies.maxParallel,
    };
  }
  const configured = workflow.definedSdlc;
  if (
    !configured ||
    expansion.source.featureDigest !== configured.feature.documentDigest ||
    expansion.source.methodologyDigest !== configured.methodology.methodologyDigest ||
    expansion.source.planDigest !== state.plan?.planDigest ||
    expansion.maxParallel !== configured.feature.policies.maxParallel ||
    !expansion.externalNeeds.includes(configured.planningNodeId)
  ) {
    throw new Error("Run expansion does not match its immutable workflow definition");
  }
  return {
    nodeOrder: [...workflow.nodeOrder, ...expansion.nodeOrder],
    nodes: { ...workflow.nodes, ...expansion.nodes },
    maxParallel: expansion.maxParallel,
  };
}

/** Resolve one static or expanded node without allowing callers to guess graph membership. */
export function resolveRunWorkflowNode(
  workflow: WorkflowDefinition,
  state: RunState,
  nodeId: string,
): WorkflowNode | undefined {
  return resolveRunWorkflowGraph(workflow, state).nodes[nodeId];
}
