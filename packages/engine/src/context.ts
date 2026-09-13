import { canonicalJson, digestBytes, type WorkflowDefinition } from "@anastom/core";
import type { ArtifactRef, ContextEnvelope, WorkspaceRef } from "@anastom/runtime-contract";
import type { RunState } from "./events.js";

export function buildContext(workflow: WorkflowDefinition, state: RunState, nodeId: string, attempt: number, workspace: WorkspaceRef, artifacts: readonly ArtifactRef[] = []): { envelope: ContextEnvelope; bytes: string; digest: string } {
  const node = workflow.nodes[nodeId];
  if (!node) throw new Error("Unknown context node " + nodeId);
  const dependencyOutputs = Object.fromEntries(node.needs.map((id) => {
    const output = state.nodes[id]?.output;
    if (output === undefined) throw new Error("Dependency has no structured output: " + id);
    return [id, structuredClone(output)];
  }));
  const envelope: ContextEnvelope = {
    version: "anastom.dev/context/v1alpha1", runId: state.runId, workflowInstanceId: state.workflowInstanceId, nodeId, attempt,
    inputs: structuredClone(state.inputs), dependencyOutputs,
    ...(workflow.task ? { task: { id: workflow.metadata.id, version: workflow.metadata.version, ...structuredClone(workflow.task) } } : {}),
    ...(node.role ? { role: { id: node.role } } : {}),
    workspace: structuredClone(workspace), allowedMutations: node.mutation ?? "readonly",
    artifacts: structuredClone(artifacts),
    ...(workflow.nodes.verify?.command ? { verification: structuredClone(workflow.nodes.verify.command) } : {}),
    requiredOutputSchema: structuredClone(node.output.schema), budget: structuredClone(node.attemptBudget),
  };
  const bytes = canonicalJson(envelope);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(envelope);
  return { envelope, bytes, digest: digestBytes(bytes) };
}
