---
"@anastom/path-policy": minor
"@anastom/runtime-contract": minor
"@anastom/workspaces": minor
"@anastom/persistence": patch
---

Add a fixed-segment private-state root with current-user ownership, exact private modes, bounded descriptor reads, atomic record replacement, immutable exclusive publication, and socket-path limits. Use it for workspace ownership records and artifact parent creation, and atomically publish synced immutable artifacts without replacement.

Add an exact versioned workspace-checkpoint schema and production capture/comparison APIs. Checkpoints preserve staging, capture twice, stream ignored content within reviewed entry and byte limits, enforce the binary diff limit, and bind canonical Git and ownership evidence.
