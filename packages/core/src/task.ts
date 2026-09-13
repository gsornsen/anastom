import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { parse } from "yaml";
import type { AttemptPolicyDocument, CommandDocument, WorkflowDefinition } from "./types.js";
import { normalizeWorkflow, parseWorkflowYaml, WorkflowValidationError } from "./workflow.js";
import workerReport from "../schemas/worker-report.v1alpha1.json" with { type: "json" };
import commandResult from "../schemas/command-result.v1alpha1.json" with { type: "json" };

export const workerReportSchema = workerReport;
export const commandResultSchema = commandResult;
const workerSchemaPath = fileURLToPath(new URL("../schemas/worker-report.v1alpha1.json", import.meta.url));
const commandSchemaPath = fileURLToPath(new URL("../schemas/command-result.v1alpha1.json", import.meta.url));

export interface TaskDocument {
  apiVersion: "anastom.dev/v1alpha1"; kind: "Task";
  metadata: { id: string; version: string }; role: string;
  workspace: { mutation: "readonly" | "isolated" };
  acceptanceCriteria: string[]; verification: CommandDocument; attemptPolicy?: AttemptPolicyDocument;
  objective: string;
}
const duration = { type: "string", pattern: "^[1-9][0-9]*(?:ms|s|m|h)$" };
const validate = new Ajv({ allErrors: true }).compile({
  type: "object", additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "role", "workspace", "acceptanceCriteria", "verification"],
  properties: {
    apiVersion: { const: "anastom.dev/v1alpha1" }, kind: { const: "Task" },
    metadata: { type: "object", additionalProperties: false, required: ["id", "version"], properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9/._-]*$" }, version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$" } } },
    role: { type: "string", minLength: 1 },
    workspace: { type: "object", additionalProperties: false, required: ["mutation"], properties: { mutation: { enum: ["readonly", "isolated"] } } },
    acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    verification: { type: "object", additionalProperties: false, required: ["argv", "maxDuration"], properties: {
      argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, cwd: { type: "string" }, maxDuration: duration,
      maxOutputBytes: { type: "integer", minimum: 1, maximum: 16777216 },
    } },
    attemptPolicy: { type: "object", additionalProperties: false, properties: { maxAttempts: { type: "integer", minimum: 1 }, maxDuration: duration } },
  },
});
export function parseTaskMarkdown(source: string): TaskDocument {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!match) throw new WorkflowValidationError(["Task requires YAML front matter and a Markdown objective"]);
  let candidate: unknown;
  try { candidate = parse(match[1] as string); } catch { throw new WorkflowValidationError(["Invalid task YAML front matter"]); }
  if (!validate(candidate)) throw new WorkflowValidationError((validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}${e.keyword === "additionalProperties" ? " (" + String(e.params.additionalProperty) + ")" : ""}`));
  const objective = (match[2] as string).trim();
  if (!objective) throw new WorkflowValidationError(["Task objective must not be empty"]);
  return { ...candidate as Omit<TaskDocument, "objective">, objective };
}
export async function compileTask(task: TaskDocument, sourcePath: string): Promise<WorkflowDefinition> {
  const document = parseWorkflowYaml(JSON.stringify({
    apiVersion: task.apiVersion, kind: "Workflow", metadata: task.metadata, inputs: {},
    nodes: {
      implement: { kind: "agent", role: task.role, mutation: task.workspace.mutation, output: { schema: workerSchemaPath }, attemptPolicy: { maxAttempts: 1, maxDuration: "10m", ...task.attemptPolicy } },
      verify: { kind: "command", needs: ["implement"], command: task.verification, output: { schema: commandSchemaPath } },
    },
  }));
  // Built-in schemas are resolved without network or filesystem lookup.
  const definition = await normalizeWorkflow(document, {
    sourcePath: resolve(sourcePath),
    loadSchema: async (path) => {
      if (path === workerSchemaPath) return structuredClone(workerReportSchema);
      if (path === commandSchemaPath) return structuredClone(commandResultSchema);
      throw new Error("Unknown built-in task schema");
    },
  });
  return { ...definition, task: { objective: task.objective, acceptanceCriteria: [...task.acceptanceCriteria] } };
}
export async function loadTask(file: string): Promise<WorkflowDefinition> {
  return compileTask(parseTaskMarkdown(await readFile(file, "utf8")), file);
}
