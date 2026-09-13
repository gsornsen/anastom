# 0003 — Make Append-Only Events the Transition Authority

- Status: Accepted
- Date: 2026-09-11

## Context

Long-running orchestration needs an explainable history. Updating status rows in place would lose why a transition occurred and make replay, conflict detection, and later recovery harder to reason about.

## Decision

All authoritative state changes occur by validating and appending typed run events. Run state is reconstructed by replaying events in per-run sequence order. Persistence appends compare an expected sequence and reject conflicts.

Immutable run configuration is stored beside the event stream with a content digest. Database timestamps support inspection but do not determine transition order.

## Consequences

Transitions remain auditable and deterministic under an injected environment. New behavior generally requires a typed event and reducer rule. Snapshots and query projections may improve performance later, but they remain derived data.
