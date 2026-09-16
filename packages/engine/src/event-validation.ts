import Ajv from "ajv";
import capabilities from "../../runtime-contract/schemas/capabilities.v1alpha1.json" with { type: "json" };
import observation from "../../runtime-contract/schemas/observation.v1alpha1.json" with { type: "json" };
import runtimeDescriptor from "../../runtime-contract/schemas/runtime-descriptor.v1alpha1.json" with { type: "json" };
import { assertRuntimeDescriptor } from "@anastom/runtime-contract";
import type { RunEvent } from "./events.js";

const str = { type: "string" };
const positive = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonnegative = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
const identifier = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const failure = object({
  category: {
    enum: [
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
    ],
  },
  message: str,
});
const producer = object({ runId: str, nodeId: str, attempt: positive });
const artifact = object({ id: str, type: str, mediaType: str, uri: str, digest, producer });
const workspace = {
  oneOf: [
    object({ id: str, mode: { const: "memory" } }),
    object({ id: str, mode: { const: "readonly" }, repoRoot: str, path: str, baseCommit: str }),
    object({
      id: str,
      mode: { const: "isolated" },
      repoRoot: str,
      path: str,
      baseCommit: str,
      branch: str,
    }),
  ],
};
const commandOutput = object({
  passed: { type: "boolean" },
  exitCode: { type: ["integer", "null"] },
  signal: { type: ["string", "null"] },
  durationMs: { type: "number", minimum: 0 },
  stdoutBytes: nonnegative,
  stderrBytes: nonnegative,
  stdoutTruncated: { type: "boolean" },
  stderrTruncated: { type: "boolean" },
});
const workspaceDifferences = {
  type: "array",
  uniqueItems: true,
  items: {
    enum: [
      "version",
      "workspace-id",
      "base-commit",
      "head-commit",
      "diff-digest",
      "changed-files",
      "ignored-content",
      "repository",
      "workspace-path",
      "branch",
      "ownership-manifest",
      "worktree-registration",
    ],
  },
};
const workspaceCheckpoint = object(
  {
    version: { const: "anastom.dev/workspace-checkpoint/v1alpha1" },
    workspaceId: identifier,
    baseCommit: str,
    headCommit: str,
    diffDigest: digest,
    changedFiles: { type: "array", uniqueItems: true, items: str },
    ignoredDigest: digest,
    ignoredEntryCount: nonnegative,
    ignoredByteCount: nonnegative,
    ownership: object({
      repositoryRoot: str,
      repositoryCommonDirectory: str,
      workspacePath: str,
      workspaceGitDirectory: str,
      branch: str,
      manifestDigest: digest,
      registrationDigest: digest,
    }),
    diffArtifactId: identifier,
  },
  [
    "version",
    "workspaceId",
    "baseCommit",
    "headCommit",
    "diffDigest",
    "changedFiles",
    "ignoredDigest",
    "ignoredEntryCount",
    "ignoredByteCount",
    "ownership",
  ],
);
const executionPlanProperties = {
  version: { const: "anastom.dev/owned-execution/v1alpha1" },
  runId: identifier,
  executionId: identifier,
  kind: { enum: ["runtime", "command"] },
  generation: positive,
  planDigest: digest,
};
const executionPlan = object(executionPlanProperties);
const persistedExecution = object({ ...executionPlanProperties, manifestDigest: digest });
const pauseReason = {
  oneOf: [
    object({ kind: { const: "operator" }, operationId: identifier }),
    object({ kind: { const: "workspace-conflict" }, differences: workspaceDifferences }),
    object({
      kind: { const: "attempt-budget-exhausted" },
      nodeId: identifier,
      attempts: positive,
    }),
    object({ kind: { const: "runtime-unavailable" }, runtimeId: identifier }),
    object({ kind: { const: "policy-violation" }, runtimeId: identifier }),
  ],
};
const recoveryBlockReason = {
  oneOf: [
    object({
      kind: { const: "execution-unknown" },
      executionId: identifier,
      detail: {
        enum: [
          "invalid-record",
          "identity-mismatch",
          "boot-mismatch",
          "supervisor-unreachable",
          "supervisor-lost",
          "cleanup-unconfirmed",
        ],
      },
    }),
    object({ kind: { const: "cleanup-unknown" }, executionId: identifier }),
    object({
      kind: { const: "history-incompatible" },
      detail: { enum: ["missing-descriptor", "missing-execution-ref"] },
    }),
  ],
};
const node = { nodeId: str };
const attempt = { ...node, attempt: positive };
const reason = { reason: str };
const fields: Record<string, Record<string, unknown>> = {
  RuntimeNegotiated: {
    negotiation: object({
      version: { const: "anastom.dev/runtime-negotiation/v1alpha1" },
      runtimeId: str,
      requirements: object({
        workspaceMode: { enum: ["readonly", "isolated"] },
        cancellation: { const: true },
        structuredOutput: { const: "validated" },
      }),
      capabilities,
    }),
  },
  RuntimeConfigured: { descriptor: runtimeDescriptor },
  RunCreated: {
    workflowInstanceId: str,
    workflowId: str,
    workflowVersion: str,
    nodeIds: { type: "array", minItems: 1, uniqueItems: true, items: str },
    inputs: { type: "object" },
  },
  NodeReady: {
    ...node,
    reason: { enum: ["dependencies-satisfied", "retry", "resumed", "recovered"] },
  },
  AttemptScheduled: { ...attempt, runtimeId: str },
  AttemptPrepared: { ...attempt, execution: executionPlan, workspaceCheckpoint },
  AttemptStartAuthorized: { ...attempt, execution: persistedExecution },
  AttemptStarted: attempt,
  RuntimeEventObserved: { ...attempt, event: observation },
  AttemptSucceeded: { ...attempt, output: true },
  AttemptFailed: { ...attempt, failure },
  AttemptBlocked: { ...attempt, ...reason },
  AttemptCancelled: { ...attempt, ...reason },
  AttemptOrphaned: {
    ...attempt,
    executionId: identifier,
    lostGeneration: positive,
    reason: { enum: ["coordinator-lost", "launch-interrupted"] },
    workspaceObservation: workspaceCheckpoint,
    workspaceDifferences,
    terminalArtifactId: identifier,
  },
  ControlRequestObserved: {
    operationId: identifier,
    action: { enum: ["pause", "cancel"] },
    recordedAtMs: positive,
  },
  ExecutionCleanupObserved: {
    ...attempt,
    executionId: identifier,
    cause: { enum: ["pause", "cancel", "timeout", "recovery"] },
    outcome: { enum: ["confirmed", "unknown"] },
  },
  NodeSucceeded: node,
  NodeFailed: { ...node, failure },
  NodeBlocked: { ...node, ...reason },
  NodePaused: node,
  NodeCancelled: { ...node, ...reason },
  RunPaused: {},
  RunResumed: {},
  RunRecoveryBlocked: { operationId: identifier, reason: recoveryBlockReason },
  RunBlocked: reason,
  RunCancelled: reason,
  RunCompleted: { outcome: { enum: ["succeeded", "failed"] } },
  WorkspaceAssigned: { workspace },
  ArtifactProduced: { ...attempt, artifact },
  WorkspaceObserved: {
    ...attempt,
    headCommit: str,
    changedFiles: { type: "array", items: str },
    diffArtifactId: str,
  },
  CommandCompleted: { ...attempt, output: commandOutput },
  AttemptTimeoutRequested: attempt,
  AttemptCancellationCompleted: {
    ...attempt,
    outcome: { enum: ["succeeded", "failed", "unavailable"] },
  },
  LateResultObserved: {
    ...attempt,
    status: { enum: ["succeeded", "failed", "blocked", "cancelled"] },
  },
};
const eventSchema = (
  type: string,
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) =>
  object({ type: { const: type }, runId: str, sequence: positive, ...properties }, [
    "type",
    "runId",
    "sequence",
    ...required,
  ]);
const schemas = new Map<string, unknown>(
  Object.entries(fields).map(([type, properties]) => [type, eventSchema(type, properties)]),
);
schemas.set(
  "AttemptOrphaned",
  eventSchema(
    "AttemptOrphaned",
    fields.AttemptOrphaned!,
    Object.keys(fields.AttemptOrphaned!).filter((field) => field !== "terminalArtifactId"),
  ),
);
schemas.set("NodePaused", {
  oneOf: [
    eventSchema("NodePaused", node),
    eventSchema("NodePaused", { ...node, reason: pauseReason }),
  ],
});
schemas.set("RunPaused", {
  oneOf: [eventSchema("RunPaused", {}), eventSchema("RunPaused", { reason: pauseReason })],
});
schemas.set("RunResumed", {
  oneOf: [eventSchema("RunResumed", {}), eventSchema("RunResumed", { operationId: identifier })],
});
schemas.set("RunCancelled", {
  oneOf: [
    eventSchema("RunCancelled", reason),
    eventSchema("RunCancelled", { operationId: identifier, ...reason }),
  ],
});

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(
  [...schemas].map(([type, schema]) => [type, ajv.compile(schema as object)]),
);

/** Validate an untrusted persisted event's exact discriminated payload before replay. */
export function assertRunEvent(value: unknown): asserts value is RunEvent {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
    throw new Error("Corrupt run event");
  }
  const validate = validators.get(value.type);
  if (!validate || !validate(value)) {
    throw new Error("Corrupt run event " + value.type + ": " + ajv.errorsText(validate?.errors));
  }
  if (value.type === "RuntimeConfigured") {
    try {
      assertRuntimeDescriptor((value as unknown as { descriptor: unknown }).descriptor);
    } catch {
      throw new Error("Corrupt run event RuntimeConfigured: invalid runtime descriptor");
    }
  }
}
