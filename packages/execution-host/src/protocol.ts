import { timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";

import { canonicalJson, digestBytes } from "@anastom/core";
import {
  assertExecutionPlanRef,
  assertLocalProcessIdentity,
  assertPersistedExecutionRef,
  type CommandExecution,
  type ExecutionPlanRef,
  type LocalProcessIdentity,
  type PersistedExecutionRef,
} from "@anastom/engine";
import type { PrivatePathRoot } from "@anastom/path-policy";
import {
  assertExecutionResult,
  assertRuntimeEvent,
  FAILURE_CATEGORIES,
  type ExecutionFailure,
  type ExecutionResult,
  type RuntimeEvent,
} from "@anastom/runtime-contract";

import type { PrivateProcessIdentity } from "./process.js";

export const EXECUTION_PROTOCOL_VERSION = "anastom.dev/execution-supervisor/v1alpha1" as const;
export const EXECUTION_SOCKET_FRAME_MAX_BYTES = 1024 * 1024;
export const EXECUTION_LAUNCH_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const EXECUTION_PRIVATE_RECORD_MAX_BYTES = 64 * 1024;
export const EXECUTION_TERMINAL_MAX_BYTES = 4 * 1024 * 1024;
export const EXECUTION_CONNECTION_TIMEOUT_MS = 5_000;
export const EXECUTION_READY_FRAME_MAX_BYTES = 256;

/** Fixed readiness proof emitted before the runtime host accepts launch input. */
export interface RuntimeHostReady {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  type: "ready";
}

/** Private supervisor lifecycle state persisted in the manifest. */
export type ExecutionManifestState = "awaiting-start" | "starting" | "active" | "terminal";

/** Immutable private plan and coordinator identity. */
export interface ExecutionPlanRecord {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  plan: ExecutionPlanRef;
  coordinator: LocalProcessIdentity;
}

/** Private authenticated endpoint coordinates for one supervisor. */
export interface ExecutionControlRecord {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  executionId: string;
  generation: number;
  capability: string;
  endpoint: string;
}

/** Private stable identity and mutable state of one supervisor. */
export interface ExecutionManifestRecord {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  plan: ExecutionPlanRef;
  capabilityDigest: string;
  controlDigest: string;
  supervisor: PrivateProcessIdentity;
  state: ExecutionManifestState;
}

/** Immutable authorization proving the exact persisted execution may start. */
export interface ExecutionStartAuthority {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  execution: PersistedExecutionRef;
  capabilityDigest: string;
  supervisor: PrivateProcessIdentity;
}

/** JSON-safe representation of bounded command evidence. */
export interface SerializedCommandExecution {
  output: CommandExecution["output"];
  stdout: string;
  stderr: string;
  failure?: ExecutionFailure;
}

/** Private terminal record retained after worker cleanup. */
export interface ExecutionTerminalRecord {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  executionId: string;
  generation: number;
  outcome: "succeeded" | "failed" | "blocked" | "cancelled";
  events: RuntimeEvent[];
  result:
    | { kind: "runtime"; value: ExecutionResult }
    | { kind: "command"; value: SerializedCommandExecution };
  cleanup: "confirmed" | "unknown";
}

/** Authenticated operation accepted by the private supervisor. */
export type SupervisorOperation =
  "authorize" | "inspect" | "events" | "collect" | "terminate" | "release";

/** One bounded request sent to an exact private supervisor. */
export interface SupervisorRequest {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  operation: SupervisorOperation;
  executionId: string;
  generation: number;
  capability: string;
  cursor?: number;
}

/** Bounded supervisor response containing normalized observations only. */
export type SupervisorResponse =
  | {
      ok: true;
      operation: SupervisorOperation;
      state: ExecutionManifestState;
      events?: RuntimeEvent[];
      nextCursor?: number;
      terminalAvailable?: boolean;
    }
  | {
      ok: false;
      category: "unauthorized" | "invalid-state" | "invalid-request" | "internal";
      message: string;
    };

/** Normalized frame emitted by the isolated runtime-host process. */
export type RuntimeHostOutput =
  | { type: "event"; event: RuntimeEvent }
  | { type: "runtime-result"; result: ExecutionResult }
  | { type: "command-result"; result: SerializedCommandExecution };

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const capabilityPattern = /^[a-zA-Z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
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

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function assertPrivateProcessIdentity(value: unknown): asserts value is PrivateProcessIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "bootIdentityDigest",
      "hostIdentityDigest",
      "pid",
      "processGroupId",
      "startToken",
      "state",
      "version",
    ]) ||
    !positive(value.processGroupId) ||
    typeof value.state !== "string" ||
    !value.state
  ) {
    throw new TypeError("Invalid private process identity");
  }
  assertLocalProcessIdentity({
    version: value.version,
    hostIdentityDigest: value.hostIdentityDigest,
    bootIdentityDigest: value.bootIdentityDigest,
    pid: value.pid,
    startToken: value.startToken,
  });
}

/** Digest a private capability before binding it into persistent identity. */
export function executionCapabilityDigest(capability: string): string {
  return digestBytes(`anastom.dev/execution-capability/v1alpha1\n${capability}`);
}

/** Compare private capabilities without content-dependent comparison timing. */
export function matchesExecutionCapability(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Digest the stable fields of a manifest independently of lifecycle state. */
export function executionManifestDigest(manifest: ExecutionManifestRecord): string {
  return digestBytes(
    canonicalJson({
      version: manifest.version,
      plan: manifest.plan,
      capabilityDigest: manifest.capabilityDigest,
      controlDigest: manifest.controlDigest,
      supervisor: manifest.supervisor,
    }),
  );
}

/** Validate an exact private plan record. */
export function assertExecutionPlanRecord(value: unknown): asserts value is ExecutionPlanRecord {
  if (!isRecord(value) || !exactKeys(value, ["coordinator", "plan", "version"])) {
    throw new TypeError("Invalid execution plan record");
  }
  if (value.version !== EXECUTION_PROTOCOL_VERSION) {
    throw new TypeError("Unknown execution plan record version");
  }
  assertExecutionPlanRef(value.plan as ExecutionPlanRef);
  assertLocalProcessIdentity(value.coordinator);
}

/** Validate exact private supervisor control coordinates. */
export function assertExecutionControlRecord(
  value: unknown,
): asserts value is ExecutionControlRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["capability", "endpoint", "executionId", "generation", "version"]) ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    typeof value.executionId !== "string" ||
    !positive(value.generation) ||
    typeof value.capability !== "string" ||
    !capabilityPattern.test(value.capability) ||
    typeof value.endpoint !== "string" ||
    !value.endpoint ||
    Buffer.byteLength(value.endpoint) > 100
  ) {
    throw new TypeError("Invalid execution control record");
  }
}

/** Validate an exact private supervisor manifest. */
export function assertExecutionManifestRecord(
  value: unknown,
): asserts value is ExecutionManifestRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "capabilityDigest",
      "controlDigest",
      "plan",
      "state",
      "supervisor",
      "version",
    ]) ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    typeof value.capabilityDigest !== "string" ||
    !digestPattern.test(value.capabilityDigest) ||
    typeof value.controlDigest !== "string" ||
    !digestPattern.test(value.controlDigest) ||
    !["awaiting-start", "starting", "active", "terminal"].includes(value.state as string)
  ) {
    throw new TypeError("Invalid execution manifest record");
  }
  assertExecutionPlanRef(value.plan as ExecutionPlanRef);
  assertPrivateProcessIdentity(value.supervisor);
}

/** Validate immutable start authorization for one persisted execution. */
export function assertExecutionStartAuthority(
  value: unknown,
): asserts value is ExecutionStartAuthority {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["capabilityDigest", "execution", "supervisor", "version"]) ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    typeof value.capabilityDigest !== "string" ||
    !digestPattern.test(value.capabilityDigest)
  ) {
    throw new TypeError("Invalid execution start authority");
  }
  assertPersistedExecutionRef(value.execution as PersistedExecutionRef);
  assertPrivateProcessIdentity(value.supervisor);
}

function assertCommandReport(value: unknown): asserts value is CommandExecution["output"] {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "durationMs",
      "exitCode",
      "passed",
      "signal",
      "stderrBytes",
      "stderrTruncated",
      "stdoutBytes",
      "stdoutTruncated",
    ]) ||
    typeof value.passed !== "boolean" ||
    (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) ||
    (value.signal !== null && typeof value.signal !== "string") ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    typeof value.stdoutBytes !== "number" ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    value.stdoutBytes < 0 ||
    typeof value.stderrBytes !== "number" ||
    !Number.isSafeInteger(value.stderrBytes) ||
    value.stderrBytes < 0 ||
    typeof value.stdoutTruncated !== "boolean" ||
    typeof value.stderrTruncated !== "boolean"
  ) {
    throw new TypeError("Invalid command report");
  }
}

function assertFailure(value: unknown): asserts value is ExecutionFailure {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["category", "message"]) ||
    typeof value.category !== "string" ||
    !FAILURE_CATEGORIES.includes(value.category as (typeof FAILURE_CATEGORIES)[number]) ||
    typeof value.message !== "string"
  ) {
    throw new TypeError("Invalid command failure");
  }
}

/** Validate a serialized command execution without accepting extra fields. */
export function assertSerializedCommandExecution(
  value: unknown,
): asserts value is SerializedCommandExecution {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["output", "stderr", "stdout"], ["failure"]) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw new TypeError("Invalid serialized command execution");
  }
  assertCommandReport(value.output);
  if (value.failure !== undefined) {
    assertFailure(value.failure);
  }
  const stdout = Buffer.from(value.stdout, "base64");
  const stderr = Buffer.from(value.stderr, "base64");
  if (stdout.toString("base64") !== value.stdout || stderr.toString("base64") !== value.stderr) {
    throw new TypeError("Invalid command output encoding");
  }
}

/** Validate exact terminal evidence produced by the private supervisor. */
export function assertExecutionTerminalRecord(
  value: unknown,
): asserts value is ExecutionTerminalRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "cleanup",
      "events",
      "executionId",
      "generation",
      "outcome",
      "result",
      "version",
    ]) ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    typeof value.executionId !== "string" ||
    !positive(value.generation) ||
    !["succeeded", "failed", "blocked", "cancelled"].includes(value.outcome as string) ||
    (value.cleanup !== "confirmed" && value.cleanup !== "unknown") ||
    !Array.isArray(value.events) ||
    value.events.length > 256 ||
    !isRecord(value.result) ||
    !exactKeys(value.result, ["kind", "value"])
  ) {
    throw new TypeError("Invalid execution terminal record");
  }
  value.events.forEach(assertRuntimeEvent);
  if (value.result.kind === "runtime") {
    assertExecutionResult(value.result.value);
  } else if (value.result.kind === "command") {
    assertSerializedCommandExecution(value.result.value);
  } else {
    throw new TypeError("Invalid execution terminal result kind");
  }
}

/** Validate a bounded authenticated supervisor request. */
export function assertSupervisorRequest(value: unknown): asserts value is SupervisorRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["capability", "executionId", "generation", "operation", "version"],
      ["cursor"],
    ) ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    !["authorize", "inspect", "events", "collect", "terminate", "release"].includes(
      value.operation as string,
    ) ||
    typeof value.executionId !== "string" ||
    !positive(value.generation) ||
    typeof value.capability !== "string" ||
    !capabilityPattern.test(value.capability) ||
    (value.cursor !== undefined &&
      (!Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0))
  ) {
    throw new TypeError("Invalid supervisor request");
  }
}

/** Validate one normalized supervisor response. */
export function assertSupervisorResponse(value: unknown): asserts value is SupervisorResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Invalid supervisor response");
  }
  if (value.ok) {
    if (
      !hasOnlyKeys(
        value,
        ["ok", "operation", "state"],
        ["events", "nextCursor", "terminalAvailable"],
      ) ||
      !["authorize", "inspect", "events", "collect", "terminate", "release"].includes(
        value.operation as string,
      ) ||
      !["awaiting-start", "starting", "active", "terminal"].includes(value.state as string) ||
      (value.events !== undefined &&
        (!Array.isArray(value.events) ||
          value.events.some((event) => !validRuntimeEvent(event)))) ||
      (value.nextCursor !== undefined &&
        (typeof value.nextCursor !== "number" ||
          !Number.isSafeInteger(value.nextCursor) ||
          value.nextCursor < 0)) ||
      (value.terminalAvailable !== undefined && typeof value.terminalAvailable !== "boolean")
    ) {
      throw new TypeError("Invalid successful supervisor response");
    }
  } else if (
    !exactKeys(value, ["category", "message", "ok"]) ||
    !["unauthorized", "invalid-state", "invalid-request", "internal"].includes(
      value.category as string,
    ) ||
    typeof value.message !== "string"
  ) {
    throw new TypeError("Invalid failed supervisor response");
  }
}

function validRuntimeEvent(value: unknown): boolean {
  try {
    assertRuntimeEvent(value);
    return Buffer.byteLength(canonicalJson(value)) <= EXECUTION_PRIVATE_RECORD_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Validate a normalized output frame from the isolated runtime host. */
export function assertRuntimeHostOutput(value: unknown): asserts value is RuntimeHostOutput {
  if (!isRecord(value)) {
    throw new TypeError("Invalid runtime-host output");
  }
  if (value.type === "event" && exactKeys(value, ["event", "type"])) {
    assertRuntimeEvent(value.event);
    if (!validRuntimeEvent(value.event)) {
      throw new RangeError("Runtime event exceeds 64 KiB");
    }
    return;
  }
  if (value.type === "runtime-result" && exactKeys(value, ["result", "type"])) {
    assertExecutionResult(value.result);
    return;
  }
  if (value.type === "command-result" && exactKeys(value, ["result", "type"])) {
    assertSerializedCommandExecution(value.result);
    return;
  }
  throw new TypeError("Invalid runtime-host output");
}

/** Validate the isolated runtime host's pre-launch readiness proof. */
export function assertRuntimeHostReady(value: unknown): asserts value is RuntimeHostReady {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["type", "version"]) ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    value.type !== "ready"
  ) {
    throw new TypeError("Invalid runtime-host readiness proof");
  }
}

/** Encode one canonical length-prefixed JSON frame under a byte limit. */
export function encodeFrame(value: unknown, maxBytes: number): Buffer {
  const payload = Buffer.from(canonicalJson(value));
  if (payload.length < 1 || payload.length > maxBytes) {
    throw new RangeError("Protocol frame exceeds its byte limit");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Read exactly one framed value from a stream that must then end. */
export async function readEndedFrame(stream: Readable, maxBytes: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes + 4) {
        cleanup();
        reject(new RangeError("Protocol frame exceeds its byte limit"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(decodeFrame(Buffer.concat(chunks), maxBytes));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Protocol frame decoding failed"));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Protocol stream closed before it ended"));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

/** Read the first complete frame while leaving the stream open. */
export async function readInitialFrame(stream: Readable, maxBytes: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let expected: number | undefined;
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > maxBytes + 4) {
        cleanup();
        reject(new RangeError("Protocol frame exceeds its byte limit"));
        return;
      }
      if (bytes.length >= 4 && expected === undefined) {
        expected = bytes.readUInt32BE(0);
        if (expected < 1 || expected > maxBytes) {
          cleanup();
          reject(new RangeError("Invalid protocol frame length"));
          return;
        }
      }
      if (expected !== undefined && bytes.length >= expected + 4) {
        cleanup();
        try {
          resolve(decodeFrame(bytes, maxBytes));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Protocol frame decoding failed"));
        }
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Protocol stream ended before a complete frame"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Protocol stream closed before a complete frame"));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

/** Incrementally decode bounded length-prefixed JSON frames. */
export class FrameDecoder {
  private bytes = Buffer.alloc(0);

  /** Configure the maximum payload size accepted by this decoder. */
  constructor(private readonly maxBytes: number) {}

  /** Append bytes and return every complete decoded value. */
  push(chunk: Buffer): unknown[] {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const values: unknown[] = [];
    while (this.bytes.length >= 4) {
      const size = this.bytes.readUInt32BE(0);
      if (size < 1 || size > this.maxBytes) {
        throw new RangeError("Invalid protocol frame length");
      }
      if (this.bytes.length < size + 4) {
        break;
      }
      values.push(decodeFrame(this.bytes.subarray(0, size + 4), this.maxBytes));
      this.bytes = this.bytes.subarray(size + 4);
    }
    if (this.bytes.length > this.maxBytes + 4) {
      throw new RangeError("Protocol frame exceeds its byte limit");
    }
    return values;
  }

  /** Assert that the stream ended between frames. */
  finish(): void {
    if (this.bytes.length !== 0) {
      throw new Error("Protocol stream ended with a partial frame");
    }
  }
}

function decodeFrame(frame: Buffer, maxBytes: number): unknown {
  if (frame.length < 5) {
    throw new Error("Protocol frame is incomplete");
  }
  const size = frame.readUInt32BE(0);
  if (size < 1 || size > maxBytes || frame.length !== size + 4) {
    throw new Error("Protocol frame length does not match its payload");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4));
  return JSON.parse(text) as unknown;
}

/** Read, decode, and validate a bounded record through the private path root. */
export async function readRecord<T>(
  root: PrivatePathRoot,
  segments: readonly string[],
  maxBytes: number,
  validate: (value: unknown) => asserts value is T,
): Promise<T> {
  const bytes = await root.readFile(segments, { maxBytes });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  validate(value);
  return value;
}

/** Atomically replace a bounded private JSON record. */
export async function writeRecordAtomic(
  root: PrivatePathRoot,
  segments: readonly string[],
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value));
  await root.writeFileAtomic(segments, bytes, { maxBytes });
}

/** Exclusively create a bounded immutable private JSON record. */
export async function writeRecordExclusive(
  root: PrivatePathRoot,
  segments: readonly string[],
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value));
  await root.writeFileExclusive(segments, bytes, { maxBytes });
}

/** Serialize command buffers into canonical private JSON evidence. */
export function commandExecutionToRecord(execution: CommandExecution): SerializedCommandExecution {
  return {
    output: structuredClone(execution.output),
    stdout: execution.stdout.toString("base64"),
    stderr: execution.stderr.toString("base64"),
    ...(execution.failure ? { failure: structuredClone(execution.failure) } : {}),
  };
}

/** Reconstruct bounded command evidence from its validated private record. */
export function commandExecutionFromRecord(
  execution: SerializedCommandExecution,
): CommandExecution {
  assertSerializedCommandExecution(execution);
  return {
    output: structuredClone(execution.output),
    stdout: Buffer.from(execution.stdout, "base64"),
    stderr: Buffer.from(execution.stderr, "base64"),
    ...(execution.failure ? { failure: structuredClone(execution.failure) } : {}),
  };
}

/** Write one framed value and wait for stream acceptance. */
export async function writeFrame(
  stream: Writable,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const frame = encodeFrame(value, maxBytes);
  await new Promise<void>((resolve, reject) => {
    stream.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}
