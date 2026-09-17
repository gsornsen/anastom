import type { FeatureDefinition } from "./feature.js";
import type { SdlcMethodologySnapshot, SdlcRoleName } from "./methodology.js";
import { normalizeProtectedPaths } from "./protected-paths.js";
import type { WorkflowDefinition, WorkflowNode } from "./types.js";

function roleNode(options: {
  id: string;
  needs: readonly string[];
  roleName: Extract<SdlcRoleName, "analyst" | "planner">;
  feature: FeatureDefinition;
  methodology: SdlcMethodologySnapshot;
}): WorkflowNode {
  const role = options.methodology.roles[options.roleName];
  return {
    id: options.id,
    kind: "agent",
    needs: [...options.needs],
    role: role.id,
    output: {
      ref: role.outputSchemaRef,
      schema: structuredClone(role.outputSchema),
    },
    attemptBudget: structuredClone(options.feature.policies.attemptBudget),
    mutation: role.mutation,
    instructions: role.prompt,
    instructionsDigest: role.promptDigest,
    mutationScopes: [],
  };
}

/**
 * Compile a Feature and immutable methodology snapshot into analysis and planning nodes.
 * @remarks Successful planning expands this durable graph through a `WorkflowExpanded` event.
 * @public
 */
export function compileSdlcFeature(
  feature: FeatureDefinition,
  methodology: SdlcMethodologySnapshot,
  options: { protectedPaths: readonly string[] },
): WorkflowDefinition {
  const analysis = roleNode({
    id: "analysis",
    needs: [],
    roleName: "analyst",
    feature,
    methodology,
  });
  const planning = roleNode({
    id: "planning",
    needs: ["analysis"],
    roleName: "planner",
    feature,
    methodology,
  });
  return {
    apiVersion: "anastom.dev/v1alpha1",
    kind: "Workflow",
    metadata: structuredClone(feature.metadata),
    sourcePath: feature.sourcePath,
    inputs: {},
    policies: {
      defaultAttemptBudget: structuredClone(feature.policies.attemptBudget),
      maxParallel: feature.policies.maxParallel,
    },
    nodeOrder: [analysis.id, planning.id],
    nodes: { [analysis.id]: analysis, [planning.id]: planning },
    definedSdlc: {
      feature: structuredClone(feature),
      methodology: structuredClone(methodology),
      analysisNodeId: analysis.id,
      planningNodeId: planning.id,
      protectedPaths: normalizeProtectedPaths([
        ...options.protectedPaths,
        ...feature.policies.protectedPaths,
      ]),
    },
  };
}
