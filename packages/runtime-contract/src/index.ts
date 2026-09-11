import type { AttemptBudget, JsonSchema, JsonValue, NodeKind } from "@anastom/core";

export interface RuntimeCapabilities {
  streaming: boolean;
  cancellation: boolean;
  resumableSession: boolean;
  nativeSubagents: boolean;
  mcp: boolean;
  lsp: boolean;
  debugger: boolean;
  browser: boolean;
  structuredOutput: "native" | "prompted" | "none";
  usageReporting: "tokens" | "cost" | "partial" | "none";
  sandboxing: string[];
}

export interface ResolvedRole {
  id: string;
}

export interface WorkspaceRef {
  id: string;
  mode: "memory";
}

export interface ContextEnvelope {
  inputs: Readonly<Record<string, JsonValue>>;
  dependencyOutputs: Readonly<Record<string, JsonValue>>;
}

export interface ToolPolicy {
  allowMutations: boolean;
}

export interface ExecutionRequest {
  runId: string;
  workflowInstanceId: string;
  nodeId: string;
  nodeKind: NodeKind;
  attempt: number;
  role?: ResolvedRole;
  workspace: WorkspaceRef;
  context: ContextEnvelope;
  budget: AttemptBudget;
  requiredOutputSchema: JsonSchema;
  toolPolicy: ToolPolicy;
}

export interface ExecutionHandle {
  id: string;
}

export type RuntimeEvent =
  | { type: "started" }
  | { type: "log"; message: string }
  | { type: "completed"; status: ExecutionResult["status"] };

export const FAILURE_CATEGORIES = [
  "runtime-unavailable",
  "model-provider",
  "tool",
  "schema-violation",
  "verification",
  "budget-exhausted",
  "policy-violation",
  "workspace-conflict",
  "human-rejection",
  "unknown-internal",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface ExecutionFailure {
  category: FailureCategory;
  message: string;
}

export type ExecutionResult =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; failure: ExecutionFailure }
  | { status: "blocked"; reason: string }
  | { status: "cancelled"; reason: string };

export interface PersistedExecutionRef {
  adapterId: string;
  handleId: string;
}

export interface RecoveredExecution {
  handle: ExecutionHandle;
}

export interface RuntimeAdapter {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent>;
  collect(handle: ExecutionHandle): Promise<ExecutionResult>;
  cancel(handle: ExecutionHandle): Promise<void>;
  recover?(persisted: PersistedExecutionRef): Promise<RecoveredExecution | null>;
}
