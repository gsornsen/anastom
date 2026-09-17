import { isAbsolute, posix } from "node:path";
import Ajv from "ajv";
import workflowDefinitionSchema from "../schemas/workflow-definition.v1alpha1.json" with { type: "json" };
import { digestBytes } from "./canonical.js";
import { assertFeatureDefinition } from "./feature.js";
import { assertSdlcMethodologySnapshot } from "./methodology.js";
import type { WorkflowDefinition } from "./types.js";
import { parseWorkflowYaml } from "./workflow.js";

const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
const validate = ajv.compile<WorkflowDefinition>(workflowDefinitionSchema);

function assertDefinedSdlcBinding(workflow: WorkflowDefinition): void {
  const snapshot = workflow.definedSdlc;
  if (snapshot === undefined) {
    return;
  }
  if (
    Object.keys(snapshot).sort().join("\0") !==
      ["analysisNodeId", "feature", "methodology", "planningNodeId", "protectedPaths"]
        .sort()
        .join("\0") ||
    snapshot.analysisNodeId !== "analysis" ||
    snapshot.planningNodeId !== "planning" ||
    !Array.isArray(snapshot.protectedPaths) ||
    !snapshot.protectedPaths.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        !path.split("/").includes("..") &&
        path.split("/")[0] !== ".git" &&
        posix.normalize(path) === path,
    ) ||
    [...new Set(snapshot.protectedPaths)].sort().join("\0") !== snapshot.protectedPaths.join("\0")
  ) {
    throw new Error("Corrupt defined-SDLC workflow identity");
  }
  assertFeatureDefinition(snapshot.feature);
  assertSdlcMethodologySnapshot(snapshot.methodology);
  if (
    workflow.nodes[snapshot.analysisNodeId]?.role !== snapshot.methodology.roles.analyst.id ||
    workflow.nodes[snapshot.planningNodeId]?.role !== snapshot.methodology.roles.planner.id ||
    workflow.metadata.id !== snapshot.feature.metadata.id ||
    workflow.metadata.version !== snapshot.feature.metadata.version ||
    workflow.policies.maxParallel !== snapshot.feature.policies.maxParallel
  ) {
    throw new Error("Corrupt defined-SDLC workflow binding");
  }
}

function assertNodeDefinition(id: string, node: WorkflowDefinition["nodes"][string]): void {
  if (id !== node.id) {
    throw new Error("Corrupt workflow node identity");
  }
  ajv.compile(node.output.schema);
  if ((node.instructions === undefined) !== (node.instructionsDigest === undefined)) {
    throw new Error("Corrupt workflow instructions identity");
  }
  if (
    node.instructions !== undefined &&
    digestBytes(node.instructions) !== node.instructionsDigest
  ) {
    throw new Error("Corrupt workflow instructions digest");
  }
  if (node.kind === "integration" && node.controller?.operation !== "integrate-patches") {
    throw new Error("Corrupt workflow integration controller");
  }
  if (node.kind !== "integration" && node.controller !== undefined) {
    throw new Error("Corrupt workflow controller authority");
  }
}
/**
 * Validate a persisted normalized definition, including node identities, graph semantics, and embedded schemas.
 * @throws If storage contains invalid or inconsistent workflow data; never repairs guessed state.
 */
export function assertWorkflowDefinition(value: unknown): asserts value is WorkflowDefinition {
  if (!validate(value)) {
    throw new Error("Corrupt workflow definition: " + ajv.errorsText(validate.errors));
  }
  const workflow = value;
  if (!isAbsolute(workflow.sourcePath)) {
    throw new Error("Corrupt workflow source path");
  }
  if (
    workflow.nodeOrder.length !== Object.keys(workflow.nodes).length ||
    workflow.nodeOrder.some((id) => !Object.hasOwn(workflow.nodes, id))
  ) {
    throw new Error("Corrupt workflow node order");
  }
  assertDefinedSdlcBinding(workflow);
  for (const [id, input] of Object.entries(workflow.inputs)) {
    if (id !== input.id) {
      throw new Error("Corrupt workflow input identity");
    }
    ajv.compile(input.schema);
  }
  for (const [id, node] of Object.entries(workflow.nodes)) {
    assertNodeDefinition(id, node);
  }
  parseWorkflowYaml(
    JSON.stringify({
      apiVersion: workflow.apiVersion,
      kind: workflow.kind,
      metadata: workflow.metadata,
      inputs: Object.fromEntries(
        Object.entries(workflow.inputs).map(([id, input]) => [id, { schema: input.ref }]),
      ),
      policies: {
        defaultAttemptBudget: {
          maxAttempts: workflow.policies.defaultAttemptBudget.maxAttempts,
          ...(workflow.policies.defaultAttemptBudget.maxDurationMs === undefined
            ? {}
            : {
                maxDuration: workflow.policies.defaultAttemptBudget.maxDurationMs + "ms",
              }),
        },
        maxParallel: workflow.policies.maxParallel,
      },
      nodes: Object.fromEntries(
        Object.entries(workflow.nodes).map(([id, node]) => [
          id,
          {
            kind: node.kind,
            needs: node.needs,
            output: { schema: node.output.ref },
            ...(node.role === undefined ? {} : { role: node.role }),
            ...(node.mutation === undefined ? {} : { mutation: node.mutation }),
            ...(node.command === undefined
              ? {}
              : {
                  command: {
                    argv: node.command.argv,
                    cwd: node.command.cwd,
                    maxDuration: node.command.maxDurationMs + "ms",
                    maxOutputBytes: node.command.maxOutputBytes,
                  },
                }),
          },
        ]),
      ),
    }),
  );
}
