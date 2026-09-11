# 0006 — Reserve Runtime Adapters for Agent Attempts

- Status: Accepted
- Date: 2026-09-11

## Context

M0 sent agent, command, gate, and verifier nodes through a fake runtime to exercise one deterministic test seam. Carrying that shortcut into a real adapter would ask a model harness to own shell verification and authorization decisions.

## Decision

Real runtime adapters execute `agent` nodes only. Deterministic commands use a control-plane command executor. General verifier plugins and gate providers use dedicated control-plane interfaces when their milestones define them.

M1 fails unsupported executable node kinds before starting an attempt. Its verification step is a deterministic `command` node.

## Consequences

Pi cannot declare its own work accepted. Command execution and runtime execution have different contracts and failure handling. The fake adapter may continue to support all M0 node kinds for transition tests.
