---
"@anastom/engine": minor
"@anastom/persistence": minor
---

Add the engine-owned M3 durable run-store contract, snapshot and rolling-integrity helpers, stable typed errors, and an in-memory reference implementation with the production lease and fencing semantics.

Add the additive SQLite durable-store migration and implementation with transaction-time leases, exact expired-owner takeover, fenced idempotent event batches, deduplicated controls, rolling event integrity, rebuildable snapshot fallback, and unchanged legacy history bytes.
