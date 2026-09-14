import Ajv from "ajv";
import type { RunEvent } from "./events.js";

const str = { type: "string" },
  positive = { type: "integer", minimum: 1 };
const failure = {
  type: "object",
  additionalProperties: false,
  required: ["category", "message"],
  properties: {
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
  },
};
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const producer = object({ runId: str, nodeId: str, attempt: positive });
const artifact = object({
  id: str,
  type: str,
  mediaType: str,
  uri: str,
  digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
  producer,
});
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
const runtimeEvent = {
  oneOf: [
    object({ type: { const: "started" } }),
    object({ type: { const: "log" }, message: str }),
    object({ type: { const: "metadata" }, provider: str, model: str }),
    object({
      type: { const: "completed" },
      status: { enum: ["succeeded", "failed", "blocked", "cancelled"] },
    }),
  ],
};
const commandOutput = object({
  passed: { type: "boolean" },
  exitCode: { type: ["integer", "null"] },
  signal: { type: ["string", "null"] },
  durationMs: { type: "number", minimum: 0 },
  stdoutBytes: { type: "integer", minimum: 0 },
  stderrBytes: { type: "integer", minimum: 0 },
  stdoutTruncated: { type: "boolean" },
  stderrTruncated: { type: "boolean" },
});
const node = { nodeId: str },
  attempt = { ...node, attempt: positive },
  reason = { reason: str };
const fields: Record<string, Record<string, unknown>> = {
  RunCreated: {
    workflowInstanceId: str,
    workflowId: str,
    workflowVersion: str,
    nodeIds: { type: "array", minItems: 1, uniqueItems: true, items: str },
    inputs: { type: "object" },
  },
  NodeReady: { ...node, reason: { enum: ["dependencies-satisfied", "retry", "resumed"] } },
  AttemptScheduled: { ...attempt, runtimeId: str },
  AttemptStarted: attempt,
  RuntimeEventObserved: { ...attempt, event: runtimeEvent },
  AttemptSucceeded: { ...attempt, output: true },
  AttemptFailed: { ...attempt, failure },
  AttemptBlocked: { ...attempt, ...reason },
  AttemptCancelled: { ...attempt, ...reason },
  NodeSucceeded: node,
  NodeFailed: { ...node, failure },
  NodeBlocked: { ...node, ...reason },
  NodePaused: node,
  NodeCancelled: { ...node, ...reason },
  RunPaused: {},
  RunResumed: {},
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
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(
  Object.entries(fields).map(([type, props]) => [
    type,
    ajv.compile(object({ type: { const: type }, runId: str, sequence: positive, ...props })),
  ]),
);
/**
 * Validate an untrusted persisted event's exact discriminated payload before replay.
 */
export function assertRunEvent(value: unknown): asserts value is RunEvent {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
    throw new Error("Corrupt run event");
  }
  const validate = validators.get(value.type);
  if (!validate || !validate(value)) {
    throw new Error("Corrupt run event " + value.type + ": " + ajv.errorsText(validate?.errors));
  }
}
