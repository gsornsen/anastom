import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  digestJson,
  loadTask,
  parseTaskMarkdown,
  compileTask,
  assertWorkflowDefinition,
  parseWorkflowYaml,
  normalizeWorkflow,
  validateJsonValue,
  workerReportSchema,
} from "./index.js";
import { healthEndpointTaskPath } from "../../engine/src/testing/fixture.js";

describe("Markdown task descriptor", () => {
  it("strictly compiles objective, policy, schemas, and stable node IDs", async () => {
    const workflow = await loadTask(healthEndpointTaskPath);
    expect(workflow.nodeOrder).toEqual(["implement", "verify"]);
    expect(workflow.task?.objective).toContain("Change only server.mjs");
    expect(workflow.nodes.implement?.mutation).toBe("isolated");
    expect(workflow.nodes.implement?.attemptBudget.maxDurationMs).toBe(300000);
    expect(workflow.nodes.verify?.command?.argv).toEqual(["node", "--test", "server.test.mjs"]);
    expect(() => assertWorkflowDefinition(workflow)).not.toThrow();
  });
  it("rejects unknown fields, missing objective, unsupported modes, and shell strings", async () => {
    const source = await readFile(healthEndpointTaskPath, "utf8");
    expect(() =>
      parseTaskMarkdown(source.replace("kind: Task", "kind: Task\nsecret: ignored")),
    ).toThrow("secret");
    expect(() => parseTaskMarkdown(source.split("\n# Add")[0] + "\n")).toThrow("objective");
    expect(() =>
      parseTaskMarkdown(source.replace("mutation: isolated", "mutation: shared-integration")),
    ).toThrow();
    expect(() =>
      parseTaskMarkdown(
        source.replace("argv: [node, --test, server.test.mjs]", "argv: node --test"),
      ),
    ).toThrow();
    await expect(
      compileTask(
        parseTaskMarkdown(
          source.replace("maxDuration: 30s", "maxDuration: 30s\n  cwd: ../outside"),
        ),
        healthEndpointTaskPath,
      ),
    ).rejects.toThrow("workspace");
    await expect(
      compileTask(
        parseTaskMarkdown(source.replace("maxDuration: 5m", "maxDuration: 999999999999h")),
        healthEndpointTaskPath,
      ),
    ).rejects.toThrow("timer range");
  });
  it("rejects invalid normalized graph and embedded schemas on reload", async () => {
    const workflow = await loadTask(healthEndpointTaskPath);
    const copy = structuredClone(workflow);
    copy.nodes.implement!.output.schema = { type: "impossible-type" };
    expect(() => assertWorkflowDefinition(copy)).toThrow();
    copy.nodes.implement!.output.schema = { type: "object" };
    copy.nodes.implement!.needs = ["verify"];
    expect(() => assertWorkflowDefinition(copy)).toThrow("cycle");
    expect(() => assertWorkflowDefinition({ ...workflow, surprise: true })).toThrow("Corrupt");
    expect(() =>
      assertWorkflowDefinition({ ...workflow, nodeOrder: ["constructor", "verify"] }),
    ).toThrow("node order");
  });
  it("applies worker policy defaults independently and owns its schema copies", async () => {
    const source = await readFile(healthEndpointTaskPath, "utf8");
    const partial = source.replace("  maxDuration: 5m\n", "");
    const first = await compileTask(parseTaskMarkdown(partial), healthEndpointTaskPath);
    const second = await compileTask(parseTaskMarkdown(partial), healthEndpointTaskPath);
    expect(first.nodes.implement?.attemptBudget).toEqual({ maxAttempts: 1, maxDurationMs: 600000 });
    first.nodes.implement!.output.schema.type = "string";
    expect(second.nodes.implement?.output.schema.type).toBe("object");
  });
  it("scans front matter once and preserves BOM/CRLF and Markdown delimiters", async () => {
    const source = await readFile(healthEndpointTaskPath, "utf8");
    expect(parseTaskMarkdown("\uFEFF" + source.replace(/\n/g, "\r\n")).objective).toContain(
      "Change only server.mjs",
    );
    const body = source + "\n---\na".repeat(10000);
    expect(parseTaskMarkdown(body).objective.endsWith("\n---\na")).toBe(true);
    expect(() => parseTaskMarkdown("---\n" + "invalid-frontmatter\n".repeat(10000))).toThrow(
      "front matter",
    );
  });
  it("preserves workflow syntax while enforcing execution field ownership", async () => {
    const base =
      "apiVersion: anastom.dev/v1alpha1\nkind: Workflow\nmetadata: {id: test/task-compile, version: 0.1.0}\ninputs: {}\nnodes:\n  work: {kind: command, output: {schema: out.json}}";
    expect(parseWorkflowYaml(base).nodes.work?.command).toBeUndefined();
    expect(() =>
      parseWorkflowYaml(base.replace("kind: command", "kind: command, needs: [constructor]")),
    ).toThrow("unknown node");
    expect(() =>
      parseWorkflowYaml(base.replace("kind: command", "kind: command, mutation: isolated")),
    ).toThrow("agent");
    expect(() =>
      parseWorkflowYaml(
        base.replace(
          "kind: command",
          "kind: agent, role: worker, command: {argv: [echo], maxDuration: 1s}",
        ),
      ),
    ).toThrow("command nodes");
    const doc = parseWorkflowYaml(
      base.replace(
        "kind: command",
        "kind: command, command: {argv: [echo, '$HOME'], maxDuration: 1s}",
      ),
    );
    const workflow = await normalizeWorkflow(doc, {
      sourcePath: "/tmp/workflow.yaml",
      loadSchema: async () => ({ type: "object" }),
    });
    expect(workflow.nodes.work?.command?.argv[1]).toBe("$HOME");
  });
});

describe("Worker report summary", () => {
  it.each(["", " ", "brief", " ".repeat(60), "x" + " ".repeat(60), "a".repeat(29)])(
    "rejects blank, padded, or short summaries: %j",
    (summary) => {
      expect(
        validateJsonValue(workerReportSchema, { summary, changedFiles: [], notes: [] }).valid,
      ).toBe(false);
    },
  );

  it("accepts a descriptive summary and the exact non-whitespace boundary", () => {
    for (const summary of [
      "a".repeat(30),
      "Added GET /health while preserving unmatched route behavior.",
    ]) {
      expect(
        validateJsonValue(workerReportSchema, { summary, changedFiles: ["server.mjs"], notes: [] })
          .valid,
      ).toBe(true);
    }
  });
});
describe("canonical run identity", () => {
  it("ignores map insertion order and rejects non-JSON data", () => {
    expect(digestJson({ b: [2], a: 1 })).toBe(digestJson({ a: 1, b: [2] }));
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
  });
});
