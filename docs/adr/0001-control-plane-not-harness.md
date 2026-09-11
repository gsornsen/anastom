# 0001 — Anastom Is a Control Plane, Not an Agent Harness

- Status: Accepted
- Date: 2026-09-11

## Context

Coding harnesses already own model communication, tool loops, editor integration, and session mechanics. Reimplementing those capabilities would couple Anastom's methodology to another harness and blur who owns workflow decisions.

## Decision

Anastom owns workflow state, scheduling, policy, budgets, context construction, workspace assignment, verification, and durable history. A runtime adapter delegates one bounded agent attempt to a harness and normalizes observable events and results.

Harness output cannot directly mutate authoritative workflow state. The control plane validates the output and records a typed transition.

## Consequences

Harness-specific code stays in adapter packages. Anastom can replace a harness without changing workflow semantics. Some harness-native orchestration features remain unused because using them would create a second source of scheduling or recovery truth.
