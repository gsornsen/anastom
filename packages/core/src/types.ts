/**
 * A scalar representable in JSON; non-finite numbers are rejected during canonicalization.
 */
export type JsonPrimitive = boolean | null | number | string;
/**
 * A JSON value accepted at workflow boundaries; arbitrary JavaScript objects are excluded.
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/**
 * A local JSON Schema document compiled by AJV before structured values are trusted.
 */
export type JsonSchema = Record<string, unknown>;

/** Supported authored node execution categories. */
export const NODE_KINDS = ["agent", "command", "gate", "verifier"] as const;
/**
 * A workflow node's execution category, independent of its chosen runtime or model.
 */
export type NodeKind = (typeof NODE_KINDS)[number];

/** Supported durable node lifecycle states. */
export const NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "paused",
  "cancelled",
] as const;
/**
 * The durable lifecycle state of one workflow node.
 */
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * An authored schema filename resolved relative to the workflow file.
 */
export interface SchemaReferenceDocument {
  schema: string;
}

/**
 * Optional authored retry and time limits; normalization supplies independent defaults.
 */
export interface AttemptPolicyDocument {
  maxAttempts?: number;
  maxDuration?: string;
}

/**
 * An authored dependency-graph node before schemas and budgets are resolved.
 */
export interface WorkflowNodeDocument {
  kind: NodeKind;
  needs?: string[];
  role?: string;
  output: SchemaReferenceDocument;
  attemptPolicy?: AttemptPolicyDocument;
  mutation?: "readonly" | "isolated";
  command?: CommandDocument;
}

/**
 * An authored verifier command: exact argv, a workspace-relative cwd, and bounded execution.
 */
export interface CommandDocument {
  argv: string[];
  cwd?: string;
  maxDuration: string;
  maxOutputBytes?: number;
}

/**
 * A normalized verifier command ready for execution without a shell.
 */
export interface CommandDefinition {
  argv: readonly string[];
  cwd: string;
  maxDurationMs: number;
  maxOutputBytes: number;
}

/**
 * The strict authored Workflow IR, validated for field ownership and graph semantics.
 */
export interface WorkflowDocument {
  apiVersion: "anastom.dev/v1alpha1";
  kind: "Workflow";
  metadata: {
    id: string;
    version: string;
  };
  inputs: Record<string, SchemaReferenceDocument>;
  policies?: {
    defaultAttemptBudget?: AttemptPolicyDocument;
  };
  nodes: Record<string, WorkflowNodeDocument>;
}

/**
 * Normalized attempt count and optional deadline in milliseconds.
 */
export interface AttemptBudget {
  maxAttempts: number;
  maxDurationMs?: number;
}

/**
 * The original schema reference and its loaded JSON Schema snapshot.
 */
export interface ResolvedSchemaReference {
  ref: string;
  schema: JsonSchema;
}

/**
 * A named, resolved input schema retained in the immutable workflow definition.
 */
export interface WorkflowInputDefinition extends ResolvedSchemaReference {
  id: string;
}

/**
 * A normalized node containing resolved output schema, dependencies, and execution policy.
 */
export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  needs: readonly string[];
  role?: string;
  output: ResolvedSchemaReference;
  attemptBudget: AttemptBudget;
  mutation?: "readonly" | "isolated";
  command?: CommandDefinition;
}

/**
 * An immutable normalized workflow snapshot persisted with each run; includes schemas for replay.
 */
export interface WorkflowDefinition {
  apiVersion: "anastom.dev/v1alpha1";
  kind: "Workflow";
  metadata: {
    id: string;
    version: string;
  };
  sourcePath: string;
  inputs: Readonly<Record<string, WorkflowInputDefinition>>;
  policies: {
    defaultAttemptBudget: AttemptBudget;
  };
  nodeOrder: readonly string[];
  nodes: Readonly<Record<string, WorkflowNode>>;
  task?: { objective: string; acceptanceCriteria: readonly string[] };
}

/**
 * Structured validation outcome returned instead of throwing at the execution boundary.
 */
export interface ValidationResult {
  valid: boolean;
  errors: readonly string[];
}
