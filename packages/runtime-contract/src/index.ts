import type {
  AttemptBudget,
  CommandDefinition,
  JsonSchema,
  JsonValue,
  NodeKind,
} from "@anastom/core";

/**
 * Observable features supported by a runtime; orchestration policy must not depend on private SDK details.
 */
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
  /** Supported workspace modes; absence means unknown rather than unsupported. */
  workspaceModes?: WorkspaceRef["mode"][];
}

/**
 * A logical worker role independent of model selection.
 */
export interface ResolvedRole {
  id: string;
}

/**
 * A memory, source-readonly, or owned isolated Git workspace selected by the control plane.
 */
export type WorkspaceRef =
  | { id: string; mode: "memory" }
  | { id: string; mode: "readonly"; repoRoot: string; path: string; baseCommit: string }
  | {
      id: string;
      mode: "isolated";
      repoRoot: string;
      path: string;
      baseCommit: string;
      branch: string;
    };

/**
 * An immutable evidence location, media type, digest, and producer identity.
 */
export interface ArtifactRef {
  id: string;
  type: string;
  mediaType: string;
  uri: string;
  digest: string;
  producer: { runId: string; nodeId: string; attempt: number };
}

/**
 * Observed head, changed filenames, and binary-capable diff relative to the run's base commit.
 */
export interface WorkspaceCapture {
  headCommit: string;
  diff: string;
  changedFiles: string[];
}

/** Complete content and Git ownership evidence captured before execution authorization. */
export interface WorkspaceCheckpoint {
  version: "anastom.dev/workspace-checkpoint/v1alpha1";
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  diffDigest: string;
  changedFiles: string[];
  ignoredDigest: string;
  ignoredEntryCount: number;
  ignoredByteCount: number;
  ownership: {
    repositoryRoot: string;
    repositoryCommonDirectory: string;
    workspacePath: string;
    workspaceGitDirectory: string;
    branch: string;
    manifestDigest: string;
    registrationDigest: string;
  };
  diffArtifactId?: string;
}

/** Stable dimensions reported when two complete workspace captures do not match. */
export type WorkspaceDifference =
  | "version"
  | "workspace-id"
  | "base-commit"
  | "head-commit"
  | "diff-digest"
  | "changed-files"
  | "ignored-content"
  | "repository"
  | "workspace-path"
  | "branch"
  | "ownership-manifest"
  | "worktree-registration";

/**
 * Explicit per-attempt context snapshot; previous conversations and failed-attempt outputs are excluded.
 */
export interface ContextEnvelope {
  inputs: Readonly<Record<string, JsonValue>>;
  dependencyOutputs: Readonly<Record<string, JsonValue>>;
  version?: "anastom.dev/context/v1alpha1";
  runId?: string;
  workflowInstanceId?: string;
  nodeId?: string;
  attempt?: number;
  task?: { id: string; version: string; objective: string; acceptanceCriteria: readonly string[] };
  role?: ResolvedRole;
  workspace?: WorkspaceRef;
  allowedMutations?: "readonly" | "isolated";
  artifacts?: readonly ArtifactRef[];
  verification?: CommandDefinition;
  requiredOutputSchema?: JsonSchema;
  budget?: AttemptBudget;
}

/**
 * Mutations authorized by the control plane for this attempt.
 */
export interface ToolPolicy {
  allowMutations: boolean;
}

/**
 * A complete runtime invocation built from validated workflow state and an explicit context envelope.
 */
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

/**
 * An opaque runtime-owned execution identifier; it conveys identity rather than authorization.
 */
export interface ExecutionHandle {
  id: string;
}

/**
 * Public lifecycle, log, and identity observations; private reasoning and tool bodies are excluded.
 */
export type RuntimeEvent =
  | { type: "started" }
  | { type: "log"; message: string; droppedLogs?: number }
  | {
      type: "metadata";
      provider: string;
      model: string;
      source?: "configured" | "reported";
      runtimeVersion?: string;
    }
  | RuntimeUsage
  | { type: "completed"; status: ExecutionResult["status"] };

/**
 * One final attempt token observation. Unknown counters are absent; subsets must not be added twice.
 * Input/output include cache/reasoning subsets only where the adapter establishes those semantics.
 */
export interface RuntimeUsage {
  type: "usage";
  scope: "attempt";
  coverage: "complete" | "partial";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/** Validated selected-worker requirements and its immutable capability evidence. */
export interface RuntimeNegotiation {
  version: "anastom.dev/runtime-negotiation/v1alpha1";
  runtimeId: string;
  requirements: {
    workspaceMode: "readonly" | "isolated";
    cancellation: true;
    structuredOutput: "validated";
  };
  capabilities: RuntimeCapabilities;
}

/** A bounded, credential-free runtime selection that can reconstruct an adapter after restart. */
export interface RuntimeDescriptor {
  version: "anastom.dev/runtime-descriptor/v1alpha1";
  runtimeId: string;
  configurationVersion: string;
  configuration: Readonly<Record<string, JsonValue>>;
}

/** A runtime whose complete public selection can be persisted before execution begins. */
export interface DurableRuntimeAdapter extends RuntimeAdapter {
  /** Resolve the effective provider/model selection without starting a model request. */
  descriptor(): Promise<RuntimeDescriptor>;
}

/** Parse one runtime's exact descriptor and reconstruct only its public adapter configuration. */
export interface RuntimeDescriptorCodec<T extends RuntimeDescriptor = RuntimeDescriptor> {
  readonly runtimeId: T["runtimeId"];
  /** Validate the shared envelope and this runtime's exact public configuration. */
  parse(value: unknown): T;
  /** Revalidate and reconstruct an adapter using only the public selection. */
  create(descriptor: T): Promise<RuntimeAdapter>;
}

/** Stable failure categories shared by adapters, validation, and retry policy. */
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
/**
 * Stable failure classification used by runtime adapters and deterministic orchestration policy.
 */
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * A classified failure and operator-readable diagnostic.
 */
export interface ExecutionFailure {
  category: FailureCategory;
  message: string;
}

/**
 * A normalized terminal attempt result; succeeded outputs must still pass engine schema validation.
 */
export type ExecutionResult =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; failure: ExecutionFailure }
  | { status: "blocked"; reason: string }
  | { status: "cancelled"; reason: string };

/**
 * Harness-independent execution boundary; adapters execute requests while the engine owns policy.
 */
export interface RuntimeAdapter {
  readonly id: string;
  /** Describe observable runtime support without starting an execution. */
  capabilities(): Promise<RuntimeCapabilities>;
  /** Start one explicit attempt; policy and context are supplied by the engine. */
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  /** Stream only public observations for the selected execution. */
  events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent>;
  /** Await a normalized terminal result; the engine still validates its output. */
  collect(handle: ExecutionHandle): Promise<ExecutionResult>;
  /** Request cancellation and reject if safe termination cannot be confirmed. */
  cancel(handle: ExecutionHandle): Promise<void>;
}

export {
  RuntimePreflightError,
  probeRuntime,
  assertRuntimeNegotiation,
  assertRuntimeCapabilities,
  assertRuntimeDescriptor,
  assertRuntimeEvent,
  assertExecutionRequest,
  assertExecutionResult,
  assertWorkspaceCheckpoint,
} from "./validation.js";
