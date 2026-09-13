# 0007 — Use SQLite Before Distributed Workflow Infrastructure

- Status: Accepted
- Date: 2026-09-11

## Context

M1 needs run history that survives CLI processes, but it does not need distributed scheduling. Introducing a workflow service before Anastom's local semantics are stable would let infrastructure choices define the product model.

## Decision

M1 stores immutable run definitions and append-only events in SQLite and stores artifact bodies on the local filesystem. The persistence interface retains optimistic sequence checks. Node, attempt, snapshot, lease, and projection tables are deferred until their behavior is required.

Postgres, Redis, or Temporal may implement established Anastom semantics in later milestones. They do not define those semantics.

## Consequences

Local runs become inspectable across processes with a small operational footprint. M1 durability does not imply recovery of an in-flight external attempt; leases, orphan detection, and resume belong to M3.
