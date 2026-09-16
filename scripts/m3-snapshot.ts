import { isDeepStrictEqual } from "node:util";
import {
  canonicalJson,
  digestBytes,
  type JsonValue,
  validateJsonValue,
} from "../packages/core/src/index.js";
import {
  applyRunEvent,
  replayRun,
  type RunEvent,
  type RunState,
} from "../packages/engine/src/index.js";
import { assertRunEvent } from "../packages/engine/src/event-validation.js";
import stateSchema from "./fixtures/m3-run-state.v1alpha1.json" with { type: "json" };

const snapshotVersion = "anastom.dev/m3-run-snapshot/v1alpha1";
const reducerVersion = "anastom.dev/run-reducer/v1alpha1";
const maximumStateBytes = 4_194_304;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Immutable workflow identity used to reject snapshots from another definition. */
export interface M3SnapshotDefinitionIdentity {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  definitionDigest: string;
  nodeIds: string[];
}

/** Feasibility-local folded state bound to one exact workflow and event prefix. */
export interface M3SnapshotRecord {
  version: typeof snapshotVersion;
  reducerVersion: typeof reducerVersion;
  runId: string;
  definitionDigest: string;
  sequence: number;
  stateJson: string;
  stateDigest: string;
  eventPrefixDigest: string;
}

/** Why an untrusted snapshot candidate was skipped before authoritative replay. */
export type M3SnapshotRejection =
  | "invalid-record"
  | "unknown-version"
  | "unknown-reducer"
  | "run-mismatch"
  | "definition-mismatch"
  | "sequence-out-of-range"
  | "state-too-large"
  | "state-digest-mismatch"
  | "event-prefix-mismatch"
  | "malformed-state"
  | "noncanonical-state"
  | "invalid-state"
  | "state-identity-mismatch"
  | "tail-conflict";

/** Observable loader choice; events remain authoritative in either path. */
export interface M3SnapshotLoadResult {
  state: RunState;
  source: "snapshot-tail" | "full-replay";
  snapshotSequence?: number;
  rejected: M3SnapshotRejection[];
}

interface CandidateResult {
  record?: M3SnapshotRecord;
  rejection?: M3SnapshotRejection;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function readCandidate(value: unknown): CandidateResult {
  const keys = [
    "version",
    "reducerVersion",
    "runId",
    "definitionDigest",
    "sequence",
    "stateJson",
    "stateDigest",
    "eventPrefixDigest",
  ];
  if (!isPlainRecord(value) || !hasExactKeys(value, keys)) {
    return { rejection: "invalid-record" };
  }
  if (
    typeof value.version !== "string" ||
    typeof value.reducerVersion !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.definitionDigest !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.stateJson !== "string" ||
    typeof value.stateDigest !== "string" ||
    typeof value.eventPrefixDigest !== "string" ||
    !digestPattern.test(value.definitionDigest) ||
    !digestPattern.test(value.stateDigest) ||
    !digestPattern.test(value.eventPrefixDigest)
  ) {
    return { rejection: "invalid-record" };
  }
  if (value.version !== snapshotVersion) {
    return { rejection: "unknown-version" };
  }
  if (value.reducerVersion !== reducerVersion) {
    return { rejection: "unknown-reducer" };
  }
  return { record: value as unknown as M3SnapshotRecord };
}

function assertEventEnvelope(events: readonly RunEvent[]): string {
  if (events.length === 0) {
    throw new Error("Snapshot loading requires a nonempty event stream");
  }
  const runId = events[0]?.runId;
  if (!runId) {
    throw new Error("Snapshot loading requires an event run identity");
  }
  for (const [index, event] of events.entries()) {
    assertRunEvent(event);
    if (event.runId !== runId || event.sequence !== index + 1) {
      throw new Error("Corrupt snapshot event envelope");
    }
  }
  return runId;
}

function eventPrefixDigest(events: readonly RunEvent[], sequence: number): string {
  return digestBytes(canonicalJson(events.slice(0, sequence)));
}

function stateMatchesDefinition(
  state: RunState,
  definition: M3SnapshotDefinitionIdentity,
): boolean {
  return (
    state.runId === definition.runId &&
    state.workflowId === definition.workflowId &&
    state.workflowVersion === definition.workflowVersion &&
    isDeepStrictEqual(Object.keys(state.nodes), definition.nodeIds) &&
    Object.entries(state.nodes).every(([nodeId, node]) => node.id === nodeId)
  );
}

function fullReplay(
  definition: M3SnapshotDefinitionIdentity,
  events: readonly RunEvent[],
  rejected: M3SnapshotRejection[],
): M3SnapshotLoadResult {
  const state = replayRun(events);
  if (!stateMatchesDefinition(state, definition)) {
    throw new Error("Run definition and full event replay disagree");
  }
  return { state, source: "full-replay", rejected };
}

function decodeState(record: M3SnapshotRecord): {
  state?: RunState;
  rejection?: M3SnapshotRejection;
} {
  if (Buffer.byteLength(record.stateJson) > maximumStateBytes) {
    return { rejection: "state-too-large" };
  }
  if (digestBytes(record.stateJson) !== record.stateDigest) {
    return { rejection: "state-digest-mismatch" };
  }
  let state: unknown;
  try {
    state = JSON.parse(record.stateJson) as unknown;
  } catch {
    return { rejection: "malformed-state" };
  }
  try {
    if (canonicalJson(state) !== record.stateJson) {
      return { rejection: "noncanonical-state" };
    }
  } catch {
    return { rejection: "invalid-state" };
  }
  if (!validateJsonValue(stateSchema, state as JsonValue).valid) {
    return { rejection: "invalid-state" };
  }
  return { state: state as RunState };
}

function tryCandidate(
  definition: M3SnapshotDefinitionIdentity,
  events: readonly RunEvent[],
  value: unknown,
): { state?: RunState; record?: M3SnapshotRecord; rejection?: M3SnapshotRejection } {
  const candidate = readCandidate(value);
  if (!candidate.record) {
    return { rejection: candidate.rejection ?? "invalid-record" };
  }
  const record = candidate.record;
  if (record.runId !== definition.runId) {
    return { rejection: "run-mismatch" };
  }
  if (record.definitionDigest !== definition.definitionDigest) {
    return { rejection: "definition-mismatch" };
  }
  if (record.sequence < 1 || record.sequence > events.length) {
    return { rejection: "sequence-out-of-range" };
  }
  if (eventPrefixDigest(events, record.sequence) !== record.eventPrefixDigest) {
    return { rejection: "event-prefix-mismatch" };
  }
  const decoded = decodeState(record);
  if (!decoded.state) {
    return { rejection: decoded.rejection ?? "invalid-state" };
  }
  if (
    decoded.state.sequence !== record.sequence ||
    !stateMatchesDefinition(decoded.state, definition)
  ) {
    return { rejection: "state-identity-mismatch" };
  }
  let state = decoded.state;
  try {
    for (const event of events.slice(record.sequence)) {
      state = applyRunEvent(state, event);
    }
  } catch {
    return { rejection: "tail-conflict" };
  }
  if (!stateMatchesDefinition(state, definition)) {
    return { rejection: "state-identity-mismatch" };
  }
  return { state, record };
}

/** Fold one exact event prefix into a canonical, checksummed snapshot candidate. */
export function createM3Snapshot(
  definition: M3SnapshotDefinitionIdentity,
  events: readonly RunEvent[],
  sequence: number,
): M3SnapshotRecord {
  const runId = assertEventEnvelope(events);
  if (runId !== definition.runId || sequence < 1 || sequence > events.length) {
    throw new Error("Snapshot sequence or run identity is invalid");
  }
  const state = replayRun(events.slice(0, sequence));
  if (
    !stateMatchesDefinition(state, definition) ||
    !validateJsonValue(stateSchema, state as unknown as JsonValue).valid
  ) {
    throw new Error("Snapshot projection does not match its workflow definition");
  }
  const stateJson = canonicalJson(state);
  if (Buffer.byteLength(stateJson) > maximumStateBytes) {
    throw new Error("Snapshot state exceeds the feasibility byte limit");
  }
  return {
    version: snapshotVersion,
    reducerVersion,
    runId,
    definitionDigest: definition.definitionDigest,
    sequence,
    stateJson,
    stateDigest: digestBytes(stateJson),
    eventPrefixDigest: eventPrefixDigest(events, sequence),
  };
}

/** Try newest-first candidates, then fall back to complete authoritative event replay. */
export function loadM3SnapshotProjection(
  definition: M3SnapshotDefinitionIdentity,
  events: readonly RunEvent[],
  candidatesNewestFirst: readonly unknown[],
): M3SnapshotLoadResult {
  const runId = assertEventEnvelope(events);
  if (runId !== definition.runId || !digestPattern.test(definition.definitionDigest)) {
    throw new Error("Snapshot definition identity is invalid");
  }
  const rejected: M3SnapshotRejection[] = [];
  for (const candidate of candidatesNewestFirst) {
    const result = tryCandidate(definition, events, candidate);
    if (result.state && result.record) {
      return {
        state: result.state,
        source: "snapshot-tail",
        snapshotSequence: result.record.sequence,
        rejected,
      };
    }
    rejected.push(result.rejection ?? "invalid-record");
  }
  return fullReplay(definition, events, rejected);
}
