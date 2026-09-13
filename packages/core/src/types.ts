export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export const NODE_KINDS = ["agent", "command", "gate", "verifier"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

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
export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface SchemaReferenceDocument {
  schema: string;
}

export interface AttemptPolicyDocument {
  maxAttempts?: number;
  maxDuration?: string;
}

export interface WorkflowNodeDocument {
  kind: NodeKind;
  needs?: string[];
  role?: string;
  output: SchemaReferenceDocument;
  attemptPolicy?: AttemptPolicyDocument;
  mutation?: "readonly" | "isolated";
  command?: CommandDocument;
}

export interface CommandDocument {
  argv: string[];
  cwd?: string;
  maxDuration: string;
  maxOutputBytes?: number;
}

export interface CommandDefinition {
  argv: readonly string[];
  cwd: string;
  maxDurationMs: number;
  maxOutputBytes: number;
}

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

export interface AttemptBudget {
  maxAttempts: number;
  maxDurationMs?: number;
}

export interface ResolvedSchemaReference {
  ref: string;
  schema: JsonSchema;
}

export interface WorkflowInputDefinition extends ResolvedSchemaReference {
  id: string;
}

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

export interface ValidationResult {
  valid: boolean;
  errors: readonly string[];
}
