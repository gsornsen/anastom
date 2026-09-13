import { isAbsolute } from "node:path";
import Ajv from "ajv";
import type { WorkflowDefinition } from "./types.js";
import { parseWorkflowYaml } from "./workflow.js";

const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
const budget = { type: "object", additionalProperties: false, required: ["maxAttempts"], properties: {
  maxAttempts: { type: "integer", minimum: 1 }, maxDurationMs: { type: "integer", minimum: 1, maximum: 2147483647 },
} };
const schemaRef = { type: "object", additionalProperties: false, required: ["ref", "schema"], properties: { ref: { type: "string", minLength: 1 }, schema: { type: "object" } } };
const validate = ajv.compile({
  type: "object", additionalProperties: false, required: ["apiVersion", "kind", "metadata", "sourcePath", "inputs", "policies", "nodeOrder", "nodes"],
  properties: {
    apiVersion: { const: "anastom.dev/v1alpha1" }, kind: { const: "Workflow" },
    metadata: { type: "object", additionalProperties: false, required: ["id", "version"], properties: { id: { type: "string" }, version: { type: "string" } } },
    sourcePath: { type: "string", minLength: 1 },
    inputs: { type: "object", additionalProperties: { ...schemaRef, required: ["id", "ref", "schema"], properties: { ...schemaRef.properties, id: { type: "string" } } } },
    policies: { type: "object", additionalProperties: false, required: ["defaultAttemptBudget"], properties: { defaultAttemptBudget: budget } },
    nodeOrder: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
    nodes: { type: "object", minProperties: 1, additionalProperties: {
      type: "object", additionalProperties: false, required: ["id", "kind", "needs", "output", "attemptBudget"],
      properties: {
        id: { type: "string" }, kind: { enum: ["agent", "command", "verifier", "gate"] }, needs: { type: "array", uniqueItems: true, items: { type: "string" } },
        role: { type: "string", minLength: 1 }, output: schemaRef, attemptBudget: budget, mutation: { enum: ["readonly", "isolated"] },
        command: { type: "object", additionalProperties: false, required: ["argv", "cwd", "maxDurationMs", "maxOutputBytes"], properties: {
          argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, cwd: { type: "string" },
          maxDurationMs: { type: "integer", minimum: 1, maximum: 2147483647 }, maxOutputBytes: { type: "integer", minimum: 1, maximum: 16777216 },
        } },
      },
    } },
    task: { type: "object", additionalProperties: false, required: ["objective", "acceptanceCriteria"], properties: {
      objective: { type: "string", minLength: 1 }, acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    } },
  },
});
export function assertWorkflowDefinition(value: unknown): asserts value is WorkflowDefinition {
  if (!validate(value)) throw new Error("Corrupt workflow definition: " + ajv.errorsText(validate.errors));
  const workflow = value as WorkflowDefinition;
  if (!isAbsolute(workflow.sourcePath)) throw new Error("Corrupt workflow source path");
  if (workflow.nodeOrder.length !== Object.keys(workflow.nodes).length || workflow.nodeOrder.some((id) => !Object.hasOwn(workflow.nodes, id))) throw new Error("Corrupt workflow node order");
  for (const [id, input] of Object.entries(workflow.inputs)) {
    if (id !== input.id) throw new Error("Corrupt workflow input identity");
    ajv.compile(input.schema);
  }
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (id !== node.id) throw new Error("Corrupt workflow node identity");
    ajv.compile(node.output.schema);
  }
  parseWorkflowYaml(JSON.stringify({
    apiVersion: workflow.apiVersion, kind: workflow.kind, metadata: workflow.metadata,
    inputs: Object.fromEntries(Object.entries(workflow.inputs).map(([id, input]) => [id, { schema: input.ref }])),
    nodes: Object.fromEntries(Object.entries(workflow.nodes).map(([id, node]) => [id, {
      kind: node.kind, needs: node.needs, output: { schema: node.output.ref },
      ...(node.role === undefined ? {} : { role: node.role }), ...(node.mutation === undefined ? {} : { mutation: node.mutation }),
      ...(node.command === undefined ? {} : { command: { argv: node.command.argv, cwd: node.command.cwd, maxDuration: node.command.maxDurationMs + "ms", maxOutputBytes: node.command.maxOutputBytes } }),
    }])),
  }));
}
