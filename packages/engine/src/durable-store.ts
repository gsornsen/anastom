import { isDeepStrictEqual } from "node:util";

import {
  assertWorkflowDefinition,
  canonicalJson,
  digestBytes,
  digestJson,
  type WorkflowDefinition,
} from "@anastom/core";

import { applyRunEvent, replayRun, type RunEvent, type RunState } from "./events.js";

/** Production lease duration; coordinators renew no later than every five seconds. */
export const RUN_LEASE_DURATION_MS = 15_000;
/** Maximum canonical state bytes accepted in a rebuildable snapshot. */
export const RUN_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** Initial domain-separated digest for an empty event history. */
export const EMPTY_EVENT_HISTORY_DIGEST = digestBytes("anastom.dev/event-history/v1alpha1\n");

/** Sanitized local process identity used as evidence when deciding lease takeover. */
export interface LocalProcessIdentity {
  version: "anastom.dev/local-process/v1alpha1";
  hostIdentityDigest: string;
  bootIdentityDigest: string;
  pid: number;
  startToken: string;
}

/** Current durable ownership record for one run. */
export interface RunLease {
  runId: string;
  ownerId: string;
  owner: LocalProcessIdentity;
  generation: number;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
  released: boolean;
}

/** Minimal fence supplied to every owned mutation. */
export interface RunLeaseToken {
  runId: string;
  ownerId: string;
  generation: number;
}

/** Model-free observation of the process recorded in a lease. */
export type ProcessObservation =
  | { state: "alive"; observedAtMs: number }
  | { state: "absent"; observedAtMs: number }
  | { state: "unknown"; observedAtMs: number; reason: string };

/** Rebuildable, integrity-bound materialized run state. */
export interface RunSnapshot {
  version: "anastom.dev/run-snapshot/v1alpha1";
  reducerVersion: "anastom.dev/run-reducer/v1alpha1";
  runId: string;
  definitionDigest: string;
  sequence: number;
  stateJson: string;
  stateDigest: string;
  eventPrefixDigest: string;
}

/** Inputs needed to create a run and acquire its first lease atomically. */
export interface CreateOwnedRun {
  runId: string;
  workflow: WorkflowDefinition;
  initialEvents: readonly RunEvent[];
  ownerId: string;
  owner: LocalProcessIdentity;
  operationId: string;
  snapshot: RunSnapshot;
}

/** Receipt for atomic creation, including the first fence and mutation receipt. */
export interface OwnedRunReceipt {
  lease: RunLeaseToken;
  mutation: MutationReceipt;
}

/** Execution-oriented load result with folded state and snapshot provenance. */
export interface LoadedRun {
  workflow: WorkflowDefinition;
  state: RunState;
  eventPrefixDigest: string;
  snapshotSource: "snapshot-tail" | "full-replay";
  snapshotSequence?: number;
}

/** Inspection-oriented load result retaining the complete authoritative history. */
export interface LoadedRunWithHistory extends LoadedRun {
  events: RunEvent[];
}

/** Inputs for claiming an explicitly released run. */
export interface AcquireReleasedRun {
  runId: string;
  ownerId: string;
  owner: LocalProcessIdentity;
}

/** Inputs for taking over an expired lease after independently proving owner absence. */
export interface TakeoverExpiredRun extends AcquireReleasedRun {
  observedLease: RunLease;
  ownerAbsence: Extract<ProcessObservation, { state: "absent" }>;
}

/** One fenced, idempotent append and its optional cache/control effects. */
export interface FencedRunMutation {
  lease: RunLeaseToken;
  operationId: string;
  expectedSequence: number;
  events: readonly RunEvent[];
  snapshot?: RunSnapshot;
  handlesControlOperationId?: string;
}

/** Stable identity and sequence range for a committed mutation. */
export interface MutationReceipt {
  runId: string;
  operationId: string;
  firstSequence: number;
  lastSequence: number;
  replayed: boolean;
}

/** Idempotent operator control request submitted without acquiring a lease. */
export interface ControlSubmission {
  runId: string;
  operationId: string;
  action: "pause" | "cancel";
}

/** Persisted operator request ordered by its store-assigned timestamp. */
export interface ControlRequest extends ControlSubmission {
  recordedAtMs: number;
}

/** Submission result distinguishing a new request from an idempotent replay. */
export interface ControlReceipt extends ControlRequest {
  replayed: boolean;
}

/** Engine-owned durable storage boundary for fenced execution and recovery. */
export interface DurableRunStore {
  /** Atomically create immutable history, generation-one ownership, and its initial cache. */
  createOwned(input: CreateOwnedRun): Promise<OwnedRunReceipt>;
  /** Load validated folded state for execution without returning the complete event array. */
  load(runId: string, mode: "execution"): Promise<LoadedRun | null>;
  /** Load validated folded state and complete authoritative history for inspection. */
  load(runId: string, mode: "complete-history"): Promise<LoadedRunWithHistory | null>;
  /** Inspect current ownership without changing its lease or contacting the owner process. */
  inspectLease(runId: string): Promise<RunLease | null>;
  /** Acquire only an explicitly released lease. */
  acquireReleased(input: AcquireReleasedRun): Promise<RunLeaseToken>;
  /** Take over an exact expired lease after a contemporaneous absent-owner observation. */
  takeoverExpired(input: TakeoverExpiredRun): Promise<RunLeaseToken>;
  /** Extend the matching active lease using the store's transaction clock. */
  renew(token: RunLeaseToken): Promise<RunLease>;
  /** Release the matching current generation without deleting ownership evidence. */
  release(token: RunLeaseToken): Promise<void>;
  /** Atomically apply a fenced idempotent event batch and optional derived effects. */
  commit(input: FencedRunMutation): Promise<MutationReceipt>;
  /** Submit or idempotently replay an operator control without acquiring ownership. */
  submitControl(input: ControlSubmission): Promise<ControlReceipt>;
  /** Return unacknowledged controls oldest first, bounded to at most 100 records. */
  pendingControls(runId: string, limit?: number): Promise<ControlRequest[]>;
}

/** Stable operational failure classifications for durable run-store callers. */
export type RunStoreErrorCode =
  | "not-found"
  | "ownership-conflict"
  | "lease-expired"
  | "sequence-conflict"
  | "idempotency-conflict"
  | "control-conflict"
  | "busy"
  | "corrupt-store";

/** Expected durable-store failure whose code, rather than text, drives control flow. */
export class RunStoreError extends Error {
  /** Stable machine-readable conflict or corruption classification. */
  readonly code: RunStoreErrorCode;

  /** Construct a classified store error with diagnostic text for operators. */
  constructor(code: RunStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunStoreError";
    this.code = code;
  }
}

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;

function assertIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Invalid ${label}`);
  }
}

/** Validate a local identity before it can enter an ownership record. */
export function assertLocalProcessIdentity(value: unknown): asserts value is LocalProcessIdentity {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Invalid local process identity");
  }
  const identity = value as Partial<LocalProcessIdentity>;
  if (
    Object.keys(identity).sort().join(",") !==
      "bootIdentityDigest,hostIdentityDigest,pid,startToken,version" ||
    identity.version !== "anastom.dev/local-process/v1alpha1" ||
    typeof identity.hostIdentityDigest !== "string" ||
    !digest.test(identity.hostIdentityDigest) ||
    typeof identity.bootIdentityDigest !== "string" ||
    !digest.test(identity.bootIdentityDigest) ||
    !Number.isSafeInteger(identity.pid) ||
    (identity.pid ?? 0) < 1 ||
    typeof identity.startToken !== "string" ||
    identity.startToken.length < 1 ||
    Buffer.byteLength(identity.startToken) > 256 ||
    identity.startToken.includes("\0")
  ) {
    throw new TypeError("Invalid local process identity");
  }
}

/** Validate a lease token at a trust boundary. */
export function assertRunLeaseToken(value: RunLeaseToken): void {
  assertIdentifier(value.runId, "run ID");
  if (!uuid.test(value.ownerId)) {
    throw new TypeError("Invalid owner ID");
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new TypeError("Invalid lease generation");
  }
}

/** Validate a complete lease record loaded from untrusted persistence. */
export function assertRunLease(value: unknown): asserts value is RunLease {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Invalid run lease");
  }
  const lease = value as Partial<RunLease>;
  if (
    Object.keys(lease).sort().join(",") !==
      "acquiredAtMs,expiresAtMs,generation,owner,ownerId,released,renewedAtMs,runId" ||
    typeof lease.runId !== "string" ||
    typeof lease.ownerId !== "string" ||
    typeof lease.released !== "boolean"
  ) {
    throw new TypeError("Invalid run lease");
  }
  assertRunLeaseToken({
    runId: lease.runId,
    ownerId: lease.ownerId,
    generation: lease.generation ?? 0,
  });
  assertLocalProcessIdentity(lease.owner);
  assertTimestamp(lease.acquiredAtMs ?? -1, "lease acquisition time");
  assertTimestamp(lease.renewedAtMs ?? -1, "lease renewal time");
  assertTimestamp(lease.expiresAtMs ?? -1, "lease expiry time");
  if (lease.renewedAtMs! < lease.acquiredAtMs! || lease.expiresAtMs! < lease.renewedAtMs!) {
    throw new TypeError("Invalid lease time ordering");
  }
}

/** Calculate the next domain-separated cumulative digest from exact event JSON bytes. */
export function extendEventHistoryDigest(input: {
  previous: string;
  runId: string;
  sequence: number;
  eventType: string;
  eventJson: string;
}): { eventDigest: string; historyDigest: string } {
  const eventDigest = digestBytes(input.eventJson);
  return {
    eventDigest,
    historyDigest: digestJson({
      version: "anastom.dev/event-history/v1alpha1",
      previous: input.previous,
      runId: input.runId,
      sequence: input.sequence,
      eventType: input.eventType,
      eventDigest,
    }),
  };
}

/** Build the snapshot cache record for an already validated event prefix. */
export function createRunSnapshot(
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
): RunSnapshot {
  assertWorkflowDefinition(workflow);
  const state = replayRun(events);
  assertStateMatchesWorkflow(state, workflow);
  let eventPrefixDigest = EMPTY_EVENT_HISTORY_DIGEST;
  for (const event of events) {
    eventPrefixDigest = extendEventHistoryDigest({
      previous: eventPrefixDigest,
      runId: event.runId,
      sequence: event.sequence,
      eventType: event.type,
      eventJson: canonicalJson(event),
    }).historyDigest;
  }
  return createRunSnapshotFromState(workflow, state, eventPrefixDigest);
}

/** Build a snapshot from validated folded state and its exact cumulative event-prefix digest. */
export function createRunSnapshotFromState(
  workflow: WorkflowDefinition,
  state: RunState,
  eventPrefixDigest: string,
): RunSnapshot {
  assertWorkflowDefinition(workflow);
  assertStateMatchesWorkflow(state, workflow);
  if (!digest.test(eventPrefixDigest)) {
    throw new TypeError("Invalid event-prefix digest");
  }
  const stateJson = canonicalJson(state);
  if (Buffer.byteLength(stateJson) > RUN_SNAPSHOT_MAX_BYTES) {
    throw new RangeError("Run snapshot exceeds the 4 MiB limit");
  }
  return {
    version: "anastom.dev/run-snapshot/v1alpha1",
    reducerVersion: "anastom.dev/run-reducer/v1alpha1",
    runId: state.runId,
    definitionDigest: digestJson(workflow),
    sequence: state.sequence,
    stateJson,
    stateDigest: digestBytes(stateJson),
    eventPrefixDigest,
  };
}

/** Validate a supplied snapshot against a definition, authoritative prefix, and folded state. */
export function assertRunSnapshot(
  snapshot: RunSnapshot,
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
): void {
  const expected = createRunSnapshot(workflow, events);
  if (!isDeepStrictEqual(snapshot, expected)) {
    throw new TypeError("Run snapshot does not match its authoritative event prefix");
  }
}

/** Validate that replayed workflow identity and node membership match the immutable definition. */
export function assertStateMatchesWorkflow(state: RunState, workflow: WorkflowDefinition): void {
  const stateNodeIds = Object.keys(state.nodes).sort();
  const workflowNodeIds = [...workflow.nodeOrder].sort();
  if (
    state.workflowId !== workflow.metadata.id ||
    state.workflowVersion !== workflow.metadata.version ||
    !isDeepStrictEqual(stateNodeIds, workflowNodeIds)
  ) {
    throw new TypeError("Run definition and history disagree");
  }
}

interface MemoryMutation {
  payloadDigest: string;
  receipt: MutationReceipt;
}

interface MemoryControl extends ControlRequest {
  acknowledgedSequence?: number;
}

interface MemoryRun {
  workflow: WorkflowDefinition;
  events: RunEvent[];
  lease: RunLease;
  mutations: Map<string, MemoryMutation>;
  controls: Map<string, MemoryControl>;
  snapshots: RunSnapshot[];
}

function mutationPayloadDigest(input: FencedRunMutation): string {
  const snapshot = input.snapshot;
  return digestJson({
    expectedSequence: input.expectedSequence,
    events: input.events,
    snapshot:
      snapshot === undefined
        ? null
        : {
            version: snapshot.version,
            reducerVersion: snapshot.reducerVersion,
            runId: snapshot.runId,
            definitionDigest: snapshot.definitionDigest,
            sequence: snapshot.sequence,
            stateDigest: snapshot.stateDigest,
            eventPrefixDigest: snapshot.eventPrefixDigest,
          },
    handlesControlOperationId: input.handlesControlOperationId ?? null,
  });
}

function tokenFor(lease: RunLease): RunLeaseToken {
  return { runId: lease.runId, ownerId: lease.ownerId, generation: lease.generation };
}

function validateClock(clock: () => number): number {
  const now = clock();
  assertTimestamp(now, "store clock");
  return now;
}

function leaseExpiry(now: number): number {
  const expiresAtMs = now + RUN_LEASE_DURATION_MS;
  assertTimestamp(expiresAtMs, "lease expiry time");
  return expiresAtMs;
}

function nextGeneration(generation: number): number {
  const next = generation + 1;
  if (!Number.isSafeInteger(next)) {
    throw new RunStoreError("corrupt-store", "Lease generation cannot be advanced safely");
  }
  return next;
}

function assertAbsentObservation(value: TakeoverExpiredRun["ownerAbsence"]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "observedAtMs,state" ||
    value.state !== "absent"
  ) {
    throw new TypeError("Invalid absent-owner observation");
  }
  assertTimestamp(value.observedAtMs, "owner observation time");
}

/** Process-local reference implementation of the durable lease and fencing contract. */
export class InMemoryDurableRunStore implements DurableRunStore {
  private readonly runs = new Map<string, MemoryRun>();
  private readonly clock: () => number;

  /** Create a deterministic store; tests may inject a millisecond clock. */
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Create the immutable run, first lease, mutation receipt, integrity, and snapshot atomically. */
  async createOwned(input: CreateOwnedRun): Promise<OwnedRunReceipt> {
    validateCreateOwnedRun(input);
    if (this.runs.has(input.runId)) {
      throw new RunStoreError("ownership-conflict", `Run ${input.runId} already exists`);
    }
    const now = validateClock(this.clock);
    const lease: RunLease = {
      runId: input.runId,
      ownerId: input.ownerId,
      owner: structuredClone(input.owner),
      generation: 1,
      acquiredAtMs: now,
      renewedAtMs: now,
      expiresAtMs: leaseExpiry(now),
      released: false,
    };
    const receipt: MutationReceipt = {
      runId: input.runId,
      operationId: input.operationId,
      firstSequence: 1,
      lastSequence: input.initialEvents.length,
      replayed: false,
    };
    const mutation: FencedRunMutation = {
      lease: tokenFor(lease),
      operationId: input.operationId,
      expectedSequence: 0,
      events: input.initialEvents,
      snapshot: input.snapshot,
    };
    this.runs.set(input.runId, {
      workflow: structuredClone(input.workflow),
      events: [...structuredClone(input.initialEvents)],
      lease,
      mutations: new Map([
        [input.operationId, { payloadDigest: mutationPayloadDigest(mutation), receipt }],
      ]),
      controls: new Map(),
      snapshots: [structuredClone(input.snapshot)],
    });
    return { lease: tokenFor(lease), mutation: structuredClone(receipt) };
  }

  /** Load folded state for execution without returning complete events. */
  async load(runId: string, mode: "execution"): Promise<LoadedRun | null>;
  /** Load folded state plus the complete validated event history for inspection. */
  async load(runId: string, mode: "complete-history"): Promise<LoadedRunWithHistory | null>;
  async load(
    runId: string,
    mode: "execution" | "complete-history",
  ): Promise<LoadedRun | LoadedRunWithHistory | null> {
    assertIdentifier(runId, "run ID");
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }
    const workflow = structuredClone(run.workflow);
    const events = structuredClone(run.events);
    const state = replayRun(events);
    assertStateMatchesWorkflow(state, workflow);
    const digestValue = createRunSnapshot(workflow, events).eventPrefixDigest;
    const compatible = [...run.snapshots]
      .sort((left, right) => right.sequence - left.sequence)
      .find((snapshot) => snapshotCompatible(snapshot, workflow, events, state));
    return {
      workflow,
      state,
      eventPrefixDigest: digestValue,
      snapshotSource: compatible ? "snapshot-tail" : "full-replay",
      ...(compatible ? { snapshotSequence: compatible.sequence } : {}),
      ...(mode === "complete-history" ? { events } : {}),
    };
  }

  /** Return the current lease without changing ownership. */
  async inspectLease(runId: string): Promise<RunLease | null> {
    assertIdentifier(runId, "run ID");
    return structuredClone(this.runs.get(runId)?.lease ?? null);
  }

  /** Acquire only an explicitly released lease. */
  async acquireReleased(input: AcquireReleasedRun): Promise<RunLeaseToken> {
    validateAcquisition(input);
    const run = this.requireRun(input.runId);
    if (!run.lease.released) {
      throw new RunStoreError("ownership-conflict", `Run ${input.runId} is still owned`);
    }
    const now = validateClock(this.clock);
    run.lease = {
      runId: input.runId,
      ownerId: input.ownerId,
      owner: structuredClone(input.owner),
      generation: nextGeneration(run.lease.generation),
      acquiredAtMs: now,
      renewedAtMs: now,
      expiresAtMs: leaseExpiry(now),
      released: false,
    };
    return tokenFor(run.lease);
  }

  /** Take over the exact expired lease only after an explicit absent-owner observation. */
  async takeoverExpired(input: TakeoverExpiredRun): Promise<RunLeaseToken> {
    validateAcquisition(input);
    assertRunLease(input.observedLease);
    assertAbsentObservation(input.ownerAbsence);
    const run = this.requireRun(input.runId);
    const current = run.lease;
    const now = validateClock(this.clock);
    if (!current || !isDeepStrictEqual(current, input.observedLease) || current.released) {
      throw new RunStoreError("ownership-conflict", "The observed lease is no longer current");
    }
    if (current.expiresAtMs > now) {
      throw new RunStoreError("ownership-conflict", "The observed lease has not expired");
    }
    if (
      input.ownerAbsence.observedAtMs < current.expiresAtMs ||
      input.ownerAbsence.observedAtMs > now
    ) {
      throw new RunStoreError(
        "ownership-conflict",
        "Owner absence was not observed after expiry using the current store clock",
      );
    }
    run.lease = {
      runId: input.runId,
      ownerId: input.ownerId,
      owner: structuredClone(input.owner),
      generation: nextGeneration(current.generation),
      acquiredAtMs: now,
      renewedAtMs: now,
      expiresAtMs: leaseExpiry(now),
      released: false,
    };
    return tokenFor(run.lease);
  }

  /** Extend an active matching lease using the store clock. */
  async renew(token: RunLeaseToken): Promise<RunLease> {
    assertRunLeaseToken(token);
    const run = this.requireRun(token.runId);
    const now = validateClock(this.clock);
    const lease = requireFence(run, token, now);
    lease.renewedAtMs = Math.max(now, lease.renewedAtMs);
    lease.expiresAtMs = leaseExpiry(lease.renewedAtMs);
    return structuredClone(lease);
  }

  /** Release the matching current generation; retrying the same release is harmless. */
  async release(token: RunLeaseToken): Promise<void> {
    assertRunLeaseToken(token);
    const run = this.requireRun(token.runId);
    const lease = run.lease;
    if (!lease || lease.ownerId !== token.ownerId || lease.generation !== token.generation) {
      throw new RunStoreError("ownership-conflict", "Lease token is stale");
    }
    lease.released = true;
  }

  /** Commit a fenced idempotent event batch, optional snapshot, and control acknowledgement. */
  async commit(input: FencedRunMutation): Promise<MutationReceipt> {
    validateMutation(input);
    const run = this.requireRun(input.lease.runId);
    requireFence(run, input.lease, validateClock(this.clock));
    const payloadDigest = mutationPayloadDigest(input);
    const prior = run.mutations.get(input.operationId);
    if (prior) {
      if (prior.payloadDigest !== payloadDigest) {
        throw new RunStoreError("idempotency-conflict", "Operation payload changed on retry");
      }
      return { ...structuredClone(prior.receipt), replayed: true };
    }
    const actual = run.events.at(-1)?.sequence ?? 0;
    if (actual !== input.expectedSequence) {
      throw new RunStoreError(
        "sequence-conflict",
        `Run is at sequence ${actual}; expected ${input.expectedSequence}`,
      );
    }
    const combined = [...run.events, ...structuredClone(input.events)];
    const state = replayRun(combined);
    assertStateMatchesWorkflow(state, run.workflow);
    if (input.snapshot) {
      assertRunSnapshot(input.snapshot, run.workflow, combined);
    }
    const acknowledgement = validateControlAcknowledgement(run, input);
    const receipt: MutationReceipt = {
      runId: input.lease.runId,
      operationId: input.operationId,
      firstSequence: input.events[0]!.sequence,
      lastSequence: input.events.at(-1)!.sequence,
      replayed: false,
    };
    run.events = combined;
    if (input.snapshot) {
      run.snapshots = [
        ...run.snapshots.filter(
          (value) =>
            value.sequence !== input.snapshot!.sequence ||
            value.reducerVersion !== input.snapshot!.reducerVersion,
        ),
        structuredClone(input.snapshot),
      ];
    }
    if (acknowledgement) {
      acknowledgement.control.acknowledgedSequence = acknowledgement.sequence;
    }
    run.mutations.set(input.operationId, { payloadDigest, receipt });
    return structuredClone(receipt);
  }

  /** Persist or idempotently replay an operator pause/cancel request. */
  async submitControl(input: ControlSubmission): Promise<ControlReceipt> {
    validateControlSubmission(input);
    const run = this.requireRun(input.runId);
    const prior = run.controls.get(input.operationId);
    if (prior) {
      if (prior.action !== input.action) {
        throw new RunStoreError("control-conflict", "Control action changed on retry");
      }
      return { ...controlRequest(prior), replayed: true };
    }
    const control: MemoryControl = { ...input, recordedAtMs: validateClock(this.clock) };
    run.controls.set(input.operationId, control);
    return { ...controlRequest(control), replayed: false };
  }

  /** Return unacknowledged controls oldest first, bounded to at most 100. */
  async pendingControls(runId: string, limit = 100): Promise<ControlRequest[]> {
    assertIdentifier(runId, "run ID");
    assertControlLimit(limit);
    const run = this.requireRun(runId);
    return [...run.controls.values()]
      .filter((value) => value.acknowledgedSequence === undefined)
      .sort(
        (left, right) =>
          left.recordedAtMs - right.recordedAtMs ||
          left.operationId.localeCompare(right.operationId),
      )
      .slice(0, limit)
      .map(controlRequest);
  }

  private requireRun(runId: string): MemoryRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RunStoreError("not-found", `Run ${runId} was not found`);
    }
    return run;
  }
}

/** Validate an owned-run creation request before any persistence changes. */
export function validateCreateOwnedRun(input: CreateOwnedRun): void {
  assertIdentifier(input.runId, "run ID");
  if (!uuid.test(input.ownerId)) {
    throw new TypeError("Invalid owner ID");
  }
  assertLocalProcessIdentity(input.owner);
  assertIdentifier(input.operationId, "operation ID");
  assertWorkflowDefinition(input.workflow);
  if (input.initialEvents.length < 1) {
    throw new TypeError("Initial event batch must not be empty");
  }
  const state = replayRun(input.initialEvents);
  if (state.runId !== input.runId) {
    throw new TypeError("Initial history has a different run ID");
  }
  assertStateMatchesWorkflow(state, input.workflow);
  assertRunSnapshot(input.snapshot, input.workflow, input.initialEvents);
}

/** Validate acquisition identity independent of a concrete store. */
export function validateAcquisition(input: AcquireReleasedRun): void {
  assertIdentifier(input.runId, "run ID");
  if (!uuid.test(input.ownerId)) {
    throw new TypeError("Invalid owner ID");
  }
  assertLocalProcessIdentity(input.owner);
}

/** Validate a mutation envelope independent of persisted state. */
export function validateMutation(input: FencedRunMutation): void {
  assertRunLeaseToken(input.lease);
  assertIdentifier(input.operationId, "operation ID");
  if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0) {
    throw new TypeError("Invalid expected sequence");
  }
  if (input.events.length < 1) {
    throw new TypeError("Mutation event batch must not be empty");
  }
  for (const [index, event] of input.events.entries()) {
    const expected = input.expectedSequence + index + 1;
    if (
      !Number.isSafeInteger(expected) ||
      event.runId !== input.lease.runId ||
      event.sequence !== expected
    ) {
      throw new TypeError(`Event at offset ${index} does not match sequence ${expected}`);
    }
  }
  if (input.handlesControlOperationId !== undefined) {
    assertIdentifier(input.handlesControlOperationId, "control operation ID");
  }
}

/** Return the canonical idempotency identity for one mutation request. */
export function durableMutationPayloadDigest(input: FencedRunMutation): string {
  validateMutation(input);
  return mutationPayloadDigest(input);
}

/** Validate and normalize a pending-control limit. */
export function assertControlLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Control limit must be an integer from 1 through 100");
  }
}

/** Validate a control submission before persistence. */
export function validateControlSubmission(input: ControlSubmission): void {
  assertIdentifier(input.runId, "run ID");
  assertIdentifier(input.operationId, "operation ID");
  if (input.action !== "pause" && input.action !== "cancel") {
    throw new TypeError("Invalid control action");
  }
}

function requireFence(run: MemoryRun, token: RunLeaseToken, now: number): RunLease {
  const lease = run.lease;
  if (!lease || lease.ownerId !== token.ownerId || lease.generation !== token.generation) {
    throw new RunStoreError("ownership-conflict", "Lease token is stale");
  }
  if (lease.released || lease.expiresAtMs <= now) {
    throw new RunStoreError("lease-expired", "Lease is released or expired");
  }
  return lease;
}

function validateControlAcknowledgement(
  run: MemoryRun,
  input: FencedRunMutation,
): { control: MemoryControl; sequence: number } | undefined {
  if (!input.handlesControlOperationId) {
    return undefined;
  }
  const control = run.controls.get(input.handlesControlOperationId);
  if (!control || control.acknowledgedSequence !== undefined) {
    throw new RunStoreError("control-conflict", "Control is absent or already acknowledged");
  }
  const matches = input.events.filter(
    (event) =>
      event.type === "ControlRequestObserved" &&
      event.operationId === control.operationId &&
      event.action === control.action &&
      event.recordedAtMs === control.recordedAtMs,
  );
  if (matches.length !== 1) {
    throw new RunStoreError("control-conflict", "Mutation does not observe the exact control");
  }
  return { control, sequence: matches[0]!.sequence };
}

function controlRequest(value: MemoryControl): ControlRequest {
  return {
    runId: value.runId,
    operationId: value.operationId,
    action: value.action,
    recordedAtMs: value.recordedAtMs,
  };
}

function snapshotCompatible(
  snapshot: RunSnapshot,
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
  expectedFinalState: RunState,
): boolean {
  try {
    const prefix = events.slice(0, snapshot.sequence);
    const expected = createRunSnapshot(workflow, prefix);
    if (!isDeepStrictEqual(snapshot, expected)) {
      return false;
    }
    let state = JSON.parse(snapshot.stateJson) as RunState;
    for (const event of events.slice(snapshot.sequence)) {
      state = applyRunEvent(state, event);
    }
    return isDeepStrictEqual(state, expectedFinalState);
  } catch {
    return false;
  }
}
