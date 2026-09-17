import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";

import {
  assertWorkflowDefinition,
  canonicalJson,
  digestBytes,
  type WorkflowDefinition,
} from "@anastom/core";
import {
  EMPTY_EVENT_HISTORY_DIGEST,
  RUN_LEASE_DURATION_MS,
  RUN_SNAPSHOT_MAX_BYTES,
  RunStoreError,
  applyRunEvent,
  assertControlLimit,
  assertLocalProcessIdentity,
  assertRunEvent,
  assertRunLease,
  assertRunLeaseToken,
  assertRunSnapshot,
  assertStateMatchesWorkflow,
  durableMutationPayloadDigest,
  extendEventHistoryDigest,
  replayRun,
  validateAcquisition,
  validateControlSubmission,
  validateCreateOwnedRun,
  validateMutation,
  type AcquireReleasedRun,
  type ControlReceipt,
  type ControlRequest,
  type ControlSubmission,
  type CreateOwnedRun,
  type DurableRunStore,
  type FencedRunMutation,
  type LoadedRun,
  type LoadedRunWithHistory,
  type MutationReceipt,
  type OwnedRunReceipt,
  type RunEvent,
  type RunLease,
  type RunLeaseToken,
  type RunSnapshot,
  type RunState,
  type TakeoverExpiredRun,
} from "@anastom/engine";

import { applyMigrations } from "./migrations.js";

interface EventRow {
  sequence: number;
  event_type: string;
  event_json: string;
}

interface AuthoritativeRun {
  workflow: WorkflowDefinition;
  definitionDigest: string;
  events: RunEvent[];
  eventRows: EventRow[];
  state: RunState;
  historyDigests: string[];
}

interface LeaseRow {
  run_id: string;
  owner_id: string;
  owner_json: string;
  owner_digest: string;
  generation: number;
  acquired_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
  released: number;
}

interface MutationRow {
  generation: number;
  payload_digest: string;
  expected_sequence: number;
  first_sequence: number;
  last_sequence: number;
  committed_at_ms: number;
}

interface ControlRow {
  run_id: string;
  operation_id: string;
  action: string;
  recorded_at_ms: number;
  acknowledged_sequence: number | null;
}

interface SnapshotRow {
  sequence: number;
  version: string;
  reducer_version: string;
  definition_digest: string;
  event_prefix_digest: string;
  state_digest: string;
  state_json: string;
}

type StoreClock = () => number;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
type BusyTimeoutMs = 0 | typeof DEFAULT_BUSY_TIMEOUT_MS;

/** SQLite implementation of the fenced M3 durable run-store contract. */
export class SqliteDurableRunStore implements DurableRunStore {
  private readonly db: DatabaseSync;
  private readonly injectedClock?: StoreClock;

  /** Open and migrate a store beneath an existing, caller-authorized parent directory. */
  constructor(path: string);
  constructor(
    path: string,
    clock?: StoreClock,
    busyTimeoutMs: BusyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
  ) {
    if (busyTimeoutMs !== 0 && busyTimeoutMs !== DEFAULT_BUSY_TIMEOUT_MS) {
      throw new TypeError("Invalid SQLite busy timeout");
    }
    this.db = new DatabaseSync(path);
    this.injectedClock = clock;
    try {
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec(
        busyTimeoutMs === 0 ? "PRAGMA busy_timeout = 0;" : "PRAGMA busy_timeout = 5000;",
      );
      this.db.exec("PRAGMA journal_mode = WAL;");
      applyMigrations(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Atomically create immutable history, generation-one ownership, integrity, and snapshot. */
  async createOwned(input: CreateOwnedRun): Promise<OwnedRunReceipt> {
    validateCreateOwnedRun(input);
    return this.writeTransaction(() => {
      if (this.runExists(input.runId)) {
        throw new RunStoreError("ownership-conflict", `Run ${input.runId} already exists`);
      }
      const now = this.now();
      const workflowJson = canonicalJson(input.workflow);
      const definitionDigest = digestBytes(workflowJson);
      this.db
        .prepare("INSERT INTO runs(run_id,workflow_digest,workflow_json) VALUES(?,?,?)")
        .run(input.runId, definitionDigest, workflowJson);
      const historyDigests = this.insertEvents(input.runId, input.initialEvents, []);
      const ownerJson = canonicalJson(input.owner);
      this.db
        .prepare(
          `INSERT INTO run_leases(
             run_id,owner_id,owner_json,owner_digest,generation,
             acquired_at_ms,renewed_at_ms,expires_at_ms,released
           ) VALUES(?,?,?,?,1,?,?,?,0)`,
        )
        .run(
          input.runId,
          input.ownerId,
          ownerJson,
          digestBytes(ownerJson),
          now,
          now,
          leaseExpiry(now),
        );
      const lease: RunLeaseToken = {
        runId: input.runId,
        ownerId: input.ownerId,
        generation: 1,
      };
      const mutation: FencedRunMutation = {
        lease,
        operationId: input.operationId,
        expectedSequence: 0,
        events: input.initialEvents,
        snapshot: input.snapshot,
      };
      const receipt: MutationReceipt = {
        runId: input.runId,
        operationId: input.operationId,
        firstSequence: 1,
        lastSequence: input.initialEvents.length,
        replayed: false,
      };
      this.insertMutation(mutation, durableMutationPayloadDigest(mutation), receipt, now);
      this.insertSnapshot(input.snapshot, now);
      if (historyDigests.at(-1) !== input.snapshot.eventPrefixDigest) {
        throw new RunStoreError("corrupt-store", "Initial snapshot history digest disagrees");
      }
      return { lease, mutation: receipt };
    });
  }

  /** Load folded state for execution without returning complete events. */
  async load(runId: string, mode: "execution"): Promise<LoadedRun | null>;
  /** Load folded state plus the complete authoritative history for inspection. */
  async load(runId: string, mode: "complete-history"): Promise<LoadedRunWithHistory | null>;
  async load(
    runId: string,
    mode: "execution" | "complete-history",
  ): Promise<LoadedRun | LoadedRunWithHistory | null> {
    assertStoreIdentifier(runId, "run ID");
    try {
      return this.readTransaction(() => {
        const authoritative = this.readAuthoritativeRun(runId);
        if (!authoritative) {
          return null;
        }
        const snapshot = this.selectSnapshot(authoritative);
        return {
          workflow: authoritative.workflow,
          state: authoritative.state,
          eventPrefixDigest: authoritative.historyDigests.at(-1) ?? EMPTY_EVENT_HISTORY_DIGEST,
          snapshotSource: snapshot ? "snapshot-tail" : "full-replay",
          ...(snapshot ? { snapshotSequence: snapshot.sequence } : {}),
          ...(mode === "complete-history" ? { events: authoritative.events } : {}),
        };
      });
    } catch (error) {
      throw asStoreError(error, "corrupt-store", `Could not load run ${runId}`);
    }
  }

  /** Inspect current ownership without acquiring, renewing, or releasing it. */
  async inspectLease(runId: string): Promise<RunLease | null> {
    assertStoreIdentifier(runId, "run ID");
    const row = this.db.prepare("SELECT * FROM run_leases WHERE run_id=?").get(runId);
    if (!row) {
      return null;
    }
    try {
      return leaseFromRow(row as unknown as LeaseRow);
    } catch (error) {
      throw asStoreError(error, "corrupt-store", `Invalid lease for run ${runId}`);
    }
  }

  /** Acquire a released lease or add generation one to a legacy run without ownership. */
  async acquireReleased(input: AcquireReleasedRun): Promise<RunLeaseToken> {
    validateAcquisition(input);
    return this.writeTransaction(() => {
      if (!this.runExists(input.runId)) {
        throw new RunStoreError("not-found", `Run ${input.runId} was not found`);
      }
      const existing = this.readLease(input.runId);
      if (existing && !existing.released) {
        throw new RunStoreError("ownership-conflict", `Run ${input.runId} is still owned`);
      }
      const now = this.now();
      const generation = nextGeneration(existing?.generation ?? 0);
      const ownerJson = canonicalJson(input.owner);
      this.db
        .prepare(
          `INSERT INTO run_leases(
             run_id,owner_id,owner_json,owner_digest,generation,
             acquired_at_ms,renewed_at_ms,expires_at_ms,released
           ) VALUES(?,?,?,?,?,?,?,?,0)
           ON CONFLICT(run_id) DO UPDATE SET
             owner_id=excluded.owner_id, owner_json=excluded.owner_json,
             owner_digest=excluded.owner_digest, generation=excluded.generation,
             acquired_at_ms=excluded.acquired_at_ms, renewed_at_ms=excluded.renewed_at_ms,
             expires_at_ms=excluded.expires_at_ms, released=0`,
        )
        .run(
          input.runId,
          input.ownerId,
          ownerJson,
          digestBytes(ownerJson),
          generation,
          now,
          now,
          leaseExpiry(now),
        );
      return { runId: input.runId, ownerId: input.ownerId, generation };
    });
  }

  /** Replace the exact expired lease only after independently observing owner absence. */
  async takeoverExpired(input: TakeoverExpiredRun): Promise<RunLeaseToken> {
    validateAcquisition(input);
    assertRunLease(input.observedLease);
    assertAbsentObservation(input.ownerAbsence);
    return this.writeTransaction(() => {
      if (!this.runExists(input.runId)) {
        throw new RunStoreError("not-found", `Run ${input.runId} was not found`);
      }
      const current = this.readLease(input.runId);
      const now = this.now();
      if (!current || current.released || !isDeepStrictEqual(current, input.observedLease)) {
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
      const generation = nextGeneration(current.generation);
      const ownerJson = canonicalJson(input.owner);
      this.db
        .prepare(
          `UPDATE run_leases SET
             owner_id=?,owner_json=?,owner_digest=?,generation=?,
             acquired_at_ms=?,renewed_at_ms=?,expires_at_ms=?,released=0
           WHERE run_id=?`,
        )
        .run(
          input.ownerId,
          ownerJson,
          digestBytes(ownerJson),
          generation,
          now,
          now,
          leaseExpiry(now),
          input.runId,
        );
      return { runId: input.runId, ownerId: input.ownerId, generation };
    });
  }

  /** Renew a current, unexpired lease using one store-assigned transaction time. */
  async renew(token: RunLeaseToken): Promise<RunLease> {
    assertRunLeaseToken(token);
    return this.writeTransaction(() => {
      const now = this.now();
      const lease = this.requireFence(token, now);
      const expiresAtMs = leaseExpiry(Math.max(now, lease.renewedAtMs));
      this.db
        .prepare("UPDATE run_leases SET renewed_at_ms=?,expires_at_ms=? WHERE run_id=?")
        .run(Math.max(now, lease.renewedAtMs), expiresAtMs, token.runId);
      return { ...lease, renewedAtMs: Math.max(now, lease.renewedAtMs), expiresAtMs };
    });
  }

  /** Release the matching current generation; retrying that same release is idempotent. */
  async release(token: RunLeaseToken): Promise<void> {
    assertRunLeaseToken(token);
    this.writeTransaction(() => {
      const lease = this.readLease(token.runId);
      if (!lease) {
        if (!this.runExists(token.runId)) {
          throw new RunStoreError("not-found", `Run ${token.runId} was not found`);
        }
        throw new RunStoreError("ownership-conflict", "Run has no matching lease");
      }
      if (lease.ownerId !== token.ownerId || lease.generation !== token.generation) {
        throw new RunStoreError("ownership-conflict", "Lease token is stale");
      }
      if (!lease.released) {
        this.db.prepare("UPDATE run_leases SET released=1 WHERE run_id=?").run(token.runId);
      }
    });
  }

  /** Commit an idempotent fenced event batch and its snapshot/control effects atomically. */
  async commit(input: FencedRunMutation): Promise<MutationReceipt> {
    validateMutation(input);
    return this.writeTransaction(() => {
      const now = this.now();
      this.requireFence(input.lease, now);
      const payloadDigest = durableMutationPayloadDigest(input);
      const prior = this.db
        .prepare(
          `SELECT generation,payload_digest,expected_sequence,first_sequence,
                  last_sequence,committed_at_ms FROM run_mutations
           WHERE run_id=? AND operation_id=?`,
        )
        .get(input.lease.runId, input.operationId) as unknown as MutationRow | undefined;
      if (prior) {
        assertMutationRow(prior);
        if (prior.payload_digest !== payloadDigest) {
          throw new RunStoreError("idempotency-conflict", "Operation payload changed on retry");
        }
        return {
          runId: input.lease.runId,
          operationId: input.operationId,
          firstSequence: prior.first_sequence,
          lastSequence: prior.last_sequence,
          replayed: true,
        };
      }
      let run: AuthoritativeRun | null;
      try {
        run = this.readAuthoritativeRun(input.lease.runId);
      } catch (error) {
        throw asStoreError(error, "corrupt-store", "Authoritative run history is corrupt");
      }
      if (!run) {
        throw new RunStoreError("not-found", `Run ${input.lease.runId} was not found`);
      }
      const actual = run.events.at(-1)?.sequence ?? 0;
      if (actual !== input.expectedSequence) {
        throw new RunStoreError(
          "sequence-conflict",
          `Run is at sequence ${actual}; expected ${input.expectedSequence}`,
        );
      }
      const combined = [...run.events, ...input.events];
      const state = replayRun(combined);
      assertStateMatchesWorkflow(state, run.workflow);
      if (input.snapshot) {
        assertRunSnapshot(input.snapshot, run.workflow, combined);
      }
      const acknowledgement = this.validateControlAcknowledgement(input);
      this.insertEvents(input.lease.runId, input.events, run.historyDigests);
      const receipt: MutationReceipt = {
        runId: input.lease.runId,
        operationId: input.operationId,
        firstSequence: input.events[0]!.sequence,
        lastSequence: input.events.at(-1)!.sequence,
        replayed: false,
      };
      this.insertMutation(input, payloadDigest, receipt, now);
      if (input.snapshot) {
        this.insertSnapshot(input.snapshot, now);
      }
      if (acknowledgement !== undefined) {
        this.db
          .prepare(
            `UPDATE control_requests SET acknowledged_sequence=?
             WHERE run_id=? AND operation_id=? AND acknowledged_sequence IS NULL`,
          )
          .run(acknowledgement, input.lease.runId, input.handlesControlOperationId!);
      }
      return receipt;
    });
  }

  /** Submit an idempotent operator request without touching the current lease. */
  async submitControl(input: ControlSubmission): Promise<ControlReceipt> {
    validateControlSubmission(input);
    return this.writeTransaction(() => {
      if (!this.runExists(input.runId)) {
        throw new RunStoreError("not-found", `Run ${input.runId} was not found`);
      }
      const prior = this.db
        .prepare(
          `SELECT run_id,operation_id,action,recorded_at_ms,acknowledged_sequence
           FROM control_requests WHERE run_id=? AND operation_id=?`,
        )
        .get(input.runId, input.operationId) as unknown as ControlRow | undefined;
      if (prior) {
        const control = controlFromRow(prior);
        if (control.action !== input.action) {
          throw new RunStoreError("control-conflict", "Control action changed on retry");
        }
        return { ...control, replayed: true };
      }
      const recordedAtMs = this.now();
      this.db
        .prepare(
          `INSERT INTO control_requests(run_id,operation_id,action,recorded_at_ms)
           VALUES(?,?,?,?)`,
        )
        .run(input.runId, input.operationId, input.action, recordedAtMs);
      return { ...input, recordedAtMs, replayed: false };
    });
  }

  /** Return unacknowledged controls oldest first with a maximum result count of 100. */
  async pendingControls(runId: string, limit = 100): Promise<ControlRequest[]> {
    assertStoreIdentifier(runId, "run ID");
    assertControlLimit(limit);
    if (!this.runExists(runId)) {
      throw new RunStoreError("not-found", `Run ${runId} was not found`);
    }
    try {
      return this.db
        .prepare(
          `SELECT run_id,operation_id,action,recorded_at_ms,acknowledged_sequence
           FROM control_requests
           WHERE run_id=? AND acknowledged_sequence IS NULL
           ORDER BY recorded_at_ms,operation_id LIMIT ?`,
        )
        .all(runId, limit)
        .map((row) => controlFromRow(row as unknown as ControlRow));
    } catch (error) {
      throw asStoreError(error, "corrupt-store", `Invalid controls for run ${runId}`);
    }
  }

  /** Close the SQLite handle after all store operations have completed. */
  close(): void {
    this.db.close();
  }

  private now(): number {
    const now = this.injectedClock
      ? this.injectedClock()
      : this.db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get()?.now;
    assertTimestamp(now, "store clock");
    return now;
  }

  private runExists(runId: string): boolean {
    return this.db.prepare("SELECT 1 FROM runs WHERE run_id=?").get(runId) !== undefined;
  }

  private readLease(runId: string): RunLease | null {
    const row = this.db.prepare("SELECT * FROM run_leases WHERE run_id=?").get(runId);
    if (!row) {
      return null;
    }
    try {
      return leaseFromRow(row as unknown as LeaseRow);
    } catch (error) {
      throw asStoreError(error, "corrupt-store", `Invalid lease for run ${runId}`);
    }
  }

  private requireFence(token: RunLeaseToken, now: number): RunLease {
    const lease = this.readLease(token.runId);
    if (!lease) {
      if (!this.runExists(token.runId)) {
        throw new RunStoreError("not-found", `Run ${token.runId} was not found`);
      }
      throw new RunStoreError("ownership-conflict", "Run has no matching lease");
    }
    if (lease.ownerId !== token.ownerId || lease.generation !== token.generation) {
      throw new RunStoreError("ownership-conflict", "Lease token is stale");
    }
    if (lease.released || lease.expiresAtMs <= now) {
      throw new RunStoreError("lease-expired", "Lease is released or expired");
    }
    return lease;
  }

  private readAuthoritativeRun(runId: string): AuthoritativeRun | null {
    const row = this.db
      .prepare("SELECT workflow_digest,workflow_json FROM runs WHERE run_id=?")
      .get(runId) as { workflow_digest?: unknown; workflow_json?: unknown } | undefined;
    if (!row) {
      return null;
    }
    if (
      typeof row.workflow_json !== "string" ||
      typeof row.workflow_digest !== "string" ||
      digestBytes(row.workflow_json) !== row.workflow_digest
    ) {
      throw new Error("Workflow bytes or digest are corrupt");
    }
    const workflow = parseJson(row.workflow_json, "workflow");
    assertWorkflowDefinition(workflow);
    const rawRows = this.db
      .prepare("SELECT sequence,event_type,event_json FROM events WHERE run_id=? ORDER BY sequence")
      .all(runId);
    const eventRows = rawRows.map((value) => eventRow(value));
    const events = eventRows.map((value) => parseEventRow(runId, value));
    const state = replayRun(events);
    assertStateMatchesWorkflow(state, workflow);
    const historyDigests = this.validateIntegrity(runId, eventRows);
    return {
      workflow,
      definitionDigest: row.workflow_digest,
      events,
      eventRows,
      state,
      historyDigests,
    };
  }

  private validateIntegrity(runId: string, events: readonly EventRow[]): string[] {
    const rows = this.db
      .prepare(
        "SELECT sequence,event_digest,history_digest FROM event_integrity WHERE run_id=? ORDER BY sequence",
      )
      .all(runId) as Array<{
      sequence?: unknown;
      event_digest?: unknown;
      history_digest?: unknown;
    }>;
    const integrity = new Map<number, { eventDigest: string; historyDigest: string }>();
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.sequence) ||
        typeof row.event_digest !== "string" ||
        typeof row.history_digest !== "string"
      ) {
        throw new Error("Invalid event-integrity row");
      }
      integrity.set(row.sequence as number, {
        eventDigest: row.event_digest,
        historyDigest: row.history_digest,
      });
    }
    const historyDigests: string[] = [];
    let previous = EMPTY_EVENT_HISTORY_DIGEST;
    let coverageStarted = false;
    for (const event of events) {
      const expected = extendEventHistoryDigest({
        previous,
        runId,
        sequence: event.sequence,
        eventType: event.event_type,
        eventJson: event.event_json,
      });
      const stored = integrity.get(event.sequence);
      if (stored) {
        coverageStarted = true;
        if (
          stored.eventDigest !== expected.eventDigest ||
          stored.historyDigest !== expected.historyDigest
        ) {
          throw new Error("Event integrity digest mismatch");
        }
      } else if (coverageStarted) {
        throw new Error("Event integrity coverage has a gap");
      }
      previous = expected.historyDigest;
      historyDigests.push(previous);
    }
    const eventSequences = new Set(events.map((event) => event.sequence));
    if ([...integrity.keys()].some((sequence) => !eventSequences.has(sequence))) {
      throw new Error("Event integrity refers to absent history");
    }
    return historyDigests;
  }

  private insertEvents(
    runId: string,
    events: readonly RunEvent[],
    existingHistoryDigests: readonly string[],
  ): string[] {
    const eventStatement = this.db.prepare(
      "INSERT INTO events(run_id,sequence,event_type,event_json) VALUES(?,?,?,?)",
    );
    const integrityStatement = this.db.prepare(
      `INSERT INTO event_integrity(run_id,sequence,event_digest,history_digest)
       VALUES(?,?,?,?)`,
    );
    const historyDigests = [...existingHistoryDigests];
    let previous = historyDigests.at(-1) ?? EMPTY_EVENT_HISTORY_DIGEST;
    for (const event of events) {
      assertRunEvent(event);
      const eventJson = canonicalJson(event);
      const integrity = extendEventHistoryDigest({
        previous,
        runId,
        sequence: event.sequence,
        eventType: event.type,
        eventJson,
      });
      eventStatement.run(runId, event.sequence, event.type, eventJson);
      integrityStatement.run(runId, event.sequence, integrity.eventDigest, integrity.historyDigest);
      previous = integrity.historyDigest;
      historyDigests.push(previous);
    }
    return historyDigests;
  }

  private insertMutation(
    input: FencedRunMutation,
    payloadDigest: string,
    receipt: MutationReceipt,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO run_mutations(
           run_id,operation_id,generation,payload_digest,expected_sequence,
           first_sequence,last_sequence,committed_at_ms
         ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.lease.runId,
        input.operationId,
        input.lease.generation,
        payloadDigest,
        input.expectedSequence,
        receipt.firstSequence,
        receipt.lastSequence,
        now,
      );
  }

  private insertSnapshot(snapshot: RunSnapshot, now: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_snapshots(
           run_id,sequence,version,reducer_version,definition_digest,
           event_prefix_digest,state_digest,state_json,created_at_ms
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        snapshot.runId,
        snapshot.sequence,
        snapshot.version,
        snapshot.reducerVersion,
        snapshot.definitionDigest,
        snapshot.eventPrefixDigest,
        snapshot.stateDigest,
        snapshot.stateJson,
        now,
      );
  }

  private validateControlAcknowledgement(input: FencedRunMutation): number | undefined {
    if (!input.handlesControlOperationId) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT run_id,operation_id,action,recorded_at_ms,acknowledged_sequence
         FROM control_requests WHERE run_id=? AND operation_id=?`,
      )
      .get(input.lease.runId, input.handlesControlOperationId) as
      (ControlRow & { acknowledged_sequence: number | null }) | undefined;
    if (!row || row.acknowledged_sequence !== null) {
      throw new RunStoreError("control-conflict", "Control is absent or already acknowledged");
    }
    const control = controlFromRow(row);
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
    return matches[0]!.sequence;
  }

  private selectSnapshot(run: AuthoritativeRun): RunSnapshot | undefined {
    const rows = this.db
      .prepare(
        `SELECT sequence,version,reducer_version,definition_digest,
                event_prefix_digest,state_digest,state_json
         FROM run_snapshots WHERE run_id=? ORDER BY sequence DESC`,
      )
      .all(run.state.runId);
    for (const value of rows) {
      const snapshot = snapshotFromRow(run.state.runId, value as unknown as SnapshotRow);
      if (snapshot && snapshotCompatible(snapshot, run)) {
        return snapshot;
      }
    }
    return undefined;
  }

  private writeTransaction<T>(operation: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw asStoreError(error, "corrupt-store", "Could not begin an immediate transaction");
    }
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original classified failure remains authoritative.
      }
      if (error instanceof RunStoreError) {
        throw error;
      }
      if (isSqliteError(error)) {
        throw asStoreError(error, "corrupt-store", "Durable store transaction failed");
      }
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original read failure.
      }
      throw error;
    }
  }
}

/**
 * Open a deterministic-clock store for package contract tests.
 * @internal This helper is intentionally absent from the package entry point.
 */
export function createSqliteDurableRunStoreForTesting(
  path: string,
  clock: StoreClock,
  busyTimeoutMs: BusyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
): SqliteDurableRunStore {
  return Reflect.construct(SqliteDurableRunStore, [
    path,
    clock,
    busyTimeoutMs,
  ]) as SqliteDurableRunStore;
}

function leaseFromRow(row: LeaseRow): RunLease {
  if (
    typeof row.run_id !== "string" ||
    typeof row.owner_id !== "string" ||
    typeof row.owner_json !== "string" ||
    typeof row.owner_digest !== "string" ||
    digestBytes(row.owner_json) !== row.owner_digest ||
    (row.released !== 0 && row.released !== 1)
  ) {
    throw new TypeError("Invalid lease row");
  }
  const owner = parseJson(row.owner_json, "lease owner");
  assertLocalProcessIdentity(owner);
  if (canonicalJson(owner) !== row.owner_json) {
    throw new TypeError("Lease owner JSON is not canonical");
  }
  const lease: RunLease = {
    runId: row.run_id,
    ownerId: row.owner_id,
    owner,
    generation: row.generation,
    acquiredAtMs: row.acquired_at_ms,
    renewedAtMs: row.renewed_at_ms,
    expiresAtMs: row.expires_at_ms,
    released: row.released === 1,
  };
  assertRunLease(lease);
  return lease;
}

function eventRow(value: unknown): EventRow {
  const row = value as Partial<EventRow>;
  if (
    !Number.isSafeInteger(row.sequence) ||
    typeof row.event_type !== "string" ||
    typeof row.event_json !== "string"
  ) {
    throw new TypeError("Invalid event row");
  }
  return row as EventRow;
}

function parseEventRow(runId: string, row: EventRow): RunEvent {
  const event = parseJson(row.event_json, "event");
  assertRunEvent(event);
  if (event.runId !== runId || event.sequence !== row.sequence || event.type !== row.event_type) {
    throw new TypeError("Event row identity mismatch");
  }
  return event;
}

function controlFromRow(row: ControlRow): ControlRequest {
  try {
    const input = {
      runId: row.run_id,
      operationId: row.operation_id,
      action: row.action,
    };
    validateControlSubmission(input as ControlSubmission);
    assertTimestamp(row.recorded_at_ms, "control timestamp");
    if (
      row.acknowledged_sequence !== null &&
      (!Number.isSafeInteger(row.acknowledged_sequence) || row.acknowledged_sequence < 1)
    ) {
      throw new TypeError("Invalid control acknowledgement sequence");
    }
    return { ...(input as ControlSubmission), recordedAtMs: row.recorded_at_ms };
  } catch (error) {
    throw asStoreError(error, "corrupt-store", "Invalid control request row");
  }
}

function assertMutationRow(row: MutationRow): void {
  if (
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(row.payload_digest) ||
    !Number.isSafeInteger(row.expected_sequence) ||
    row.expected_sequence < 0 ||
    !Number.isSafeInteger(row.first_sequence) ||
    row.first_sequence !== row.expected_sequence + 1 ||
    !Number.isSafeInteger(row.last_sequence) ||
    row.last_sequence < row.first_sequence ||
    !Number.isSafeInteger(row.committed_at_ms) ||
    row.committed_at_ms < 1
  ) {
    throw new RunStoreError("corrupt-store", "Invalid mutation receipt row");
  }
}

function snapshotFromRow(runId: string, row: SnapshotRow): RunSnapshot | undefined {
  if (
    row.version !== "anastom.dev/run-snapshot/v1alpha1" ||
    row.reducer_version !== "anastom.dev/run-reducer/v1alpha1" ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof row.state_json !== "string" ||
    Buffer.byteLength(row.state_json) > RUN_SNAPSHOT_MAX_BYTES
  ) {
    return undefined;
  }
  return {
    version: row.version,
    reducerVersion: row.reducer_version,
    runId,
    definitionDigest: row.definition_digest,
    sequence: row.sequence,
    stateJson: row.state_json,
    stateDigest: row.state_digest,
    eventPrefixDigest: row.event_prefix_digest,
  };
}

function snapshotCompatible(snapshot: RunSnapshot, run: AuthoritativeRun): boolean {
  try {
    if (
      snapshot.definitionDigest !== run.definitionDigest ||
      snapshot.sequence > run.events.length ||
      run.historyDigests[snapshot.sequence - 1] !== snapshot.eventPrefixDigest ||
      digestBytes(snapshot.stateJson) !== snapshot.stateDigest ||
      canonicalJson(parseJson(snapshot.stateJson, "snapshot state")) !== snapshot.stateJson
    ) {
      return false;
    }
    const prefix = run.events.slice(0, snapshot.sequence);
    assertRunSnapshot(snapshot, run.workflow, prefix);
    let state = parseJson(snapshot.stateJson, "snapshot state") as RunState;
    for (const event of run.events.slice(snapshot.sequence)) {
      state = applyRunEvent(state, event);
    }
    return isDeepStrictEqual(state, run.state);
  } catch {
    return false;
  }
}

function parseJson(bytes: string, label: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new TypeError(`Invalid ${label} JSON`, { cause: error });
  }
}

function assertStoreIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Invalid ${label}`);
  }
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

function asStoreError(
  error: unknown,
  fallback: "busy" | "corrupt-store",
  message: string,
): RunStoreError {
  if (error instanceof RunStoreError) {
    return error;
  }
  const code = isSqliteError(error) ? error.code : "";
  if (code.startsWith("ERR_SQLITE_ERROR") && /busy|locked/i.test(String(error))) {
    return new RunStoreError("busy", message, { cause: error });
  }
  return new RunStoreError(fallback, message, { cause: error });
}

function isSqliteError(error: unknown): error is { code: string } {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_SQLITE")
  );
}
