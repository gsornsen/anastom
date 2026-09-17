---
"@anastom/engine": minor
"@anastom/persistence": minor
---

Add the engine-owned durable run-store contract, snapshot and rolling-integrity helpers, stable typed errors, and an in-memory reference implementation with the production lease and fencing semantics.

Add the initial SQLite durable-store schema and implementation with transaction-time leases, exact expired-owner takeover, fenced idempotent event batches, deduplicated controls, rolling event integrity, rebuildable snapshot fallback, rejection of unjournaled existing schemas, and an explicit requirement for a caller-authorized existing parent directory.
