CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  workflow_digest TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(run_id, sequence)
);

CREATE TRIGGER immutable_runs BEFORE UPDATE ON runs
BEGIN SELECT RAISE(ABORT,'Run definitions are immutable'); END;
CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
CREATE TRIGGER immutable_runs_delete BEFORE DELETE ON runs
BEGIN SELECT RAISE(ABORT,'Runs are immutable'); END;
