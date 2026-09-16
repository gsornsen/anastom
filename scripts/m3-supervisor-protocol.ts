import { createHash, timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { canonicalJson } from "../packages/core/src/index.js";
import {
  assertRuntimeEvent,
  type ExecutionResult,
  type RuntimeEvent,
} from "../packages/runtime-contract/src/index.js";
import {
  localBootIdentityDigest,
  matchesLiveProcess,
  type ProcessIdentity,
} from "./m3-process-identity.js";
import { readM3Record, type M3RecordName } from "./testing/m3-records.js";

export const M3_SUPERVISOR_VERSION = "anastom.dev/m3-supervisor/v1alpha1" as const;
export const M3_SUPERVISOR_MAX_FRAME_BYTES = 131_072;
export const M3_SUPERVISOR_CONNECTION_TIMEOUT_MS = 5_000;
export const M3_SUPERVISOR_SOCKET = "control.sock";

/** Execution owner exercised by the model-free supervisor probe. */
export type M3SupervisorOwner = "pi" | "codex" | "claude-code" | "command";

/** Deterministic execution behavior selected before the supervisor starts. */
export type M3SupervisorScenario = "success" | "hold" | "start-gated";

/** Durable coordinator intent written before the supervisor may create execution side effects. */
export interface M3AttemptPlan {
  version: typeof M3_SUPERVISOR_VERSION;
  runId: string;
  executionId: string;
  fence: number;
  owner: M3SupervisorOwner;
  scenario: M3SupervisorScenario;
  coordinator: ProcessIdentity;
  bootIdentityDigest: string;
}

/** Private, run-owned control capability issued by the supervisor. */
export interface M3ExecutionControl {
  version: typeof M3_SUPERVISOR_VERSION;
  executionId: string;
  capability: string;
}

/** Sanitized durable supervisor identity and lifecycle state. */
export interface M3ExecutionManifest {
  version: typeof M3_SUPERVISOR_VERSION;
  runId: string;
  executionId: string;
  fence: number;
  owner: M3SupervisorOwner;
  bootIdentityDigest: string;
  planDigest: string;
  capabilityDigest: string;
  socketName: typeof M3_SUPERVISOR_SOCKET;
  supervisor: ProcessIdentity;
  state: "awaiting-start" | "starting" | "active" | "terminal";
}

/** Persisted coordinator authorization required before worker launch. */
export interface M3StartAuthority {
  version: typeof M3_SUPERVISOR_VERSION;
  executionId: string;
  fence: number;
  planDigest: string;
  capabilityDigest: string;
  supervisor: ProcessIdentity;
}

/** Bounded public observations and result retained by the protocol probe. */
export interface M3ExecutionTerminal {
  version: typeof M3_SUPERVISOR_VERSION;
  executionId: string;
  fence: number;
  owner: M3SupervisorOwner;
  events: RuntimeEvent[];
  result: ExecutionResult;
  cleanup: "confirmed" | "unknown";
}

/** One authenticated request on the local framed supervisor socket. */
export interface M3SupervisorRequest {
  version: typeof M3_SUPERVISOR_VERSION;
  operation: "authorize" | "inspect" | "collect" | "cancel" | "release";
  executionId: string;
  fence: number;
  capability: string;
}

/** One bounded response from the local framed supervisor socket. */
export type M3SupervisorResponse =
  | {
      ok: true;
      operation: M3SupervisorRequest["operation"];
      state: M3ExecutionManifest["state"];
      terminal?: M3ExecutionTerminal;
    }
  | {
      ok: false;
      category: "unauthorized" | "invalid-state" | "invalid-request" | "internal";
      message: string;
    };

/** Fail-closed cross-process inspection outcome used by the feasibility probe. */
export interface M3PersistedInspection {
  state: "active" | "absent" | "unknown";
  manifest?: M3ExecutionManifest;
  terminal?: M3ExecutionTerminal;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  return (
    isRecord(value) &&
    exactKeys(value, ["pid", "processGroupId", "startToken", "state"]) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    Number.isSafeInteger(value.processGroupId) &&
    (value.processGroupId as number) > 0 &&
    typeof value.state === "string" &&
    value.state.length > 0 &&
    typeof value.startToken === "string" &&
    value.startToken.length > 0
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length && observed.every((key, index) => key === expected[index])
  );
}

/** Hash canonical public protocol data without exposing its bytes. */
export function m3ProtocolDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Hash a private capability for comparison in non-secret manifests. */
export function m3CapabilityDigest(capability: string): string {
  return `sha256:${createHash("sha256").update(capability).digest("hex")}`;
}

/** Compare private capabilities without an early-exit string comparison. */
export function matchesM3Capability(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Validate the exact persisted attempt-plan schema before trusting any field. */
export function assertM3AttemptPlan(value: unknown): asserts value is M3AttemptPlan {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "bootIdentityDigest",
      "coordinator",
      "executionId",
      "fence",
      "owner",
      "runId",
      "scenario",
      "version",
    ]) ||
    value.version !== M3_SUPERVISOR_VERSION ||
    !isIdentifier(value.runId) ||
    !isIdentifier(value.executionId) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !["pi", "codex", "claude-code", "command"].includes(value.owner as string) ||
    !["success", "hold", "start-gated"].includes(value.scenario as string) ||
    !isProcessIdentity(value.coordinator) ||
    !isDigest(value.bootIdentityDigest)
  ) {
    throw new Error("Invalid M3 attempt plan");
  }
}

/** Validate the exact private control record before using its capability. */
export function assertM3ExecutionControl(value: unknown): asserts value is M3ExecutionControl {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["capability", "executionId", "version"]) ||
    value.version !== M3_SUPERVISOR_VERSION ||
    !isIdentifier(value.executionId) ||
    typeof value.capability !== "string" ||
    !/^[a-zA-Z0-9_-]{43}$/.test(value.capability)
  ) {
    throw new Error("Invalid M3 execution control record");
  }
}

/** Validate the exact sanitized manifest schema before process inspection. */
export function assertM3ExecutionManifest(value: unknown): asserts value is M3ExecutionManifest {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "bootIdentityDigest",
      "capabilityDigest",
      "executionId",
      "fence",
      "owner",
      "planDigest",
      "runId",
      "socketName",
      "state",
      "supervisor",
      "version",
    ]) ||
    value.version !== M3_SUPERVISOR_VERSION ||
    !isIdentifier(value.runId) ||
    !isIdentifier(value.executionId) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !["pi", "codex", "claude-code", "command"].includes(value.owner as string) ||
    !isDigest(value.bootIdentityDigest) ||
    !isDigest(value.planDigest) ||
    !isDigest(value.capabilityDigest) ||
    value.socketName !== M3_SUPERVISOR_SOCKET ||
    !isProcessIdentity(value.supervisor) ||
    !["awaiting-start", "starting", "active", "terminal"].includes(value.state as string)
  ) {
    throw new Error("Invalid M3 execution manifest");
  }
}

/** Validate persisted start authorization before the supervisor creates a worker. */
export function assertM3StartAuthority(value: unknown): asserts value is M3StartAuthority {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "capabilityDigest",
      "executionId",
      "fence",
      "planDigest",
      "supervisor",
      "version",
    ]) ||
    value.version !== M3_SUPERVISOR_VERSION ||
    !isIdentifier(value.executionId) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !isDigest(value.planDigest) ||
    !isDigest(value.capabilityDigest) ||
    !isProcessIdentity(value.supervisor)
  ) {
    throw new Error("Invalid M3 start authority");
  }
}

function assertExecutionResult(value: unknown): asserts value is ExecutionResult {
  if (!isRecord(value)) {
    throw new Error("Invalid M3 terminal result");
  }
  if (value.status === "succeeded" && exactKeys(value, ["output", "status"])) {
    try {
      canonicalJson(value.output);
      return;
    } catch {
      throw new Error("Invalid M3 terminal result");
    }
  }
  if (
    value.status === "failed" &&
    exactKeys(value, ["failure", "status"]) &&
    isRecord(value.failure) &&
    exactKeys(value.failure, ["category", "message"]) &&
    [
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
    ].includes(value.failure.category as string) &&
    typeof value.failure.message === "string"
  ) {
    return;
  }
  if (
    (value.status === "blocked" || value.status === "cancelled") &&
    exactKeys(value, ["reason", "status"]) &&
    typeof value.reason === "string"
  ) {
    return;
  }
  throw new Error("Invalid M3 terminal result");
}

/** Validate bounded public terminal evidence loaded after supervisor exit. */
export function assertM3ExecutionTerminal(value: unknown): asserts value is M3ExecutionTerminal {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "cleanup",
      "events",
      "executionId",
      "fence",
      "owner",
      "result",
      "version",
    ]) ||
    value.version !== M3_SUPERVISOR_VERSION ||
    !isIdentifier(value.executionId) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !["pi", "codex", "claude-code", "command"].includes(value.owner as string) ||
    !Array.isArray(value.events) ||
    value.events.length > 256 ||
    !["confirmed", "unknown"].includes(value.cleanup as string)
  ) {
    throw new Error("Invalid M3 execution terminal record");
  }
  for (const event of value.events) {
    assertRuntimeEvent(event);
  }
  assertExecutionResult(value.result);
}

/** Validate one authenticated framed request. */
export function assertM3SupervisorRequest(value: unknown): asserts value is M3SupervisorRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["capability", "executionId", "fence", "operation", "version"]) ||
    value.version !== M3_SUPERVISOR_VERSION ||
    !["authorize", "inspect", "collect", "cancel", "release"].includes(value.operation as string) ||
    !isIdentifier(value.executionId) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    typeof value.capability !== "string"
  ) {
    throw new Error("Invalid M3 supervisor request");
  }
}

function assertM3SupervisorResponse(value: unknown): asserts value is M3SupervisorResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Invalid M3 supervisor response");
  }
  if (value.ok) {
    if (
      !exactKeys(
        value,
        value.terminal === undefined
          ? ["ok", "operation", "state"]
          : ["ok", "operation", "state", "terminal"],
      ) ||
      !["authorize", "inspect", "collect", "cancel", "release"].includes(
        value.operation as string,
      ) ||
      !["awaiting-start", "starting", "active", "terminal"].includes(value.state as string)
    ) {
      throw new Error("Invalid successful M3 supervisor response");
    }
    if (value.terminal !== undefined) {
      assertM3ExecutionTerminal(value.terminal);
    }
  } else if (
    !exactKeys(value, ["category", "message", "ok"]) ||
    !["unauthorized", "invalid-state", "invalid-request", "internal"].includes(
      value.category as string,
    ) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid failed M3 supervisor response");
  }
}

/** Encode one length-prefixed JSON frame within the reviewed protocol bound. */
export function encodeM3Frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length === 0 || payload.length > M3_SUPERVISOR_MAX_FRAME_BYTES) {
    throw new Error("M3 supervisor frame exceeds its byte limit");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Read exactly one bounded length-prefixed JSON frame from a local socket. */
export async function readM3Frame(socket: Socket): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let expectedLength: number | undefined;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      const bound =
        expectedLength === undefined ? M3_SUPERVISOR_MAX_FRAME_BYTES + 4 : expectedLength + 4;
      if (bytes.length + chunk.length > bound) {
        fail(new Error("M3 supervisor frame exceeds its byte limit"));
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && expectedLength === undefined) {
        expectedLength = bytes.readUInt32BE(0);
        if (expectedLength === 0 || expectedLength > M3_SUPERVISOR_MAX_FRAME_BYTES) {
          fail(new Error("Invalid M3 supervisor frame length"));
          return;
        }
      }
      if (expectedLength !== undefined && bytes.length > expectedLength + 4) {
        fail(new Error("M3 supervisor connection sent trailing bytes"));
      } else if (bytes.length > M3_SUPERVISOR_MAX_FRAME_BYTES + 4) {
        fail(new Error("M3 supervisor frame exceeds its byte limit"));
      }
    };
    const onEnd = () => {
      if (expectedLength === undefined || bytes.length !== expectedLength + 4) {
        fail(new Error("M3 supervisor connection ended before one complete frame"));
        return;
      }
      cleanup();
      try {
        resolve(JSON.parse(bytes.subarray(4).toString("utf8")) as unknown);
      } catch {
        reject(new Error("M3 supervisor frame did not contain valid JSON"));
      }
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("M3 supervisor connection closed before one frame"));

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function readValidatedRecord<T>(
  root: string,
  name: M3RecordName,
  validate: (value: unknown) => asserts value is T,
): Promise<T> {
  const value = await readM3Record<unknown>(root, name);
  if (value === null) {
    throw new Error(`Missing M3 protocol record: ${name}`);
  }
  validate(value);
  return value;
}

/** Load and validate the private execution capability from its fixed run-owned record. */
export function readM3ExecutionControl(root: string): Promise<M3ExecutionControl> {
  return readValidatedRecord(root, "execution-control.json", assertM3ExecutionControl);
}

/** Load and validate the sanitized execution manifest from its fixed run-owned record. */
export function readM3ExecutionManifest(root: string): Promise<M3ExecutionManifest> {
  return readValidatedRecord(root, "execution-manifest.json", assertM3ExecutionManifest);
}

/** Send one authenticated request and validate one bounded response. */
export async function requestM3Supervisor(
  root: string,
  request: M3SupervisorRequest,
  timeoutMs = 5_000,
): Promise<M3SupervisorResponse> {
  const socket = createConnection(join(root, M3_SUPERVISOR_SOCKET));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        const framedResponse = readM3Frame(socket);
        socket.end(encodeM3Frame(request));
        return framedResponse;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("M3 supervisor request timed out")), timeoutMs);
      }),
    ]);
    assertM3SupervisorResponse(response);
    return response;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    socket.destroy();
  }
}

/** Restrict the local socket to the current user after it begins listening. */
export function protectM3SupervisorSocket(root: string): Promise<void> {
  return chmod(join(root, M3_SUPERVISOR_SOCKET), 0o600);
}

/** Inspect persisted supervisor state without trusting an unauthenticated PID or manifest. */
export async function inspectPersistedM3Execution(root: string): Promise<M3PersistedInspection> {
  let manifest: M3ExecutionManifest;
  let control: M3ExecutionControl;
  try {
    [manifest, control] = await Promise.all([
      readM3ExecutionManifest(root),
      readM3ExecutionControl(root),
    ]);
    if (
      control.executionId !== manifest.executionId ||
      m3CapabilityDigest(control.capability) !== manifest.capabilityDigest ||
      (await localBootIdentityDigest()) !== manifest.bootIdentityDigest
    ) {
      return { state: "unknown", reason: "Persisted supervisor identity does not authenticate" };
    }
  } catch {
    return { state: "unknown", reason: "Persisted supervisor records are invalid" };
  }

  const supervisorLive = await matchesLiveProcess(manifest.supervisor);
  if (!supervisorLive) {
    if (manifest.state === "awaiting-start") {
      return { state: "absent", manifest };
    }
    if (manifest.state === "terminal") {
      try {
        const terminal = await readValidatedRecord(
          root,
          "execution-terminal.json",
          assertM3ExecutionTerminal,
        );
        if (
          terminal.executionId === manifest.executionId &&
          terminal.fence === manifest.fence &&
          terminal.cleanup === "confirmed"
        ) {
          return { state: "absent", manifest, terminal };
        }
      } catch {
        // A missing or invalid terminal record cannot prove absence.
      }
    }
    return {
      state: "unknown",
      manifest,
      reason: "Supervisor is absent without safe terminal proof",
    };
  }

  try {
    const response = await requestM3Supervisor(root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "inspect",
      executionId: manifest.executionId,
      fence: manifest.fence,
      capability: control.capability,
    });
    if (!response.ok) {
      return { state: "unknown", manifest, reason: "Supervisor rejected inspection" };
    }
    if (response.state === "awaiting-start") {
      return { state: "absent", manifest };
    }
    if (response.state === "terminal") {
      return response.terminal?.cleanup === "confirmed"
        ? { state: "absent", manifest, terminal: response.terminal }
        : { state: "unknown", manifest, reason: "Terminal cleanup is not confirmed" };
    }
    return { state: "active", manifest };
  } catch {
    return { state: "unknown", manifest, reason: "Supervisor could not be authenticated" };
  }
}
