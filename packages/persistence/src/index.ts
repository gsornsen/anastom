import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertWorkflowDefinition, canonicalJson, digestBytes } from "@anastom/core";
import { PersistenceConflictError, replayRun, type PersistedRun, type RunEvent, type RunPersistence } from "@anastom/engine";

export class SqliteRunPersistence implements RunPersistence {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, workflow_digest TEXT NOT NULL, workflow_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(run_id), sequence INTEGER NOT NULL CHECK(sequence > 0),
        event_type TEXT NOT NULL, event_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY(run_id, sequence)
      );
      CREATE TRIGGER IF NOT EXISTS immutable_runs BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'Run definitions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_runs_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'Runs are immutable'); END;
    `);
  }
  async create(runId: string, run: PersistedRun): Promise<void> {
    assertWorkflowDefinition(run.workflow);
    const state = replayRun(run.events);
    if (state.runId !== runId || state.workflowId !== run.workflow.metadata.id || state.workflowVersion !== run.workflow.metadata.version || Object.keys(state.nodes).join(",") !== run.workflow.nodeOrder.join(",")) throw new Error("Run history does not match its definition");
    const json = canonicalJson(run.workflow);
    this.transaction(() => {
      if (this.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId)) throw new PersistenceConflictError("Run already exists: " + runId);
      this.db.prepare("INSERT INTO runs(run_id,workflow_digest,workflow_json) VALUES(?,?,?)").run(runId, digestBytes(json), json);
      this.insert(runId, run.events);
    });
  }
  async append(runId: string, expectedSequence: number, events: readonly RunEvent[]): Promise<void> {
    this.transaction(() => {
      const run = this.read(runId);
      if (!run) throw new PersistenceConflictError("Run does not exist: " + runId);
      const actual = run.events.at(-1)?.sequence ?? 0;
      if (actual !== expectedSequence) throw new PersistenceConflictError(`Run ${runId} is at sequence ${actual}; expected ${expectedSequence}`);
      replayRun([...run.events, ...events]);
      this.insert(runId, events);
    });
  }
  async load(runId: string): Promise<PersistedRun | null> { return this.read(runId); }
  close(): void { this.db.close(); }
  private read(runId: string): PersistedRun | null {
    const row = this.db.prepare("SELECT workflow_digest,workflow_json FROM runs WHERE run_id = ?").get(runId);
    if (!row) return null;
    if (typeof row.workflow_json !== "string" || digestBytes(row.workflow_json) !== row.workflow_digest) throw new Error("Corrupt workflow digest for run " + runId);
    let workflow: unknown;
    try { workflow = JSON.parse(row.workflow_json); } catch { throw new Error("Corrupt workflow JSON for run " + runId); }
    assertWorkflowDefinition(workflow);
    const rows = this.db.prepare("SELECT sequence,event_type,event_json FROM events WHERE run_id = ? ORDER BY sequence").all(runId);
    const events = rows.map((row) => {
      if (typeof row.event_json !== "string") throw new Error("Corrupt event data");
      let event: unknown;
      try { event = JSON.parse(row.event_json); } catch { throw new Error("Corrupt event JSON for run " + runId); }
      // Replay validates payload shape before any value is trusted.
      if (!event || typeof event !== "object" || !("runId" in event) || !("sequence" in event) || !("type" in event)) throw new Error("Corrupt event identity for run " + runId);
      if (event.runId !== runId || event.sequence !== row.sequence || event.type !== row.event_type) throw new Error("Corrupt event identity for run " + runId);
      return event as RunEvent;
    });
    const state = replayRun(events);
    if (state.workflowId !== workflow.metadata.id || state.workflowVersion !== workflow.metadata.version || Object.keys(state.nodes).join(",") !== workflow.nodeOrder.join(",")) throw new Error("Run definition and history disagree");
    return { workflow, events };
  }
  private insert(runId: string, events: readonly RunEvent[]): void {
    const stmt = this.db.prepare("INSERT INTO events(run_id,sequence,event_type,event_json) VALUES(?,?,?,?)");
    for (const event of events) {
      if (event.runId !== runId) throw new Error("Mismatched event run ID");
      stmt.run(runId, event.sequence, event.type, canonicalJson(event));
    }
  }
  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
export * from "./artifacts.js";
