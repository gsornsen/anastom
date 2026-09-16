import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.js";
import { assertWorkflowDefinition, canonicalJson, digestBytes } from "@anastom/core";
import {
  PersistenceConflictError,
  assertStateMatchesWorkflow,
  replayRun,
  type PersistedRun,
  type RunEvent,
  type RunPersistence,
} from "@anastom/engine";

/**
 * Durable immutable workflow snapshots and append-only events backed by versioned SQLite migrations.
 */
export class SqliteRunPersistence implements RunPersistence {
  private readonly db: DatabaseSync;
  /**
   * Open SQLite, apply and validate versioned migrations, and close the connection if initialization fails.
   * @remarks Parent directories are created as needed; :memory: is supported for tests.
   */
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
      );
      applyMigrations(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /**
   * Atomically store a canonical workflow definition and matching validated history; reject duplicate IDs.
   */
  async create(runId: string, run: PersistedRun): Promise<void> {
    assertWorkflowDefinition(run.workflow);
    const state = replayRun(run.events);
    if (state.runId !== runId) {
      throw new Error("Run history does not match its definition");
    }
    assertStateMatchesWorkflow(state, run.workflow);
    const json = canonicalJson(run.workflow);
    this.transaction(() => {
      if (this.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId)) {
        throw new PersistenceConflictError("Run already exists: " + runId);
      }
      this.db
        .prepare("INSERT INTO runs(run_id,workflow_digest,workflow_json) VALUES(?,?,?)")
        .run(runId, digestBytes(json), json);
      this.insert(runId, run.events);
    });
  }
  /**
   * Compare the expected sequence under an immediate transaction and append the whole validated batch.
   */
  async append(
    runId: string,
    expectedSequence: number,
    events: readonly RunEvent[],
  ): Promise<void> {
    this.transaction(() => {
      const run = this.read(runId);
      if (!run) {
        throw new PersistenceConflictError("Run does not exist: " + runId);
      }
      const actual = run.events.at(-1)?.sequence ?? 0;
      if (actual !== expectedSequence) {
        throw new PersistenceConflictError(
          `Run ${runId} is at sequence ${actual}; expected ${expectedSequence}`,
        );
      }
      replayRun([...run.events, ...events]);
      this.insert(runId, events);
    });
  }
  /**
   * Read and validate stored digests, definition, identities, and replay; return null if absent.
   */
  async load(runId: string): Promise<PersistedRun | null> {
    return this.read(runId);
  }
  /**
   * Release the SQLite connection after the caller has finished using the store.
   */
  close(): void {
    this.db.close();
  }
  private read(runId: string): PersistedRun | null {
    const row = this.db
      .prepare("SELECT workflow_digest,workflow_json FROM runs WHERE run_id = ?")
      .get(runId);
    if (!row) {
      return null;
    }
    if (
      typeof row.workflow_json !== "string" ||
      digestBytes(row.workflow_json) !== row.workflow_digest
    ) {
      throw new Error("Corrupt workflow digest for run " + runId);
    }
    let workflow: unknown;
    try {
      workflow = JSON.parse(row.workflow_json);
    } catch {
      throw new Error("Corrupt workflow JSON for run " + runId);
    }
    assertWorkflowDefinition(workflow);
    const rows = this.db
      .prepare(
        "SELECT sequence,event_type,event_json FROM events WHERE run_id = ? ORDER BY sequence",
      )
      .all(runId);
    const events = rows.map((row) => {
      if (typeof row.event_json !== "string") {
        throw new Error("Corrupt event data");
      }
      let event: unknown;
      try {
        event = JSON.parse(row.event_json);
      } catch {
        throw new Error("Corrupt event JSON for run " + runId);
      }
      // Replay validates payload shape before any value is trusted.
      if (
        !event ||
        typeof event !== "object" ||
        !("runId" in event) ||
        !("sequence" in event) ||
        !("type" in event)
      ) {
        throw new Error("Corrupt event identity for run " + runId);
      }
      if (
        event.runId !== runId ||
        event.sequence !== row.sequence ||
        event.type !== row.event_type
      ) {
        throw new Error("Corrupt event identity for run " + runId);
      }
      return event as RunEvent;
    });
    const state = replayRun(events);
    assertStateMatchesWorkflow(state, workflow);
    return { workflow, events };
  }
  private insert(runId: string, events: readonly RunEvent[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO events(run_id,sequence,event_type,event_json) VALUES(?,?,?,?)",
    );
    for (const event of events) {
      if (event.runId !== runId) {
        throw new Error("Mismatched event run ID");
      }
      stmt.run(runId, event.sequence, event.type, canonicalJson(event));
    }
  }
  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
export * from "./artifacts.js";
export { SqliteDurableRunStore } from "./durable-store.js";
