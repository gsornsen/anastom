import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";

import {
  NODE_KINDS,
  type AttemptBudget,
  type AttemptPolicyDocument,
  type JsonSchema,
  type JsonValue,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowNode,
} from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });

const workflowDocumentSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "inputs", "nodes"],
  properties: {
    apiVersion: { const: "anastom.dev/v1alpha1" },
    kind: { const: "Workflow" },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9/._-]*$" },
        version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$" },
      },
    },
    inputs: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/schemaReference" },
    },
    policies: {
      type: "object",
      additionalProperties: false,
      properties: {
        defaultAttemptBudget: { $ref: "#/$defs/attemptPolicy" },
      },
    },
    nodes: {
      type: "object",
      minProperties: 1,
      propertyNames: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
      additionalProperties: { $ref: "#/$defs/node" },
    },
  },
  $defs: {
    schemaReference: {
      type: "object",
      additionalProperties: false,
      required: ["schema"],
      properties: { schema: { type: "string", minLength: 1 } },
    },
    attemptPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxAttempts: { type: "integer", minimum: 1 },
        maxDuration: { type: "string", pattern: "^[1-9][0-9]*(?:ms|s|m|h)$" },
      },
    },
    node: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "output"],
      properties: {
        kind: { enum: [...NODE_KINDS] },
        needs: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        role: { type: "string", minLength: 1 },
        output: { $ref: "#/$defs/schemaReference" },
        attemptPolicy: { $ref: "#/$defs/attemptPolicy" },
      },
    },
  },
};

const validateWorkflowDocument = ajv.compile(workflowDocumentSchema);

export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

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
    for (const dependency of node.needs ?? []) {
      if (!(dependency in document.nodes)) {
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
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of document.nodes[nodeId]?.needs ?? []) {
      if (dependency in document.nodes) visit(dependency, [...path, nodeId]);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) visit(nodeId, []);

  if (issues.length > 0) throw new WorkflowValidationError([...new Set(issues)]);
}

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

  const document = candidate as WorkflowDocument;
  assertSemanticValidity(document);
  return document;
}

function durationToMilliseconds(duration: string | undefined): number | undefined {
  if (duration === undefined) return undefined;
  const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
  if (match === null) throw new WorkflowValidationError([`invalid duration ${JSON.stringify(duration)}`]);
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return value * multiplier;
}

function normalizeBudget(policy: AttemptPolicyDocument | undefined, fallback?: AttemptBudget): AttemptBudget {
  return {
    maxAttempts: policy?.maxAttempts ?? fallback?.maxAttempts ?? 1,
    ...(policy?.maxDuration !== undefined
      ? { maxDurationMs: durationToMilliseconds(policy.maxDuration) }
      : fallback?.maxDurationMs !== undefined
        ? { maxDurationMs: fallback.maxDurationMs }
        : {}),
  };
}

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
    throw new WorkflowValidationError([`remote schema references are outside M0: ${schemaRef}`]);
  }
  return isAbsolute(schemaRef) ? schemaRef : resolve(dirname(sourcePath), schemaRef);
}

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
    if (cached !== undefined) return cached;
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
    Object.entries(document.inputs).map(async ([id, input]) => [
      id,
      { id, ref: input.schema, schema: await load(input.schema) },
    ] as const),
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
