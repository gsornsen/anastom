import Ajv from "ajv";
import { assertNormalizedFeaturePlan, canonicalJson } from "@anastom/core";
import capabilitiesSchema from "../schemas/capabilities.v1alpha1.json" with { type: "json" };
import liveRunEventSchema from "../schemas/live-run-event.v1alpha1.json" with { type: "json" };
import observationSchema from "../schemas/observation.v1alpha1.json" with { type: "json" };
import runtimeDescriptorSchema from "../schemas/runtime-descriptor.v1alpha1.json" with { type: "json" };
import workspaceCheckpointSchema from "../schemas/workspace-checkpoint.v1alpha1.json" with { type: "json" };
import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeDescriptor,
  RuntimeEvent,
  RuntimeNegotiation,
  ExecutionRequest,
  ExecutionResult,
  LiveRunEvent,
  WorkspaceRef,
  WorkspaceCheckpoint,
} from "./index.js";

// Public runtime records fail on the first schema error so adversarially deep input cannot
// multiply validation work merely to produce diagnostics.
const ajv = new Ajv({ allErrors: false, strict: false });
const capabilitiesValidator = ajv.compile(capabilitiesSchema);
const liveRunEventValidator = ajv.compile(liveRunEventSchema);
const observationValidator = ajv.compile(observationSchema);
const runtimeDescriptorValidator = ajv.compile(runtimeDescriptorSchema);
const workspaceCheckpointValidator = ajv.compile(workspaceCheckpointSchema);
const MAX_RUNTIME_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_EXECUTION_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTION_RESULT_BYTES = 1024 * 1024;
const failureCategories = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return (
    observed.length === expected.length && observed.every((key, index) => key === expected[index])
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function validPositive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validWorkspace(value: unknown): value is WorkspaceRef {
  if (!isRecord(value) || !validString(value.id) || typeof value.mode !== "string") {
    return false;
  }
  if (value.mode === "memory") {
    return exactKeys(value, ["id", "mode"]);
  }
  const common = ["baseCommit", "id", "mode", "path", "repoRoot"];
  if (
    !["readonly", "isolated"].includes(value.mode) ||
    !validString(value.repoRoot) ||
    !validString(value.path) ||
    !validString(value.baseCommit)
  ) {
    return false;
  }
  return value.mode === "readonly"
    ? exactKeys(value, common)
    : exactKeys(value, [...common, "branch"]) && validString(value.branch);
}

function validBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["maxAttempts"], ["maxDurationMs"]) &&
    validPositive(value.maxAttempts) &&
    (value.maxDurationMs === undefined || validPositive(value.maxDurationMs))
  );
}

function validCommand(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["argv", "cwd", "maxDurationMs", "maxOutputBytes"]) &&
    Array.isArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.every(validString) &&
    typeof value.cwd === "string" &&
    !value.cwd.includes("\0") &&
    validPositive(value.maxDurationMs) &&
    validPositive(value.maxOutputBytes)
  );
}

function validArtifact(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["digest", "id", "mediaType", "producer", "type", "uri"]) ||
    ![value.id, value.type, value.mediaType, value.uri].every(validString) ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
    !isRecord(value.producer) ||
    !exactKeys(value.producer, ["attempt", "nodeId", "runId"])
  ) {
    return false;
  }
  return (
    validString(value.producer.runId) &&
    validString(value.producer.nodeId) &&
    validPositive(value.producer.attempt)
  );
}

const contextOptionalKeys = [
  "allowedMutations",
  "assignment",
  "artifacts",
  "attempt",
  "budget",
  "feature",
  "instructions",
  "mutationScopes",
  "nodeId",
  "requiredOutputSchema",
  "role",
  "runId",
  "task",
  "plan",
  "verification",
  "version",
  "workflowInstanceId",
  "workspace",
] as const;

function validContextScalars(value: Record<string, unknown>): boolean {
  return !(
    (value.version !== undefined && value.version !== "anastom.dev/context/v1alpha1") ||
    (value.runId !== undefined && !validString(value.runId)) ||
    (value.workflowInstanceId !== undefined && !validString(value.workflowInstanceId)) ||
    (value.nodeId !== undefined && !validString(value.nodeId)) ||
    (value.attempt !== undefined && !validPositive(value.attempt)) ||
    (value.instructions !== undefined && !validString(value.instructions)) ||
    (value.allowedMutations !== undefined &&
      value.allowedMutations !== "readonly" &&
      value.allowedMutations !== "isolated")
  );
}

function validStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(validString);
}

function validContextSdlc(value: Record<string, unknown>): boolean {
  if (value.mutationScopes !== undefined && !validStringArray(value.mutationScopes)) {
    return false;
  }
  if (
    value.feature !== undefined &&
    (!isRecord(value.feature) ||
      !exactKeys(value.feature, [
        "acceptanceCriteria",
        "documentDigest",
        "id",
        "objective",
        "version",
      ]) ||
      !validString(value.feature.id) ||
      !validString(value.feature.version) ||
      !validString(value.feature.objective) ||
      !validString(value.feature.documentDigest) ||
      !validStringArray(value.feature.acceptanceCriteria))
  ) {
    return false;
  }
  if (
    value.assignment !== undefined &&
    (!isRecord(value.assignment) ||
      !exactKeys(value.assignment, [
        "acceptanceCriteria",
        "dependsOn",
        "id",
        "mutationScopes",
        "objective",
        "title",
      ]) ||
      ![value.assignment.id, value.assignment.title, value.assignment.objective].every(
        validString,
      ) ||
      !validStringArray(value.assignment.acceptanceCriteria) ||
      !validStringArray(value.assignment.dependsOn) ||
      !validStringArray(value.assignment.mutationScopes))
  ) {
    return false;
  }
  if (value.plan !== undefined) {
    try {
      assertNormalizedFeaturePlan(value.plan);
    } catch {
      return false;
    }
  }
  return true;
}

function validContextStructures(value: Record<string, unknown>): boolean {
  return !(
    (value.workspace !== undefined && !validWorkspace(value.workspace)) ||
    (value.budget !== undefined && !validBudget(value.budget)) ||
    (value.verification !== undefined && !validCommand(value.verification)) ||
    (value.artifacts !== undefined &&
      (!Array.isArray(value.artifacts) || !value.artifacts.every(validArtifact))) ||
    (value.role !== undefined &&
      (!isRecord(value.role) || !exactKeys(value.role, ["id"]) || !validString(value.role.id)))
  );
}

function validContextTask(value: Record<string, unknown>): boolean {
  return !(
    value.task !== undefined &&
    (!isRecord(value.task) ||
      !exactKeys(value.task, ["acceptanceCriteria", "id", "objective", "version"]) ||
      !validString(value.task.id) ||
      !validString(value.task.version) ||
      !validString(value.task.objective) ||
      !Array.isArray(value.task.acceptanceCriteria) ||
      !value.task.acceptanceCriteria.every(validString))
  );
}

function validContext(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["dependencyOutputs", "inputs"], contextOptionalKeys) ||
    !isRecord(value.inputs) ||
    !isRecord(value.dependencyOutputs) ||
    !validContextScalars(value) ||
    !validContextStructures(value) ||
    !validContextTask(value) ||
    !validContextSdlc(value)
  ) {
    return false;
  }
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

/** A sanitized pre-state failure to probe or satisfy the explicitly selected runtime. */
export class RuntimePreflightError extends Error {
  /** Classify the failure without exposing native configuration or credential contents. */
  constructor(
    readonly category: "policy-violation" | "runtime-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RuntimePreflightError";
  }
}

/**
 * Validate a complete capability snapshot; unknown extra fields fail closed.
 * @internal
 */
export function assertRuntimeCapabilities(value: unknown): asserts value is RuntimeCapabilities {
  if (!capabilitiesValidator(value)) {
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Runtime returned an invalid capability snapshot",
    );
  }
}

/** Validate public observation fields before persistence, excluding opaque native payloads. */
export function assertRuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  if (!observationValidator(value)) {
    throw new Error("Invalid public runtime observation");
  }
}

const liveBase = ["runId", "sequence", "type", "version"] as const;
const liveNode = [...liveBase, "nodeId", "phase"] as const;
const liveAttempt = [...liveNode, "attempt"] as const;
const nodeStatuses = [
  "pending",
  "ready",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "paused",
  "cancelled",
] as const;

/** Validate one exact bounded public run observation before external presentation. */
export function assertLiveRunEvent(value: unknown): asserts value is LiveRunEvent {
  if (!liveRunEventValidator(value) || !isRecord(value)) {
    throw new Error("Invalid live run event");
  }
  let valid = false;
  switch (value.type) {
    case "run":
      valid =
        exactKeys(value, [...liveBase, "status"]) &&
        [
          "created",
          "paused",
          "running",
          "blocked",
          "recovery-blocked",
          "cancelled",
          "succeeded",
          "failed",
        ].includes(value.status as string);
      break;
    case "graph":
      valid =
        exactKeys(value, [...liveBase, "expansionDigest", "nodeCount", "planDigest", "status"]) &&
        value.status === "expanded";
      break;
    case "node":
      valid = validLiveNode(value);
      break;
    case "attempt":
      valid = validLiveAttempt(value);
      break;
    case "log":
      valid =
        hasOnlyKeys(value, [...liveAttempt, "message"], ["droppedMessages", "messageTruncated"]) &&
        Buffer.byteLength(value.message as string) <= 2 * 1024;
      break;
    case "runtime":
      valid = hasOnlyKeys(
        value,
        [...liveAttempt, "model", "provider"],
        ["runtimeVersion", "source"],
      );
      break;
    case "usage":
      valid = exactKeys(value, [...liveAttempt, "usage"]);
      break;
    case "artifact":
      valid = exactKeys(value, [...liveAttempt, "artifact"]);
      break;
    case "workspace":
      valid = validLiveWorkspace(value);
      break;
    case "integration":
      valid = validLiveIntegration(value);
      break;
    case "verification":
      valid = exactKeys(value, [
        ...liveAttempt,
        "durationMs",
        "exitCode",
        "passed",
        "signal",
        "stderrBytes",
        "stderrTruncated",
        "stdoutBytes",
        "stdoutTruncated",
      ]);
      break;
    case "control":
      valid = validLiveControl(value);
      break;
  }
  if (!valid) {
    throw new Error("Invalid live run event");
  }
}

function validLiveNode(value: Record<string, unknown>): boolean {
  if (!nodeStatuses.includes(value.status as (typeof nodeStatuses)[number])) {
    return false;
  }
  return value.status === "failed"
    ? exactKeys(value, [...liveNode, "failureCategory", "status"])
    : exactKeys(value, [...liveNode, "status"]);
}

function validLiveAttempt(value: Record<string, unknown>): boolean {
  if (
    ![
      "scheduled",
      "prepared",
      "authorized",
      "running",
      "timed-out",
      "orphaned",
      "blocked",
      "succeeded",
      "failed",
      "cancelled",
    ].includes(value.status as string)
  ) {
    return false;
  }
  if (value.status === "scheduled") {
    return exactKeys(value, [...liveAttempt, "runtimeId", "status"]);
  }
  if (value.status === "prepared" || value.status === "authorized") {
    return exactKeys(value, [...liveAttempt, "planDigest", "status"]);
  }
  if (value.status === "failed") {
    return exactKeys(value, [...liveAttempt, "failureCategory", "status"]);
  }
  return exactKeys(value, [...liveAttempt, "status"]);
}

function validLiveIntegration(value: Record<string, unknown>): boolean {
  if (value.status === "prepared") {
    return exactKeys(value, [...liveNode, "preparationDigest", "status"]);
  }
  if (value.status === "committed") {
    return exactKeys(value, [...liveNode, "commit", "status"]);
  }
  return value.status === "failed" && exactKeys(value, [...liveNode, "failureCategory", "status"]);
}

function validLiveControl(value: Record<string, unknown>): boolean {
  if (value.status === "requested") {
    return exactKeys(value, [...liveBase, "action", "operationId", "status"]);
  }
  if (value.status === "cleanup" && ["confirmed", "unknown"].includes(value.outcome as string)) {
    return exactKeys(value, [...liveAttempt, "outcome", "status"]);
  }
  if (
    value.status === "cancellation-completed" &&
    ["succeeded", "failed", "unavailable"].includes(value.outcome as string)
  ) {
    return exactKeys(value, [...liveAttempt, "outcome", "status"]);
  }
  return (
    value.status === "late-result" &&
    ["succeeded", "failed", "blocked", "cancelled"].includes(value.outcome as string) &&
    exactKeys(value, [...liveAttempt, "outcome", "status"])
  );
}

function validLiveWorkspace(value: Record<string, unknown>): boolean {
  if (value.status === "assigned") {
    if (
      !hasOnlyKeys(
        value,
        [...liveBase, "mode", "status", "workspaceId"],
        ["baseCommit", "branch", "nodeId", "path"],
      )
    ) {
      return false;
    }
    if (value.mode === "memory") {
      return (
        value.path === undefined && value.baseCommit === undefined && value.branch === undefined
      );
    }
    return (
      typeof value.path === "string" &&
      typeof value.baseCommit === "string" &&
      (value.mode === "isolated"
        ? typeof value.branch === "string"
        : value.mode === "readonly" && value.branch === undefined)
    );
  }
  if (value.status === "observed") {
    return exactKeys(value, [
      ...liveAttempt,
      "changedFiles",
      "diffArtifactId",
      "headCommit",
      "status",
    ]);
  }
  if (value.status === "patch-accepted") {
    return exactKeys(value, [
      ...liveAttempt,
      "changedFiles",
      "patchDigest",
      "status",
      "workspaceId",
    ]);
  }
  return false;
}

/** Validate an exact persisted execution request before passing it to a reconstructed adapter. */
export function assertExecutionRequest(value: unknown): asserts value is ExecutionRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        "attempt",
        "budget",
        "context",
        "nodeId",
        "nodeKind",
        "requiredOutputSchema",
        "runId",
        "toolPolicy",
        "workflowInstanceId",
        "workspace",
      ],
      ["role"],
    ) ||
    ![value.runId, value.workflowInstanceId, value.nodeId].every(validString) ||
    !["agent", "command", "gate", "verifier"].includes(value.nodeKind as string) ||
    !validPositive(value.attempt) ||
    !validWorkspace(value.workspace) ||
    !validContext(value.context) ||
    !validBudget(value.budget) ||
    !isRecord(value.requiredOutputSchema) ||
    !isRecord(value.toolPolicy) ||
    !exactKeys(value.toolPolicy, ["allowMutations"]) ||
    typeof value.toolPolicy.allowMutations !== "boolean" ||
    (value.role !== undefined &&
      (!isRecord(value.role) || !exactKeys(value.role, ["id"]) || !validString(value.role.id)))
  ) {
    throw new Error("Invalid persisted execution request");
  }
  let bytes: number;
  try {
    canonicalJson(value.requiredOutputSchema);
    bytes = Buffer.byteLength(canonicalJson(value));
  } catch {
    throw new Error("Invalid persisted execution request");
  }
  if (bytes > MAX_EXECUTION_REQUEST_BYTES) {
    throw new Error("Invalid persisted execution request");
  }
}

/** Validate a normalized terminal result and its 1 MiB canonical public-output bound. */
export function assertExecutionResult(value: unknown): asserts value is ExecutionResult {
  if (!isRecord(value)) {
    throw new Error("Invalid execution result");
  }
  const valid =
    (value.status === "succeeded" && exactKeys(value, ["output", "status"])) ||
    (value.status === "failed" &&
      exactKeys(value, ["failure", "status"]) &&
      isRecord(value.failure) &&
      exactKeys(value.failure, ["category", "message"]) &&
      failureCategories.includes(value.failure.category as (typeof failureCategories)[number]) &&
      typeof value.failure.message === "string") ||
    ((value.status === "blocked" || value.status === "cancelled") &&
      exactKeys(value, ["reason", "status"]) &&
      typeof value.reason === "string");
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(value));
  } catch {
    throw new Error("Invalid execution result");
  }
  if (!valid || bytes > MAX_EXECUTION_RESULT_BYTES) {
    throw new Error("Invalid execution result");
  }
}

/** Validate the shared descriptor envelope and its canonical UTF-8 persistence bound. */
export function assertRuntimeDescriptor(value: unknown): asserts value is RuntimeDescriptor {
  if (!runtimeDescriptorValidator(value)) {
    throw new RuntimePreflightError("policy-violation", "Runtime returned an invalid descriptor");
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(value));
  } catch {
    throw new RuntimePreflightError("policy-violation", "Runtime returned an invalid descriptor");
  }
  if (bytes > MAX_RUNTIME_DESCRIPTOR_BYTES) {
    throw new RuntimePreflightError("policy-violation", "Runtime descriptor exceeds 16 KiB");
  }
}

/** Validate exact durable workspace evidence and its feasibility-tested bounds. */
export function assertWorkspaceCheckpoint(value: unknown): asserts value is WorkspaceCheckpoint {
  if (!workspaceCheckpointValidator(value)) {
    throw new Error("Invalid workspace checkpoint");
  }
}

/** Check recorded requirements against the selected adapter and the actual filesystem mode. */
export function assertRuntimeNegotiation(
  value: RuntimeNegotiation,
  runtimeId: string,
  workspaceMode: "readonly" | "isolated",
): void {
  assertRuntimeCapabilities(value.capabilities);
  if (
    value.version !== "anastom.dev/runtime-negotiation/v1alpha1" ||
    value.runtimeId !== runtimeId ||
    value.requirements.workspaceMode !== workspaceMode ||
    value.requirements.cancellation !== true ||
    value.requirements.structuredOutput !== "validated"
  ) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Runtime negotiation does not match the selected worker and workspace",
    );
  }
  const capabilities = value.capabilities;
  if (!capabilities.workspaceModes?.includes(workspaceMode)) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Selected runtime does not declare support for the requested " + workspaceMode + " workspace",
    );
  }
  if (!capabilities.cancellation || capabilities.structuredOutput === "none") {
    throw new RuntimePreflightError(
      "policy-violation",
      "Selected runtime requires confirmed cancellation and validated structured output support",
    );
  }
}

/** Obtain one validated capability decision without creating worker state or calling a model. */
export async function probeRuntime(
  runtime: RuntimeAdapter,
  workspaceMode: "readonly" | "isolated",
): Promise<RuntimeNegotiation> {
  let capabilities: unknown;
  try {
    capabilities = structuredClone(await runtime.capabilities());
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      throw error;
    }
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Runtime capability probe failed; check installation and authentication readiness",
    );
  }
  assertRuntimeCapabilities(capabilities);
  const decision: RuntimeNegotiation = {
    version: "anastom.dev/runtime-negotiation/v1alpha1",
    runtimeId: runtime.id,
    requirements: { workspaceMode, cancellation: true, structuredOutput: "validated" },
    capabilities,
  };
  assertRuntimeNegotiation(decision, runtime.id, workspaceMode);
  return decision;
}
