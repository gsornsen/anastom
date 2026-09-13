# 0004 — Build Fresh Context for Every Agent Attempt

- Status: Accepted
- Date: 2026-09-11

## Context

Implicit transcript inheritance carries irrelevant reasoning, hidden instructions, and failed approaches into later attempts. It prevents the control plane from explaining what information influenced a worker.

## Decision

The control plane constructs a new immutable context envelope for every agent attempt. It contains explicit objectives, acceptance criteria, role, workspace, inputs, selected artifacts, verification, output schema, and budget. The canonical envelope and its digest are persisted before adapter start.

Runtime session history is not authoritative Anastom context. Prior information reaches a new attempt only through a selected durable artifact or evidence reference.

## Consequences

Retries are reproducible and inspectable. Context selection requires explicit code and tests. Useful prior work must be promoted into a durable artifact instead of remaining only in a harness transcript.
