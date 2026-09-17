import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { canonicalExistingRoot, resolveExistingChild } from "@anastom/path-policy";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import taskDocumentSchema from "../schemas/task-document.v1alpha1.json" with { type: "json" };
import { parse } from "yaml";
import type { AttemptPolicyDocument, CommandDocument, WorkflowDefinition } from "./types.js";
import { normalizeWorkflow, parseWorkflowYaml, WorkflowValidationError } from "./workflow.js";
import workerReport from "../schemas/worker-report.v1alpha1.json" with { type: "json" };
import commandResult from "../schemas/command-result.v1alpha1.json" with { type: "json" };

/**
 * Built-in report schema: descriptive summary, declared changed files, and notes.
 * @public
 */
export const workerReportSchema = workerReport;
/** Built-in verifier output schema with exit status and output accounting. @public */
export const commandResultSchema = commandResult;
const workerSchemaPath = fileURLToPath(
  new URL("../schemas/worker-report.v1alpha1.json", import.meta.url),
);
const commandSchemaPath = fileURLToPath(
  new URL("../schemas/command-result.v1alpha1.json", import.meta.url),
);

/**
 * Validated Task front matter and its nonempty Markdown objective.
 * @public
 */
export interface TaskDocument {
  apiVersion: "anastom.dev/v1alpha1";
  kind: "Task";
  metadata: { id: string; version: string };
  role: string;
  workspace: { mutation: "readonly" | "isolated" };
  acceptanceCriteria: string[];
  verification: CommandDocument;
  attemptPolicy?: AttemptPolicyDocument;
  objective: string;
}
const validate = new Ajv({ allErrors: true }).compile<Omit<TaskDocument, "objective">>(
  taskDocumentSchema,
);
/**
 * Parse strict YAML front matter and preserve the remaining Markdown as the objective.
 * @remarks Delimiters are scanned linearly; BOM and CRLF input are supported.
 * @throws If front matter, field ownership, or the objective is invalid.
 * @public
 */
export function parseTaskMarkdown(source: string): TaskDocument {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const openingEnd = text.indexOf("\n");
  if (openingEnd < 0 || text.slice(0, openingEnd).replace(/\r$/, "") !== "---") {
    throw new WorkflowValidationError(["Task requires YAML front matter and a Markdown objective"]);
  }
  let closingStart = -1,
    closingEnd = -1;
  for (let cursor = openingEnd + 1; cursor < text.length;) {
    const end = text.indexOf("\n", cursor);
    if (end < 0) {
      break;
    }
    if (text.slice(cursor, end).replace(/\r$/, "") === "---") {
      closingStart = cursor;
      closingEnd = end;
      break;
    }
    cursor = end + 1;
  }
  if (closingStart < 0) {
    throw new WorkflowValidationError(["Task requires YAML front matter and a Markdown objective"]);
  }
  let candidate: unknown;
  try {
    candidate = parse(text.slice(openingEnd + 1, closingStart));
  } catch {
    throw new WorkflowValidationError(["Invalid task YAML front matter"]);
  }
  if (!validate(candidate)) {
    throw new WorkflowValidationError(
      (validate.errors ?? []).map(
        (e) =>
          `${e.instancePath || "/"} ${e.message}${e.keyword === "additionalProperties" ? " (" + String(e.params.additionalProperty) + ")" : ""}`,
      ),
    );
  }
  const objective = text.slice(closingEnd + 1).trim();
  if (!objective) {
    throw new WorkflowValidationError(["Task objective must not be empty"]);
  }
  return { ...candidate, objective };
}
/**
 * Compile one Task into an implement agent followed by an independent command verifier.
 * @remarks Built-in schemas are cloned locally; the default worker budget is one attempt and ten minutes.
 * @public
 */
export async function compileTask(
  task: TaskDocument,
  sourcePath: string,
): Promise<WorkflowDefinition> {
  const document = parseWorkflowYaml(
    JSON.stringify({
      apiVersion: task.apiVersion,
      kind: "Workflow",
      metadata: task.metadata,
      inputs: {},
      nodes: {
        implement: {
          kind: "agent",
          role: task.role,
          mutation: task.workspace.mutation,
          output: { schema: workerSchemaPath },
          attemptPolicy: { maxAttempts: 1, maxDuration: "10m", ...task.attemptPolicy },
        },
        verify: {
          kind: "command",
          needs: ["implement"],
          command: task.verification,
          output: { schema: commandSchemaPath },
        },
      },
    }),
  );
  // Built-in schemas are resolved without network or filesystem lookup.
  const definition = await normalizeWorkflow(document, {
    sourcePath: resolve(sourcePath),
    loadSchema: async (path) => {
      if (path === workerSchemaPath) {
        return structuredClone(workerReportSchema);
      }
      if (path === commandSchemaPath) {
        return structuredClone(commandResultSchema);
      }
      throw new Error("Unknown built-in task schema");
    },
  });
  return {
    ...definition,
    task: { objective: task.objective, acceptanceCriteria: [...task.acceptanceCriteria] },
  };
}
/**
 * Load an operator-selected local Task file and compile its normalized definition.
 * @remarks This local CLI API reads with caller permissions. Remote hosts must authorize filenames before calling it.
 * @throws WorkflowValidationError for unreadable or invalid tasks.
 */
async function readTaskSource(absolutePath: string): Promise<string> {
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new WorkflowValidationError([
      "Cannot load task " +
        absolutePath +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    ]);
  }
  return source;
}

/**
 * Load a trusted operator-selected local Task file.
 * @public
 */
export async function loadTask(file: string): Promise<WorkflowDefinition> {
  const absolutePath = resolve(file);
  return compileTask(parseTaskMarkdown(await readTaskSource(absolutePath)), absolutePath);
}

/** Scope a CLI-selected Task read to one caller-authorized source tree. */
export async function loadTaskWithinRoot(
  rootPath: string,
  filePath: string,
): Promise<WorkflowDefinition> {
  const root = await canonicalExistingRoot(rootPath);
  const selected = relative(resolve(rootPath), resolve(rootPath, filePath));
  const sourcePath = await resolveExistingChild(root, selected, "file");
  return compileTask(parseTaskMarkdown(await readTaskSource(sourcePath)), sourcePath);
}
