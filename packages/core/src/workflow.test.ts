import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkflowValidationError,
  loadWorkflow,
  normalizeWorkflow,
  parseWorkflowYaml,
  validateJsonValue,
  type JsonSchema,
} from "./index.js";

const schemaRef = "./output.json";

function workflowYaml(nodes: string): string {
  return `
apiVersion: anastom.dev/v1alpha1
kind: Workflow
metadata:
  id: test/workflow
  version: 0.1.0
inputs: {}
nodes:
${nodes}
`;
}

describe("Workflow IR", () => {
  it("loads, validates, and normalizes the demo workflow", async () => {
    const workflow = await loadWorkflow(resolve("examples/workflows/demo-feature.yaml"));

    expect(workflow.metadata).toEqual({ id: "demo/feature", version: "0.1.0" });
    expect(workflow.nodeOrder).toEqual(["analyze", "implement", "verify"]);
    expect(workflow.nodes.implement?.needs).toEqual(["analyze"]);
    expect(workflow.nodes.analyze?.attemptBudget).toEqual({ maxAttempts: 2, maxDurationMs: 60_000 });
    expect(workflow.nodes.verify?.output.schema).toMatchObject({ type: "object" });
  });

  it("supports exactly the four M0 node kinds", async () => {
    const document = parseWorkflowYaml(
      workflowYaml(`
  agent_node:
    kind: agent
    role: worker
    output: { schema: ${schemaRef} }
  command_node:
    kind: command
    needs: [agent_node]
    output: { schema: ${schemaRef} }
  gate_node:
    kind: gate
    needs: [command_node]
    output: { schema: ${schemaRef} }
  verifier_node:
    kind: verifier
    needs: [gate_node]
    output: { schema: ${schemaRef} }
`),
    );
    const schema: JsonSchema = { type: "object" };
    const workflow = await normalizeWorkflow(document, {
      sourcePath: "/tmp/workflow.yaml",
      loadSchema: async () => schema,
    });

    expect(workflow.nodeOrder.map((id) => workflow.nodes[id]?.kind)).toEqual([
      "agent",
      "command",
      "gate",
      "verifier",
    ]);
    expect(workflow.nodes.agent_node?.role).toBe("worker");
    expect(workflow.nodes.command_node?.role).toBeUndefined();
  });

  it.each([
    [
      "missing agent role",
      `  work:\n    kind: agent\n    output: { schema: ${schemaRef} }`,
      "role is required",
    ],
    [
      "role on deterministic node",
      `  work:\n    kind: verifier\n    role: judge\n    output: { schema: ${schemaRef} }`,
      "role is only valid",
    ],
    [
      "unknown dependency",
      `  work:\n    kind: command\n    needs: [missing]\n    output: { schema: ${schemaRef} }`,
      "unknown node",
    ],
    [
      "dependency cycle",
      `  a:\n    kind: command\n    needs: [b]\n    output: { schema: ${schemaRef} }\n  b:\n    kind: gate\n    needs: [a]\n    output: { schema: ${schemaRef} }`,
      "dependency cycle",
    ],
  ])("rejects %s", (_name, nodes, expected) => {
    expect(() => parseWorkflowYaml(workflowYaml(nodes))).toThrowError(expected);
  });

  it("rejects unknown IR fields and unsupported node kinds", () => {
    const source = workflowYaml(`
  work:
    kind: fanout
    prompt: hidden state
    output: { schema: ${schemaRef} }
`);
    expect(() => parseWorkflowYaml(source)).toThrow(WorkflowValidationError);
  });

  it("rejects malformed referenced JSON Schemas during normalization", async () => {
    const document = parseWorkflowYaml(
      workflowYaml(`  work:\n    kind: command\n    output: { schema: ${schemaRef} }`),
    );
    await expect(
      normalizeWorkflow(document, {
        sourcePath: "/tmp/workflow.yaml",
        loadSchema: async () => ({ type: "not-a-json-schema-type" }),
      }),
    ).rejects.toThrow("invalid JSON Schema");
  });

  it("validates structured values without throwing at the execution boundary", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "integer" } },
    };
    expect(validateJsonValue(schema, { value: 1 })).toEqual({ valid: true, errors: [] });
    expect(validateJsonValue(schema, { value: "one" })).toMatchObject({ valid: false });
  });
});
