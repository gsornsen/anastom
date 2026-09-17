import Ajv from "ajv";

import expansionJsonSchema from "../schemas/sdlc-graph-expansion.v1alpha1.json" with { type: "json" };
import { digestJson } from "./canonical.js";
import type { FeatureDefinition, FeatureVerifierDefinition } from "./feature.js";
import { formatSchemaErrors } from "./feature.js";
import type { SdlcMethodologySnapshot, SdlcRoleName } from "./methodology.js";
import type { NormalizedFeaturePlan } from "./plan.js";
import type { AttemptBudget } from "./types.js";
import { SdlcValidationError as ValidationError } from "./feature.js";

/** A model-backed generated node with exact role, policy, and output-contract identity. */
interface SdlcAgentExpansionNode {
  id: string;
  kind: "agent";
  needs: readonly string[];
  role: Exclude<SdlcRoleName, "analyst" | "planner">;
  taskId?: string;
  mutation: "readonly" | "isolated";
  mutationScopes: readonly string[];
  attemptBudget: Required<AttemptBudget>;
  outputSchemaDigest: string;
}

/** A deterministic controller operation that integrates one dependency wave in plan order. */
interface SdlcIntegrationExpansionNode {
  id: string;
  kind: "integration";
  needs: readonly string[];
  wave: number;
  taskIds: readonly string[];
}

/** One exact operator-authored command retained as a generated verifier node. */
interface SdlcVerifierExpansionNode {
  id: string;
  kind: "verifier";
  needs: readonly string[];
  verifier: FeatureVerifierDefinition;
}

/** A generated node whose operation is fully selected by trusted control-plane code. */
type SdlcExpansionNode =
  SdlcAgentExpansionNode | SdlcIntegrationExpansionNode | SdlcVerifierExpansionNode;

/**
 * Content-addressed graph data persisted as the authority for post-planning execution.
 * @public
 */
export interface SdlcGraphExpansion {
  apiVersion: "anastom.dev/v1alpha1";
  kind: "WorkflowExpansion";
  source: {
    featureDigest: string;
    methodologyDigest: string;
    planDigest: string;
  };
  maxParallel: number;
  externalNeeds: readonly string[];
  nodeOrder: readonly string[];
  nodes: Readonly<Record<string, SdlcExpansionNode>>;
  expansionDigest: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateExpansion = ajv.compile<SdlcGraphExpansion>(expansionJsonSchema);

function agentNode(options: {
  id: string;
  needs: readonly string[];
  role: Exclude<SdlcRoleName, "analyst" | "planner">;
  taskId?: string;
  scopes: readonly string[];
  feature: FeatureDefinition;
  methodology: SdlcMethodologySnapshot;
}): SdlcAgentExpansionNode {
  const role = options.methodology.roles[options.role];
  return {
    id: options.id,
    kind: "agent",
    needs: [...options.needs],
    role: options.role,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    mutation: role.mutation,
    mutationScopes: [...options.scopes],
    attemptBudget: {
      maxAttempts: options.feature.policies.attemptBudget.maxAttempts,
      maxDurationMs: options.feature.policies.attemptBudget.maxDurationMs!,
    },
    outputSchemaDigest: role.outputSchemaDigest,
  };
}

/**
 * Expand a trusted plan into deterministic task, integration, review, and verifier nodes.
 * @public
 */
export function expandSdlcPlan(
  feature: FeatureDefinition,
  methodology: SdlcMethodologySnapshot,
  plan: NormalizedFeaturePlan,
): SdlcGraphExpansion {
  const nodes: Record<string, SdlcExpansionNode> = {};
  const nodeOrder: string[] = [];
  let precedingIntegration = "planning";
  for (const [waveIndex, taskIds] of plan.waves.entries()) {
    for (const taskId of taskIds) {
      const task = plan.tasks[taskId]!;
      const id = `implement-${taskId}`;
      nodes[id] = agentNode({
        id,
        needs: [precedingIntegration],
        role: "implementer",
        taskId,
        scopes: task.mutationScopes,
        feature,
        methodology,
      });
      nodeOrder.push(id);
    }
    const integrationId = `integrate-wave-${waveIndex + 1}`;
    nodes[integrationId] = {
      id: integrationId,
      kind: "integration",
      needs: taskIds.map((taskId) => `implement-${taskId}`),
      wave: waveIndex + 1,
      taskIds: [...taskIds],
    };
    nodeOrder.push(integrationId);
    precedingIntegration = integrationId;
  }
  const allScopes = plan.taskOrder.flatMap((taskId) => plan.tasks[taskId]!.mutationScopes);
  nodes.integrator = agentNode({
    id: "integrator",
    needs: [precedingIntegration],
    role: "integrator",
    scopes: [...new Set(allScopes)],
    feature,
    methodology,
  });
  nodes["review-specification"] = agentNode({
    id: "review-specification",
    needs: ["integrator"],
    role: "specificationReviewer",
    scopes: [],
    feature,
    methodology,
  });
  nodes["review-quality"] = agentNode({
    id: "review-quality",
    needs: ["integrator"],
    role: "qualityReviewer",
    scopes: [],
    feature,
    methodology,
  });
  nodeOrder.push("integrator", "review-specification", "review-quality");
  let verifierNeeds = ["review-specification", "review-quality"];
  for (const verifier of feature.verification) {
    const id = `verify-${verifier.id}`;
    nodes[id] = {
      id,
      kind: "verifier",
      needs: verifierNeeds,
      verifier: structuredClone(verifier),
    };
    nodeOrder.push(id);
    verifierNeeds = [id];
  }
  const content = {
    apiVersion: "anastom.dev/v1alpha1" as const,
    kind: "WorkflowExpansion" as const,
    source: {
      featureDigest: feature.documentDigest,
      methodologyDigest: methodology.methodologyDigest,
      planDigest: plan.planDigest,
    },
    maxParallel: feature.policies.maxParallel,
    externalNeeds: ["planning"],
    nodeOrder,
    nodes,
  };
  return { ...content, expansionDigest: digestJson(content) };
}

/**
 * Validate a persisted graph expansion and its canonical content digest before replay.
 * @public
 */
export function assertSdlcGraphExpansion(value: unknown): asserts value is SdlcGraphExpansion {
  if (!validateExpansion(value)) {
    throw new ValidationError("workflow expansion", formatSchemaErrors(validateExpansion.errors));
  }
  if (
    value.nodeOrder.length !== Object.keys(value.nodes).length ||
    value.nodeOrder.some((id) => value.nodes[id]?.id !== id)
  ) {
    throw new ValidationError("workflow expansion", ["node order and node identities disagree"]);
  }
  const known = new Set([...value.externalNeeds, ...value.nodeOrder]);
  const positions = new Map(value.nodeOrder.map((id, index) => [id, index]));
  for (const node of Object.values(value.nodes)) {
    if (node.needs.some((dependency) => !known.has(dependency))) {
      throw new ValidationError("workflow expansion", [
        `node ${JSON.stringify(node.id)} has an unknown dependency`,
      ]);
    }
    const position = positions.get(node.id)!;
    if (
      node.needs.some((dependency) => {
        const dependencyPosition = positions.get(dependency);
        return dependencyPosition !== undefined && dependencyPosition >= position;
      })
    ) {
      throw new ValidationError("workflow expansion", [
        `node ${JSON.stringify(node.id)} must follow every internal dependency`,
      ]);
    }
  }
  const { expansionDigest, ...content } = value;
  if (digestJson(content) !== expansionDigest) {
    throw new ValidationError("workflow expansion", ["expansion digest does not match content"]);
  }
}
