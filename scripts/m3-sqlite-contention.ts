import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../packages/core/src/index.js";

const databaseName = "contention.sqlite";
const schema = readFileSync(new URL("./testing/m3-contention.sql", import.meta.url), "utf8");

/** Lease authority used by one M3 SQLite feasibility operation. */
export interface M3ContentionToken {
  runId: string;
  ownerId: string;
  generation: number;
}

/** Process-liveness conclusion supplied before an expired-lease takeover is attempted. */
type M3ContentionLiveness = "alive" | "absent" | "unknown";

/** One validated operation executed by an isolated contention worker. */
export type M3ContentionRequest =
  | {
      operation: "acquire";
      runId: string;
      ownerId: string;
      nowMs: number;
      ttlMs: number;
    }
  | {
      operation: "renew";
      token: M3ContentionToken;
      nowMs: number;
      ttlMs: number;
    }
  | {
      operation: "takeover";
      runId: string;
      ownerId: string;
      observedOwnerId: string;
      observedGeneration: number;
      liveness: M3ContentionLiveness;
      nowMs: number;
      ttlMs: number;
    }
  | { operation: "release"; token: M3ContentionToken }
  | {
      operation: "append";
      token: M3ContentionToken;
      nowMs: number;
      mutationId: string;
      payloadDigest: string;
      expectedSequence: number;
      events: string[];
    }
  | {
      operation: "control";
      runId: string;
      operationId: string;
      action: "pause" | "cancel";
    };

/** Sanitized outcome returned by one isolated contention worker. */
export type M3ContentionResponse =
  | {
      ok: true;
      operation: "acquire" | "renew" | "takeover";
      token: M3ContentionToken;
      expiresAtMs: number;
    }
  | { ok: true; operation: "release"; token: M3ContentionToken }
  | {
      ok: true;
      operation: "append";
      firstSequence: number;
      lastSequence: number;
      replayed: boolean;
    }
  | {
      ok: true;
      operation: "control";
      action: "pause" | "cancel";
      recordedAtMs: number;
      replayed: boolean;
    }
  | {
      ok: false;
      category:
        | "ownership-conflict"
        | "live-owner"
        | "unknown-owner"
        | "idempotency-conflict"
        | "sequence-conflict"
        | "invalid-request";
      message: string;
    };

/** Read-only database evidence collected after all worker processes exit. */
export interface M3ContentionInspection {
  lease: {
    runId: string;
    ownerId: string;
    generation: number;
    expiresAtMs: number;
    released: boolean;
  } | null;
  events: Array<{
    sequence: number;
    generation: number;
    mutationId: string;
    payload: string;
  }>;
  mutations: Array<{
    mutationId: string;
    payloadDigest: string;
    generation: number;
    firstSequence: number;
    lastSequence: number;
  }>;
  controls: Array<{
    operationId: string;
    action: "pause" | "cancel";
    recordedAtMs: number;
  }>;
}

type FailureCategory = Extract<M3ContentionResponse, { ok: false }>["category"];

class M3ContentionError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

interface LeaseRow {
  runId: string;
  ownerId: string;
  generation: number;
  expiresAtMs: number;
  released: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isClockRange(nowMs: unknown, ttlMs: unknown): boolean {
  return isTime(nowMs) && isPositiveInteger(ttlMs) && Number.isSafeInteger(nowMs + ttlMs);
}

function isToken(value: unknown): value is M3ContentionToken {
  return (
    isRecord(value) &&
    exactKeys(value, ["generation", "ownerId", "runId"]) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.ownerId) &&
    isPositiveInteger(value.generation)
  );
}

function isAcquireRequest(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["nowMs", "operation", "ownerId", "runId", "ttlMs"]) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.ownerId) &&
    isClockRange(value.nowMs, value.ttlMs)
  );
}

function isRenewRequest(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["nowMs", "operation", "token", "ttlMs"]) &&
    isToken(value.token) &&
    isClockRange(value.nowMs, value.ttlMs)
  );
}

function isTakeoverRequest(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, [
      "liveness",
      "nowMs",
      "observedGeneration",
      "observedOwnerId",
      "operation",
      "ownerId",
      "runId",
      "ttlMs",
    ]) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.ownerId) &&
    isIdentifier(value.observedOwnerId) &&
    isPositiveInteger(value.observedGeneration) &&
    ["alive", "absent", "unknown"].includes(value.liveness as string) &&
    isClockRange(value.nowMs, value.ttlMs)
  );
}

function isReleaseRequest(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["operation", "token"]) && isToken(value.token);
}

function isAppendRequest(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, [
      "events",
      "expectedSequence",
      "mutationId",
      "nowMs",
      "operation",
      "payloadDigest",
      "token",
    ]) &&
    isToken(value.token) &&
    isTime(value.nowMs) &&
    isIdentifier(value.mutationId) &&
    typeof value.payloadDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.payloadDigest) &&
    Number.isSafeInteger(value.expectedSequence) &&
    (value.expectedSequence as number) >= 0 &&
    Array.isArray(value.events) &&
    value.events.length > 0 &&
    value.events.length <= 16 &&
    value.events.every((event) => typeof event === "string" && event.length <= 4_096)
  );
}

function isControlRequest(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["action", "operation", "operationId", "runId"]) &&
    isIdentifier(value.runId) &&
    isIdentifier(value.operationId) &&
    (value.action === "pause" || value.action === "cancel")
  );
}

/** Validate an exact contention-worker request before it reaches SQLite. */
export function assertM3ContentionRequest(value: unknown): asserts value is M3ContentionRequest {
  if (!isRecord(value) || typeof value.operation !== "string") {
    throw new Error("Invalid M3 contention request");
  }
  switch (value.operation) {
    case "acquire":
      if (isAcquireRequest(value)) {
        return;
      }
      break;
    case "renew":
      if (isRenewRequest(value)) {
        return;
      }
      break;
    case "takeover":
      if (isTakeoverRequest(value)) {
        return;
      }
      break;
    case "release":
      if (isReleaseRequest(value)) {
        return;
      }
      break;
    case "append":
      if (isAppendRequest(value)) {
        return;
      }
      break;
    case "control":
      if (isControlRequest(value)) {
        return;
      }
      break;
  }
  throw new Error("Invalid M3 contention request");
}

function isFailureResponse(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["category", "message", "ok"]) &&
    [
      "ownership-conflict",
      "live-owner",
      "unknown-owner",
      "idempotency-conflict",
      "sequence-conflict",
      "invalid-request",
    ].includes(value.category as string) &&
    typeof value.message === "string"
  );
}

function isLeaseResponse(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["expiresAtMs", "ok", "operation", "token"]) &&
    isToken(value.token) &&
    isTime(value.expiresAtMs)
  );
}

function isReleaseResponse(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["ok", "operation", "token"]) && isToken(value.token);
}

function isAppendResponse(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["firstSequence", "lastSequence", "ok", "operation", "replayed"]) &&
    isPositiveInteger(value.firstSequence) &&
    isPositiveInteger(value.lastSequence) &&
    value.lastSequence >= value.firstSequence &&
    typeof value.replayed === "boolean"
  );
}

function isControlResponse(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["action", "ok", "operation", "recordedAtMs", "replayed"]) &&
    (value.action === "pause" || value.action === "cancel") &&
    isTime(value.recordedAtMs) &&
    typeof value.replayed === "boolean"
  );
}

/** Validate the exact sanitized response emitted by a contention worker. */
export function assertM3ContentionResponse(value: unknown): asserts value is M3ContentionResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Invalid M3 contention response");
  }
  if (!value.ok) {
    if (isFailureResponse(value)) {
      return;
    }
  } else {
    switch (value.operation) {
      case "acquire":
      case "renew":
      case "takeover":
        if (isLeaseResponse(value)) {
          return;
        }
        break;
      case "release":
        if (isReleaseResponse(value)) {
          return;
        }
        break;
      case "append":
        if (isAppendResponse(value)) {
          return;
        }
        break;
      case "control":
        if (isControlResponse(value)) {
          return;
        }
        break;
    }
  }
  throw new Error("Invalid M3 contention response");
}

/** Hash the exact append payload used by the idempotency experiment. */
export function m3ContentionPayloadDigest(events: readonly string[]): string {
  return `sha256:${createHash("sha256").update(canonicalJson(events)).digest("hex")}`;
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid M3 contention ${name}`);
  }
  return value;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid M3 contention ${name}`);
  }
  return value;
}

function checkedIncrement(value: number, amount: number, name: string): number {
  const result = value + amount;
  if (!Number.isSafeInteger(result) || result <= value) {
    throw new Error(`M3 contention ${name} exceeded its safe integer range`);
  }
  return result;
}

/** Initialize a fresh fixed-name SQLite database for the contention probe. */
export function initializeM3ContentionDatabase(root: string): void {
  const db = new DatabaseSync(join(root, databaseName));
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.exec(schema);
  } finally {
    db.close();
  }
}

/** Execute fenced feasibility operations under `BEGIN IMMEDIATE` transactions. */
export class M3ContentionStore {
  private readonly db: DatabaseSync;

  /** Open the already initialized fixed-name database beneath a trusted probe root. */
  constructor(root: string) {
    this.db = new DatabaseSync(join(root, databaseName));
    this.db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    );
  }

  /** Execute one validated request and return expected contention as typed public evidence. */
  execute(request: M3ContentionRequest): M3ContentionResponse {
    try {
      if (request.operation === "acquire") {
        return this.acquire(request);
      }
      if (request.operation === "renew") {
        return this.renew(request);
      }
      if (request.operation === "takeover") {
        return this.takeover(request);
      }
      if (request.operation === "release") {
        return this.release(request);
      }
      if (request.operation === "append") {
        return this.append(request);
      }
      return this.control(request);
    } catch (error) {
      if (error instanceof M3ContentionError) {
        return { ok: false, category: error.category, message: error.message };
      }
      throw error;
    }
  }

  /** Read the final lease and immutable rows after contention workers have exited. */
  inspect(runId: string): M3ContentionInspection {
    const lease = this.readLease(runId);
    const events = this.db
      .prepare(
        "SELECT sequence,generation,mutation_id,payload_json FROM m3_events WHERE run_id=? ORDER BY sequence",
      )
      .all(runId)
      .map((row) => ({
        sequence: numberField(row.sequence, "event sequence"),
        generation: numberField(row.generation, "event generation"),
        mutationId: stringField(row.mutation_id, "event mutation"),
        payload: stringField(row.payload_json, "event payload"),
      }));
    const mutations = this.db
      .prepare(
        "SELECT mutation_id,payload_digest,generation,first_sequence,last_sequence FROM m3_mutations WHERE run_id=? ORDER BY first_sequence",
      )
      .all(runId)
      .map((row) => ({
        mutationId: stringField(row.mutation_id, "mutation ID"),
        payloadDigest: stringField(row.payload_digest, "mutation digest"),
        generation: numberField(row.generation, "mutation generation"),
        firstSequence: numberField(row.first_sequence, "mutation first sequence"),
        lastSequence: numberField(row.last_sequence, "mutation last sequence"),
      }));
    const controls = this.db
      .prepare(
        "SELECT operation_id,action,recorded_at_ms FROM m3_control_requests WHERE run_id=? ORDER BY operation_id",
      )
      .all(runId)
      .map((row) => {
        const actionValue = stringField(row.action, "control action");
        if (actionValue !== "pause" && actionValue !== "cancel") {
          throw new Error("Invalid M3 contention control action");
        }
        const action: "pause" | "cancel" = actionValue;
        return {
          operationId: stringField(row.operation_id, "control operation ID"),
          action,
          recordedAtMs: numberField(row.recorded_at_ms, "control time"),
        };
      });
    return { lease, events, mutations, controls };
  }

  /** Close this process's SQLite connection. */
  close(): void {
    this.db.close();
  }

  private acquire(request: Extract<M3ContentionRequest, { operation: "acquire" }>) {
    return this.transaction((): M3ContentionResponse => {
      const existing = this.readLease(request.runId);
      if (!existing) {
        const token = { runId: request.runId, ownerId: request.ownerId, generation: 1 };
        this.db
          .prepare(
            "INSERT INTO m3_leases(run_id,owner_id,generation,expires_at_ms,released) VALUES(?,?,?,?,0)",
          )
          .run(request.runId, request.ownerId, token.generation, request.nowMs + request.ttlMs);
        return {
          ok: true,
          operation: request.operation,
          token,
          expiresAtMs: request.nowMs + request.ttlMs,
        };
      }
      if (!existing.released) {
        throw new M3ContentionError("ownership-conflict", "Run already has an owner");
      }
      const token = {
        runId: request.runId,
        ownerId: request.ownerId,
        generation: checkedIncrement(existing.generation, 1, "lease generation"),
      };
      this.db
        .prepare(
          "UPDATE m3_leases SET owner_id=?,generation=?,expires_at_ms=?,released=0 WHERE run_id=? AND generation=? AND released=1",
        )
        .run(
          request.ownerId,
          token.generation,
          request.nowMs + request.ttlMs,
          request.runId,
          existing.generation,
        );
      return {
        ok: true,
        operation: request.operation,
        token,
        expiresAtMs: request.nowMs + request.ttlMs,
      };
    });
  }

  private renew(request: Extract<M3ContentionRequest, { operation: "renew" }>) {
    return this.transaction((): M3ContentionResponse => {
      this.requireActiveToken(request.token, request.nowMs);
      const expiresAtMs = request.nowMs + request.ttlMs;
      this.db
        .prepare(
          "UPDATE m3_leases SET expires_at_ms=? WHERE run_id=? AND owner_id=? AND generation=? AND released=0",
        )
        .run(expiresAtMs, request.token.runId, request.token.ownerId, request.token.generation);
      return { ok: true, operation: request.operation, token: request.token, expiresAtMs };
    });
  }

  private takeover(request: Extract<M3ContentionRequest, { operation: "takeover" }>) {
    if (request.liveness === "alive") {
      throw new M3ContentionError("live-owner", "Live owner prevents takeover");
    }
    if (request.liveness === "unknown") {
      throw new M3ContentionError("unknown-owner", "Unknown owner state prevents takeover");
    }
    return this.transaction((): M3ContentionResponse => {
      const existing = this.readLease(request.runId);
      if (
        !existing ||
        existing.released ||
        existing.ownerId !== request.observedOwnerId ||
        existing.generation !== request.observedGeneration ||
        existing.expiresAtMs > request.nowMs
      ) {
        throw new M3ContentionError(
          "ownership-conflict",
          "Observed expired ownership no longer matches",
        );
      }
      const token = {
        runId: request.runId,
        ownerId: request.ownerId,
        generation: checkedIncrement(existing.generation, 1, "lease generation"),
      };
      const expiresAtMs = request.nowMs + request.ttlMs;
      this.db
        .prepare(
          "UPDATE m3_leases SET owner_id=?,generation=?,expires_at_ms=?,released=0 WHERE run_id=? AND owner_id=? AND generation=? AND released=0 AND expires_at_ms<=?",
        )
        .run(
          token.ownerId,
          token.generation,
          expiresAtMs,
          token.runId,
          existing.ownerId,
          existing.generation,
          request.nowMs,
        );
      return { ok: true, operation: request.operation, token, expiresAtMs };
    });
  }

  private release(request: Extract<M3ContentionRequest, { operation: "release" }>) {
    return this.transaction((): M3ContentionResponse => {
      this.requireCurrentToken(request.token);
      this.db
        .prepare(
          "UPDATE m3_leases SET released=1 WHERE run_id=? AND owner_id=? AND generation=? AND released=0",
        )
        .run(request.token.runId, request.token.ownerId, request.token.generation);
      return { ok: true, operation: request.operation, token: request.token };
    });
  }

  private append(request: Extract<M3ContentionRequest, { operation: "append" }>) {
    if (m3ContentionPayloadDigest(request.events) !== request.payloadDigest) {
      throw new M3ContentionError("invalid-request", "Append digest does not match its payload");
    }
    return this.transaction((): M3ContentionResponse => {
      this.requireActiveToken(request.token, request.nowMs);
      const prior = this.db
        .prepare(
          "SELECT payload_digest,first_sequence,last_sequence FROM m3_mutations WHERE run_id=? AND mutation_id=?",
        )
        .get(request.token.runId, request.mutationId);
      if (prior) {
        if (prior.payload_digest !== request.payloadDigest) {
          throw new M3ContentionError(
            "idempotency-conflict",
            "Mutation ID was reused with another payload",
          );
        }
        return {
          ok: true,
          operation: request.operation,
          firstSequence: numberField(prior.first_sequence, "prior first sequence"),
          lastSequence: numberField(prior.last_sequence, "prior last sequence"),
          replayed: true,
        };
      }
      const row = this.db
        .prepare("SELECT max(sequence) AS sequence FROM m3_events WHERE run_id=?")
        .get(request.token.runId);
      const actualSequence = row?.sequence === null ? 0 : numberField(row?.sequence, "event tail");
      if (actualSequence !== request.expectedSequence) {
        throw new M3ContentionError(
          "sequence-conflict",
          `Event tail ${actualSequence} does not match expected sequence`,
        );
      }
      const firstSequence = checkedIncrement(actualSequence, 1, "event sequence");
      const insert = this.db.prepare(
        "INSERT INTO m3_events(run_id,sequence,generation,mutation_id,payload_json) VALUES(?,?,?,?,?)",
      );
      request.events.forEach((event, index) =>
        insert.run(
          request.token.runId,
          firstSequence + index,
          request.token.generation,
          request.mutationId,
          event,
        ),
      );
      const lastSequence = checkedIncrement(
        actualSequence,
        request.events.length,
        "event sequence",
      );
      this.db
        .prepare(
          "INSERT INTO m3_mutations(run_id,mutation_id,payload_digest,generation,first_sequence,last_sequence) VALUES(?,?,?,?,?,?)",
        )
        .run(
          request.token.runId,
          request.mutationId,
          request.payloadDigest,
          request.token.generation,
          firstSequence,
          lastSequence,
        );
      return {
        ok: true,
        operation: request.operation,
        firstSequence,
        lastSequence,
        replayed: false,
      };
    });
  }

  private control(request: Extract<M3ContentionRequest, { operation: "control" }>) {
    return this.transaction((): M3ContentionResponse => {
      const prior = this.db
        .prepare(
          "SELECT action,recorded_at_ms FROM m3_control_requests WHERE run_id=? AND operation_id=?",
        )
        .get(request.runId, request.operationId);
      if (prior) {
        if (prior.action !== request.action) {
          throw new M3ContentionError(
            "idempotency-conflict",
            "Control operation ID was reused with another action",
          );
        }
        return {
          ok: true,
          operation: request.operation,
          action: request.action,
          recordedAtMs: numberField(prior.recorded_at_ms, "prior control time"),
          replayed: true,
        };
      }
      this.db
        .prepare("INSERT INTO m3_control_requests(run_id,operation_id,action) VALUES(?,?,?)")
        .run(request.runId, request.operationId, request.action);
      const inserted = this.db
        .prepare("SELECT recorded_at_ms FROM m3_control_requests WHERE run_id=? AND operation_id=?")
        .get(request.runId, request.operationId);
      return {
        ok: true,
        operation: request.operation,
        action: request.action,
        recordedAtMs: numberField(inserted?.recorded_at_ms, "inserted control time"),
        replayed: false,
      };
    });
  }

  private readLease(runId: string): LeaseRow | null {
    const row = this.db
      .prepare(
        "SELECT run_id,owner_id,generation,expires_at_ms,released FROM m3_leases WHERE run_id=?",
      )
      .get(runId);
    if (!row) {
      return null;
    }
    return {
      runId: stringField(row.run_id, "lease run ID"),
      ownerId: stringField(row.owner_id, "lease owner ID"),
      generation: numberField(row.generation, "lease generation"),
      expiresAtMs: numberField(row.expires_at_ms, "lease expiry"),
      released: numberField(row.released, "lease release") === 1,
    };
  }

  private requireCurrentToken(token: M3ContentionToken): LeaseRow {
    const lease = this.readLease(token.runId);
    if (
      !lease ||
      lease.released ||
      lease.ownerId !== token.ownerId ||
      lease.generation !== token.generation
    ) {
      throw new M3ContentionError("ownership-conflict", "Lease token is stale");
    }
    return lease;
  }

  private requireActiveToken(token: M3ContentionToken, nowMs: number): LeaseRow {
    const lease = this.requireCurrentToken(token);
    if (lease.expiresAtMs <= nowMs) {
      throw new M3ContentionError("ownership-conflict", "Lease token has expired");
    }
    return lease;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
