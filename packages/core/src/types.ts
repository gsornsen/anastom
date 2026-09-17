import type { FeatureDefinition } from "./feature.js";
import type { SdlcMethodologySnapshot } from "./methodology.js";

/**
 * A scalar representable in JSON; non-finite numbers are rejected during canonicalization.
 */
type JsonPrimitive = boolean | null | number | string;
/**
 * A JSON value accepted at workflow boundaries; arbitrary JavaScript objects are excluded.
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/**
 * A local JSON Schema document compiled by AJV before structured values are trusted.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * A workflow node's execution category, independent of its chosen runtime or model.
 */
export type NodeKind = "agent" | "command" | "gate" | "verifier" | "integration";

/**
 * The durable lifecycle state of one workflow node.
 */
export type NodeStatus =
  "pending" | "ready" | "running" | "blocked" | "succeeded" | "failed" | "paused" | "cancelled";

/**
 * An authored schema filename resolved relative to the workflow file.
 */
interface SchemaReferenceDocument {
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
interface WorkflowNodeDocument {
  kind: Exclude<NodeKind, "integration">;
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
    maxParallel?: number;
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
interface ResolvedSchemaReference {
  ref: string;
  schema: JsonSchema;
}

/**
 * A named, resolved input schema retained in the immutable workflow definition.
 */
interface WorkflowInputDefinition extends ResolvedSchemaReference {
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
  /** Exact methodology instructions persisted before execution. */
  instructions?: string;
  /** Digest of the exact methodology instructions. */
  instructionsDigest?: string;
  /** Planner task bound to an implementation node. */
  taskId?: string;
  /** Accepted patch identity produced by a mutating generated node. */
  patchId?: string;
  /** Repository-relative paths this node may modify. */
  mutationScopes?: readonly string[];
  /** Trusted controller operation; model runtimes never receive authority to perform it. */
  controller?: {
    operation: "integrate-patches";
    wave: number;
    taskIds: readonly string[];
  };
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
    maxParallel: number;
  };
  nodeOrder: readonly string[];
  nodes: Readonly<Record<string, WorkflowNode>>;
  task?: { objective: string; acceptanceCriteria: readonly string[] };
  /** Immutable Feature and methodology inputs for a planner-expanded run. */
  definedSdlc?: {
    feature: FeatureDefinition;
    methodology: SdlcMethodologySnapshot;
    analysisNodeId: string;
    planningNodeId: string;
    protectedPaths: readonly string[];
  };
}

/**
 * Structured validation outcome returned instead of throwing at the execution boundary.
 */
export interface ValidationResult {
  valid: boolean;
  errors: readonly string[];
}
