import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";
import workflowDocumentSchema from "../schemas/workflow-document.v1alpha1.json" with { type: "json" };

import {
  type AttemptBudget,
  type AttemptPolicyDocument,
  type JsonSchema,
  type JsonValue,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowNode,
} from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });

const validateWorkflowDocument = ajv.compile<WorkflowDocument>(workflowDocumentSchema);

/** Invalid authored workflow or task, with actionable field and graph diagnostics. */
export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

  /**
   * Collect actionable validation issues into a single operator-readable error.
   */
  constructor(issues: readonly string[]) {
    super(`Invalid workflow:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath.length > 0 ? error.instancePath : "/";
    return `${location} ${error.message ?? "is invalid"}`;
  });
}

function assertSemanticValidity(document: WorkflowDocument): void {
  const issues: string[] = [];
  const nodeIds = Object.keys(document.nodes);

  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.kind === "agent" && node.role === undefined) {
      issues.push(`/nodes/${nodeId}/role is required for agent nodes`);
    }
    if (node.kind !== "agent" && node.role !== undefined) {
      issues.push(`/nodes/${nodeId}/role is only valid for agent nodes`);
    }
    if (node.mutation !== undefined && node.kind !== "agent") {
      issues.push(`/nodes/${nodeId}/mutation is only valid for agent nodes`);
    }
    if (node.command !== undefined && node.kind !== "command") {
      issues.push(`/nodes/${nodeId}/command is only valid for command nodes`);
    }
    if (
      node.command?.cwd !== undefined &&
      (isAbsolute(node.command.cwd) || node.command.cwd.split(/[\\/]/).includes(".."))
    ) {
      issues.push(`/nodes/${nodeId}/command/cwd must stay within the workspace`);
    }
    for (const dependency of node.needs ?? []) {
      if (!Object.hasOwn(document.nodes, dependency)) {
        issues.push(`/nodes/${nodeId}/needs references unknown node ${JSON.stringify(dependency)}`);
      }
      if (dependency === nodeId) {
        issues.push(`/nodes/${nodeId}/needs cannot reference itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string, path: string[]): void => {
    if (visiting.has(nodeId)) {
      const start = path.indexOf(nodeId);
      issues.push(`dependency cycle: ${[...path.slice(start), nodeId].join(" -> ")}`);
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }
    visiting.add(nodeId);
    for (const dependency of document.nodes[nodeId]?.needs ?? []) {
      if (Object.hasOwn(document.nodes, dependency)) {
        visit(dependency, [...path, nodeId]);
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) {
    visit(nodeId, []);
  }

  if (issues.length > 0) {
    throw new WorkflowValidationError([...new Set(issues)]);
  }
}

/**
 * Parse strict Workflow YAML and validate field ownership, dependencies, and acyclicity.
 */
export function parseWorkflowYaml(source: string): WorkflowDocument {
  let candidate: unknown;
  try {
    candidate = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError([`YAML parse error: ${message}`]);
  }

  if (!validateWorkflowDocument(candidate)) {
    throw new WorkflowValidationError(formatAjvErrors(validateWorkflowDocument.errors));
  }

  const document = candidate;
  assertSemanticValidity(document);
  return document;
}

/**
 * Convert a supported ms/s/m/h duration to milliseconds within the platform timer range.
 * @throws WorkflowValidationError for invalid or overflowing durations.
 */
export function durationToMilliseconds(duration: string | undefined): number | undefined {
  if (duration === undefined) {
    return undefined;
  }
  const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
  if (match === null) {
    throw new WorkflowValidationError([`invalid duration ${JSON.stringify(duration)}`]);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const multiplier = multipliers[unit ?? ""]!;
  const milliseconds = value * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new WorkflowValidationError(["duration exceeds supported timer range"]);
  }
  return milliseconds;
}

function normalizeBudget(
  policy: AttemptPolicyDocument | undefined,
  fallback?: AttemptBudget,
): AttemptBudget {
  const budget: AttemptBudget = { maxAttempts: policy?.maxAttempts ?? fallback?.maxAttempts ?? 1 };
  const duration = policy?.maxDuration;
  const maxDurationMs =
    duration === undefined ? fallback?.maxDurationMs : durationToMilliseconds(duration);
  if (maxDurationMs !== undefined) {
    budget.maxDurationMs = maxDurationMs;
  }
  return budget;
}

/**
 * Load a schema from an absolute local filename; injected loaders support deterministic tests.
 */
export type SchemaLoader = (absolutePath: string) => Promise<JsonSchema>;

async function defaultSchemaLoader(absolutePath: string): Promise<JsonSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError([`cannot load schema ${absolutePath}: ${message}`]);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new WorkflowValidationError([`schema ${absolutePath} must contain a JSON object`]);
  }
  try {
    ajv.compile(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError([`invalid JSON Schema ${absolutePath}: ${message}`]);
  }
  return parsed as JsonSchema;
}

function resolveSchemaPath(sourcePath: string, schemaRef: string): string {
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(schemaRef)) {
    throw new WorkflowValidationError([`remote schema references are unsupported: ${schemaRef}`]);
  }
  return isAbsolute(schemaRef) ? schemaRef : resolve(dirname(sourcePath), schemaRef);
}

/**
 * Resolve local schemas and independent budget defaults into a replayable workflow snapshot.
 * @throws WorkflowValidationError if a referenced schema cannot be loaded or compiled.
 */
export async function normalizeWorkflow(
  document: WorkflowDocument,
  options: { sourcePath: string; loadSchema?: SchemaLoader },
): Promise<WorkflowDefinition> {
  const sourcePath = resolve(options.sourcePath);
  const loadSchema = options.loadSchema ?? defaultSchemaLoader;
  const defaultAttemptBudget = normalizeBudget(document.policies?.defaultAttemptBudget);
  const schemaCache = new Map<string, JsonSchema>();
  const load = async (ref: string): Promise<JsonSchema> => {
    const path = resolveSchemaPath(sourcePath, ref);
    const cached = schemaCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const schema = await loadSchema(path);
    try {
      ajv.compile(schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowValidationError([`invalid JSON Schema ${path}: ${message}`]);
    }
    schemaCache.set(path, schema);
    return schema;
  };

  const inputEntries = await Promise.all(
    Object.entries(document.inputs).map(
      async ([id, input]) =>
        [id, { id, ref: input.schema, schema: await load(input.schema) }] as const,
    ),
  );
  const nodeEntries = await Promise.all(
    Object.entries(document.nodes).map(async ([id, node]) => {
      const normalized: WorkflowNode = {
        id,
        kind: node.kind,
        needs: [...(node.needs ?? [])],
        ...(node.role === undefined ? {} : { role: node.role }),
        output: { ref: node.output.schema, schema: await load(node.output.schema) },
        attemptBudget: normalizeBudget(node.attemptPolicy, defaultAttemptBudget),
        ...(node.mutation === undefined ? {} : { mutation: node.mutation }),
        ...(node.command === undefined
          ? {}
          : {
              command: {
                argv: [...node.command.argv],
                cwd: node.command.cwd ?? ".",
                maxDurationMs: durationToMilliseconds(node.command.maxDuration) as number,
                maxOutputBytes: node.command.maxOutputBytes ?? 1_048_576,
              },
            }),
      };
      return [id, normalized] as const;
    }),
  );

  return {
    apiVersion: document.apiVersion,
    kind: document.kind,
    metadata: { ...document.metadata },
    sourcePath,
    inputs: Object.fromEntries(inputEntries),
    policies: { defaultAttemptBudget },
    nodeOrder: Object.keys(document.nodes),
    nodes: Object.fromEntries(nodeEntries),
  };
}

/**
 * Load an operator-selected local Workflow file and resolve schemas relative to that file.
 * @remarks Remote callers must authorize the workflow and schema filenames before using this local-file API.
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const absolutePath = resolve(filePath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError([`cannot load workflow ${absolutePath}: ${message}`]);
  }
  return normalizeWorkflow(parseWorkflowYaml(source), { sourcePath: absolutePath });
}

/**
 * Validate a structured value against its output schema and return actionable validation errors.
 */
export function validateJsonValue(schema: JsonSchema, value: JsonValue): ValidationResult {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, errors: [`invalid JSON Schema: ${message}`] };
  }
  const valid = validate(value);
  return { valid, errors: valid ? [] : formatAjvErrors(validate.errors) };
}
