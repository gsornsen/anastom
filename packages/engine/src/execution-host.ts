import { isDeepStrictEqual } from "node:util";

import { canonicalJson, digestJson, type CommandDefinition } from "@anastom/core";
import {
  assertExecutionRequest,
  assertRuntimeDescriptor,
  type ExecutionRequest,
  type ExecutionResult,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type WorkspaceRef,
} from "@anastom/runtime-contract";

import { type CommandExecution } from "./command.js";
import { assertLocalProcessIdentity, type LocalProcessIdentity } from "./durable-store.js";

/** Durable identity committed before an execution supervisor is prepared. */
export interface ExecutionPlanRef {
  version: "anastom.dev/owned-execution/v1alpha1";
  runId: string;
  executionId: string;
  kind: "runtime" | "command";
  generation: number;
  planDigest: string;
}

/** Sanitized proof that a supervisor published the manifest for an execution plan. */
export interface PersistedExecutionRef extends ExecutionPlanRef {
  manifestDigest: string;
}

/** Confirmed public terminal evidence retained after private execution cleanup. */
interface ExecutionTerminalEvidence {
  outcome: "succeeded" | "failed" | "blocked" | "cancelled";
  cleanup: "confirmed";
  terminalDigest: string;
}

/** Stable fail-closed reasons for an execution that cannot be classified as absent. */
export type ExecutionObservationReason =
  | "invalid-record"
  | "identity-mismatch"
  | "boot-mismatch"
  | "supervisor-unreachable"
  | "supervisor-lost"
  | "cleanup-unconfirmed";

/** Model-free observation of one exact prepared execution. */
export type ExecutionObservation =
  | { state: "active"; execution: ExecutionPlanRef }
  | {
      state: "absent";
      execution: ExecutionPlanRef;
      terminal?: ExecutionTerminalEvidence;
    }
  | {
      state: "unknown";
      execution: ExecutionPlanRef;
      reason: ExecutionObservationReason;
    };

/** Runtime or command launch input bound to a precomputed execution plan digest. */
export type PrepareExecution =
  | {
      plan: ExecutionPlanRef;
      coordinator: LocalProcessIdentity;
      descriptor: RuntimeDescriptor;
      request: ExecutionRequest;
    }
  | {
      plan: ExecutionPlanRef;
      coordinator: LocalProcessIdentity;
      command: CommandDefinition;
      workspace: WorkspaceRef;
    };

/** Input used to construct an exact plan and prepare request before persistence. */
export type UnplannedExecution =
  | {
      runId: string;
      executionId: string;
      generation: number;
      coordinator: LocalProcessIdentity;
      descriptor: RuntimeDescriptor;
      request: ExecutionRequest;
    }
  | {
      runId: string;
      executionId: string;
      generation: number;
      coordinator: LocalProcessIdentity;
      command: CommandDefinition;
      workspace: WorkspaceRef;
    };

/** Active execution controlled through the authenticated supervisor boundary. */
export interface OwnedExecution {
  readonly execution: PersistedExecutionRef;
  /** Stream bounded normalized public observations without native payloads. */
  events(): AsyncIterable<RuntimeEvent>;
  /** Collect the normalized runtime result or bounded command evidence after cleanup. */
  collect(): Promise<ExecutionResult | CommandExecution>;
  /** Request cleanup and return only after a model-free execution observation. */
  cancel(): Promise<ExecutionObservation>;
}

/** Engine-owned process supervision boundary implemented without importing concrete runtimes. */
export interface ExecutionHost {
  /** Publish private control state and an awaiting-start manifest without launching a worker. */
  prepare(input: PrepareExecution): Promise<PersistedExecutionRef>;
  /** Launch only after the caller durably commits the matching start-authorized event. */
  authorize(execution: PersistedExecutionRef): Promise<OwnedExecution>;
  /** Inspect an exact plan without starting, stopping, or contacting a model provider. */
  inspect(execution: ExecutionPlanRef): Promise<ExecutionObservation>;
  /** Request confirmed descendant cleanup; uncertainty remains an unknown observation. */
  terminate(execution: ExecutionPlanRef): Promise<ExecutionObservation>;
}

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const launchVersion = "anastom.dev/execution-plan/v1alpha1";

function planDigestInput(input: UnplannedExecution): unknown {
  const common = {
    version: launchVersion,
    runId: input.runId,
    executionId: input.executionId,
    generation: input.generation,
    coordinator: input.coordinator,
  };
  if ("descriptor" in input) {
    return {
      ...common,
      kind: "runtime",
      descriptor: input.descriptor,
      request: input.request,
    };
  }
  return { ...common, kind: "command", command: input.command, workspace: input.workspace };
}

/** Construct a launch request whose public plan digest binds every private launch input. */
export function createPrepareExecution(input: UnplannedExecution): PrepareExecution {
  const kind = "descriptor" in input ? "runtime" : "command";
  const plan: ExecutionPlanRef = {
    version: "anastom.dev/owned-execution/v1alpha1",
    runId: input.runId,
    executionId: input.executionId,
    kind,
    generation: input.generation,
    planDigest: digestJson(planDigestInput(input)),
  };
  const prepared: PrepareExecution =
    "descriptor" in input
      ? {
          plan,
          coordinator: structuredClone(input.coordinator),
          descriptor: structuredClone(input.descriptor),
          request: structuredClone(input.request),
        }
      : {
          plan,
          coordinator: structuredClone(input.coordinator),
          command: structuredClone(input.command),
          workspace: structuredClone(input.workspace),
        };
  assertPrepareExecution(prepared);
  return prepared;
}

/** Validate exact plan identity and recompute its digest before any supervisor side effect. */
export function assertPrepareExecution(value: PrepareExecution): void {
  assertExecutionPlanRef(value.plan);
  assertLocalProcessIdentity(value.coordinator);
  const common = {
    runId: value.plan.runId,
    executionId: value.plan.executionId,
    generation: value.plan.generation,
    coordinator: value.coordinator,
  };
  let unplanned: UnplannedExecution;
  if (value.plan.kind === "runtime" && "descriptor" in value && "request" in value) {
    if (Object.keys(value).sort().join(",") !== "coordinator,descriptor,plan,request") {
      throw new TypeError("Invalid runtime prepare fields");
    }
    assertRuntimeDescriptor(value.descriptor);
    assertExecutionRequest(value.request);
    if (value.request.runId !== value.plan.runId) {
      throw new TypeError("Execution request belongs to another run");
    }
    unplanned = { ...common, descriptor: value.descriptor, request: value.request };
  } else if (value.plan.kind === "command" && "command" in value && "workspace" in value) {
    if (Object.keys(value).sort().join(",") !== "command,coordinator,plan,workspace") {
      throw new TypeError("Invalid command prepare fields");
    }
    assertCommandDefinition(value.command);
    assertFilesystemWorkspace(value.workspace);
    unplanned = { ...common, command: value.command, workspace: value.workspace };
  } else {
    throw new TypeError("Execution kind and launch input disagree");
  }
  if (digestJson(planDigestInput(unplanned)) !== value.plan.planDigest) {
    throw new TypeError("Execution plan digest does not match its launch input");
  }
  if (Buffer.byteLength(canonicalJson(value)) > 4 * 1024 * 1024) {
    throw new RangeError("Private execution launch exceeds 4 MiB");
  }
}

/** Validate an execution plan or sanitized persisted reference at a process boundary. */
export function assertExecutionPlanRef(value: ExecutionPlanRef | PersistedExecutionRef): void {
  const hasManifest = !!value && typeof value === "object" && "manifestDigest" in value;
  const expected = hasManifest
    ? "executionId,generation,kind,manifestDigest,planDigest,runId,version"
    : "executionId,generation,kind,planDigest,runId,version";
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== expected ||
    value.version !== "anastom.dev/owned-execution/v1alpha1" ||
    !identifier.test(value.runId) ||
    !uuid.test(value.executionId) ||
    (value.kind !== "runtime" && value.kind !== "command") ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !digest.test(value.planDigest) ||
    (hasManifest && !digest.test(value.manifestDigest))
  ) {
    throw new TypeError("Invalid execution plan reference");
  }
}

/** Confirm that a persisted reference is the same plan plus one manifest identity digest. */
export function assertPersistedExecutionRef(
  value: PersistedExecutionRef,
  plan?: ExecutionPlanRef,
): void {
  assertExecutionPlanRef(value);
  if (plan) {
    assertExecutionPlanRef(plan);
    const persistedPlan: ExecutionPlanRef = {
      version: value.version,
      runId: value.runId,
      executionId: value.executionId,
      kind: value.kind,
      generation: value.generation,
      planDigest: value.planDigest,
    };
    if (!isDeepStrictEqual(persistedPlan, plan)) {
      throw new TypeError("Persisted execution reference belongs to another plan");
    }
  }
}

function assertCommandDefinition(command: CommandDefinition): void {
  if (
    !command ||
    typeof command !== "object" ||
    Object.keys(command).sort().join(",") !== "argv,cwd,maxDurationMs,maxOutputBytes" ||
    !Array.isArray(command.argv) ||
    command.argv.length < 1 ||
    command.argv.some(
      (argument) => typeof argument !== "string" || !argument || argument.includes("\0"),
    ) ||
    typeof command.cwd !== "string" ||
    command.cwd.includes("\0") ||
    !Number.isSafeInteger(command.maxDurationMs) ||
    command.maxDurationMs < 1 ||
    command.maxDurationMs > 2_147_483_647 ||
    !Number.isSafeInteger(command.maxOutputBytes) ||
    command.maxOutputBytes < 1 ||
    command.maxOutputBytes > 16_777_216
  ) {
    throw new TypeError("Invalid command definition");
  }
}

function assertFilesystemWorkspace(workspace: WorkspaceRef): void {
  const keys = Object.keys(workspace).sort().join(",");
  const validKeys =
    workspace.mode === "readonly"
      ? "baseCommit,id,mode,path,repoRoot"
      : "baseCommit,branch,id,mode,path,repoRoot";
  if (
    (workspace.mode !== "readonly" && workspace.mode !== "isolated") ||
    keys !== validKeys ||
    !identifier.test(workspace.id) ||
    !workspace.repoRoot ||
    !workspace.path ||
    !workspace.baseCommit ||
    (workspace.mode === "isolated" && !workspace.branch)
  ) {
    throw new TypeError("Command execution requires an exact filesystem workspace");
  }
}
