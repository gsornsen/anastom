CREATE TABLE m3_leases (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1))
);

CREATE TABLE m3_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  mutation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE m3_mutations (
  run_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  first_sequence INTEGER NOT NULL CHECK (first_sequence > 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  PRIMARY KEY (run_id, mutation_id)
);

CREATE TABLE m3_control_requests (
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('pause', 'cancel')),
  recorded_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (run_id, operation_id)
);

CREATE TRIGGER m3_events_update_immutable BEFORE UPDATE ON m3_events
BEGIN SELECT RAISE(ABORT, 'M3 feasibility events are append-only'); END;
CREATE TRIGGER m3_events_delete_immutable BEFORE DELETE ON m3_events
BEGIN SELECT RAISE(ABORT, 'M3 feasibility events are append-only'); END;
CREATE TRIGGER m3_mutations_update_immutable BEFORE UPDATE ON m3_mutations
BEGIN SELECT RAISE(ABORT, 'M3 feasibility mutations are immutable'); END;
CREATE TRIGGER m3_mutations_delete_immutable BEFORE DELETE ON m3_mutations
BEGIN SELECT RAISE(ABORT, 'M3 feasibility mutations are immutable'); END;
CREATE TRIGGER m3_controls_update_immutable BEFORE UPDATE ON m3_control_requests
BEGIN SELECT RAISE(ABORT, 'M3 feasibility controls are immutable'); END;
CREATE TRIGGER m3_controls_delete_immutable BEFORE DELETE ON m3_control_requests
BEGIN SELECT RAISE(ABORT, 'M3 feasibility controls are immutable'); END;
