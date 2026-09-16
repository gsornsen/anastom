import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  WorkflowValidationError,
  loadWorkflow,
  loadWorkflowWithinRoot,
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
    expect(workflow.nodes.analyze?.attemptBudget).toEqual({
      maxAttempts: 2,
      maxDurationMs: 60_000,
    });
    expect(workflow.nodes.verify?.output.schema).toMatchObject({ type: "object" });
  });

  it("scopes a CLI workflow and its schema reads to one source tree", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "anastom-scoped-workflow-"));
    const root = join(fixture, "root");
    const workflows = join(root, "workflows");
    const schemas = join(root, "schemas");
    const source = join(workflows, "workflow.yaml");
    const outside = join(fixture, "outside.json");
    try {
      await Promise.all([
        mkdir(workflows, { recursive: true }),
        mkdir(schemas, { recursive: true }),
      ]);
      await writeFile(join(schemas, "inside.json"), '{"type":"object"}');
      await writeFile(outside, '{"type":"object"}');
      const authored = (schema: string) =>
        workflowYaml(`  work:\n    kind: command\n    output: { schema: ${schema} }`);
      await writeFile(source, authored("../schemas/inside.json"));
      await expect(loadWorkflowWithinRoot(root, source)).resolves.toMatchObject({
        nodes: { work: { output: { schema: { type: "object" } } } },
      });
      await writeFile(source, authored("../../outside.json"));
      await expect(loadWorkflowWithinRoot(root, source)).rejects.toMatchObject({
        reason: "outside-root",
      });
      await symlink(outside, join(schemas, "escape.json"));
      await writeFile(source, authored("../schemas/escape.json"));
      await expect(loadWorkflowWithinRoot(root, source)).rejects.toMatchObject({
        reason: "outside-root",
      });
      await expect(loadWorkflowWithinRoot(root, outside)).rejects.toMatchObject({
        reason: "outside-root",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("supports exactly the four authored node kinds", async () => {
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
