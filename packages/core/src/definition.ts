import { isAbsolute } from "node:path";
import Ajv from "ajv";
import workflowDefinitionSchema from "../schemas/workflow-definition.v1alpha1.json" with { type: "json" };
import type { WorkflowDefinition } from "./types.js";
import { parseWorkflowYaml } from "./workflow.js";

const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
const validate = ajv.compile<WorkflowDefinition>(workflowDefinitionSchema);
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
  for (const [id, input] of Object.entries(workflow.inputs)) {
    if (id !== input.id) {
      throw new Error("Corrupt workflow input identity");
    }
    ajv.compile(input.schema);
  }
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (id !== node.id) {
      throw new Error("Corrupt workflow node identity");
    }
    ajv.compile(node.output.schema);
  }
  parseWorkflowYaml(
    JSON.stringify({
      apiVersion: workflow.apiVersion,
      kind: workflow.kind,
      metadata: workflow.metadata,
      inputs: Object.fromEntries(
        Object.entries(workflow.inputs).map(([id, input]) => [id, { schema: input.ref }]),
      ),
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
