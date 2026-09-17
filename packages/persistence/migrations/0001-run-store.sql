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

CREATE TABLE run_leases (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  owner_id TEXT NOT NULL CHECK(typeof(owner_id) = 'text' AND length(owner_id) BETWEEN 1 AND 128),
  owner_json TEXT NOT NULL CHECK(typeof(owner_json) = 'text' AND json_valid(owner_json) AND json_type(owner_json) = 'object'),
  owner_digest TEXT NOT NULL CHECK(typeof(owner_digest) = 'text' AND length(owner_digest) = 71 AND owner_digest GLOB 'sha256:*'),
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0),
  acquired_at_ms INTEGER NOT NULL CHECK(typeof(acquired_at_ms) = 'integer' AND acquired_at_ms > 0),
  renewed_at_ms INTEGER NOT NULL CHECK(typeof(renewed_at_ms) = 'integer' AND renewed_at_ms >= acquired_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms) = 'integer' AND expires_at_ms >= renewed_at_ms),
  released INTEGER NOT NULL CHECK(typeof(released) = 'integer' AND released IN (0,1))
);

CREATE TABLE run_mutations (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  operation_id TEXT NOT NULL CHECK(typeof(operation_id) = 'text' AND length(operation_id) BETWEEN 1 AND 128),
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0),
  payload_digest TEXT NOT NULL CHECK(typeof(payload_digest) = 'text' AND length(payload_digest) = 71 AND payload_digest GLOB 'sha256:*'),
  expected_sequence INTEGER NOT NULL CHECK(typeof(expected_sequence) = 'integer' AND expected_sequence >= 0),
  first_sequence INTEGER NOT NULL CHECK(typeof(first_sequence) = 'integer' AND first_sequence > 0),
  last_sequence INTEGER NOT NULL CHECK(typeof(last_sequence) = 'integer' AND last_sequence >= first_sequence),
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms) = 'integer' AND committed_at_ms > 0),
  PRIMARY KEY(run_id, operation_id),
  FOREIGN KEY(run_id, first_sequence) REFERENCES events(run_id, sequence),
  FOREIGN KEY(run_id, last_sequence) REFERENCES events(run_id, sequence)
);

CREATE TABLE control_requests (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  operation_id TEXT NOT NULL CHECK(typeof(operation_id) = 'text' AND length(operation_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('pause','cancel')),
  recorded_at_ms INTEGER NOT NULL CHECK(typeof(recorded_at_ms) = 'integer' AND recorded_at_ms > 0),
  acknowledged_sequence INTEGER CHECK(acknowledged_sequence IS NULL OR (typeof(acknowledged_sequence) = 'integer' AND acknowledged_sequence > 0)),
  PRIMARY KEY(run_id, operation_id),
  FOREIGN KEY(run_id, acknowledged_sequence) REFERENCES events(run_id, sequence)
);

CREATE TABLE event_integrity (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence > 0),
  event_digest TEXT NOT NULL CHECK(typeof(event_digest) = 'text' AND length(event_digest) = 71 AND event_digest GLOB 'sha256:*'),
  history_digest TEXT NOT NULL CHECK(typeof(history_digest) = 'text' AND length(history_digest) = 71 AND history_digest GLOB 'sha256:*'),
  PRIMARY KEY(run_id, sequence),
  FOREIGN KEY(run_id, sequence) REFERENCES events(run_id, sequence)
);

CREATE TABLE run_snapshots (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence > 0),
  version TEXT NOT NULL CHECK(typeof(version) = 'text' AND length(version) BETWEEN 1 AND 128),
  reducer_version TEXT NOT NULL CHECK(typeof(reducer_version) = 'text' AND length(reducer_version) BETWEEN 1 AND 128),
  definition_digest TEXT NOT NULL CHECK(typeof(definition_digest) = 'text' AND length(definition_digest) = 71 AND definition_digest GLOB 'sha256:*'),
  event_prefix_digest TEXT NOT NULL CHECK(typeof(event_prefix_digest) = 'text' AND length(event_prefix_digest) = 71 AND event_prefix_digest GLOB 'sha256:*'),
  state_digest TEXT NOT NULL CHECK(typeof(state_digest) = 'text' AND length(state_digest) = 71 AND state_digest GLOB 'sha256:*'),
  state_json TEXT NOT NULL CHECK(typeof(state_json) = 'text' AND length(CAST(state_json AS BLOB)) <= 4194304),
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms) = 'integer' AND created_at_ms > 0),
  PRIMARY KEY(run_id, sequence, reducer_version)
);

CREATE INDEX pending_control_requests ON control_requests(run_id, acknowledged_sequence, recorded_at_ms, operation_id);
CREATE INDEX newest_run_snapshots ON run_snapshots(run_id, sequence DESC);

CREATE TRIGGER immutable_run_mutations_update BEFORE UPDATE ON run_mutations
BEGIN SELECT RAISE(ABORT,'Run mutations are immutable'); END;
CREATE TRIGGER immutable_run_mutations_delete BEFORE DELETE ON run_mutations
BEGIN SELECT RAISE(ABORT,'Run mutations are immutable'); END;
CREATE TRIGGER immutable_event_integrity_update BEFORE UPDATE ON event_integrity
BEGIN SELECT RAISE(ABORT,'Event integrity is immutable'); END;
CREATE TRIGGER immutable_event_integrity_delete BEFORE DELETE ON event_integrity
BEGIN SELECT RAISE(ABORT,'Event integrity is immutable'); END;
CREATE TRIGGER immutable_control_requests_delete BEFORE DELETE ON control_requests
BEGIN SELECT RAISE(ABORT,'Control requests are immutable'); END;
CREATE TRIGGER controlled_control_acknowledgement BEFORE UPDATE ON control_requests
WHEN NOT (
  OLD.acknowledged_sequence IS NULL
  AND NEW.acknowledged_sequence IS NOT NULL
  AND NEW.run_id = OLD.run_id
  AND NEW.operation_id = OLD.operation_id
  AND NEW.action = OLD.action
  AND NEW.recorded_at_ms = OLD.recorded_at_ms
  AND EXISTS (
    SELECT 1 FROM events
    WHERE events.run_id = NEW.run_id
      AND events.sequence = NEW.acknowledged_sequence
      AND events.event_type = 'ControlRequestObserved'
      AND json_extract(events.event_json, '$.operationId') = NEW.operation_id
      AND json_extract(events.event_json, '$.action') = NEW.action
      AND json_extract(events.event_json, '$.recordedAtMs') = NEW.recorded_at_ms
  )
)
BEGIN SELECT RAISE(ABORT,'Invalid control acknowledgement'); END;
