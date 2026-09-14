import { canonicalJson, digestBytes, type WorkflowDefinition } from "@anastom/core";
import type { ArtifactRef, ContextEnvelope, WorkspaceRef } from "@anastom/runtime-contract";
import type { RunState } from "./events.js";

/** Named context inputs make workspace and attempt identity explicit at the call site. */
export interface ContextOptions {
  workflow: WorkflowDefinition;
  state: RunState;
  nodeId: string;
  attempt: number;
  workspace: WorkspaceRef;
  artifacts?: readonly ArtifactRef[];
}

/**
 * Copy declared inputs and successful dependency outputs into a fresh, deeply frozen attempt envelope.
 * @remarks Canonical bytes and SHA-256 digest are computed before runtime execution; prior sessions are excluded.
 * @throws If a required node or dependency output is missing.
 */
export function buildContext(options: ContextOptions): {
  envelope: ContextEnvelope;
  bytes: string;
  digest: string;
} {
  const { workflow, state, nodeId, attempt, workspace, artifacts = [] } = options;
  const node = workflow.nodes[nodeId];
  if (!node) {
    throw new Error("Unknown context node " + nodeId);
  }
  const dependencyOutputs = Object.fromEntries(
    node.needs.map((id) => {
      const output = state.nodes[id]?.output;
      if (output === undefined) {
        throw new Error("Dependency has no structured output: " + id);
      }
      return [id, structuredClone(output)];
    }),
  );
  const envelope: ContextEnvelope = {
    version: "anastom.dev/context/v1alpha1",
    runId: state.runId,
    workflowInstanceId: state.workflowInstanceId,
    nodeId,
    attempt,
    inputs: structuredClone(state.inputs),
    dependencyOutputs,
    ...(workflow.task
      ? {
          task: {
            id: workflow.metadata.id,
            version: workflow.metadata.version,
            ...structuredClone(workflow.task),
          },
        }
      : {}),
    ...(node.role ? { role: { id: node.role } } : {}),
    workspace: structuredClone(workspace),
    allowedMutations: node.mutation ?? "readonly",
    artifacts: structuredClone(artifacts),
    ...(workflow.nodes.verify?.command
      ? { verification: structuredClone(workflow.nodes.verify.command) }
      : {}),
    requiredOutputSchema: structuredClone(node.output.schema),
    budget: structuredClone(node.attemptBudget),
  };
  const bytes = canonicalJson(envelope);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(envelope);
  return { envelope, bytes, digest: digestBytes(bytes) };
}
