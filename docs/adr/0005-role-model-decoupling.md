# 0005 — Keep Roles Independent from Models and Harnesses

- Status: Accepted
- Date: 2026-09-11

## Context

Embedding provider, model, or harness names in workflow roles makes methodologies vendor-specific and turns runtime upgrades into workflow edits.

## Decision

A role is a semantic capability request for an `agent` node. Deterministic node kinds have no role. Model and runtime selection are deployment concerns outside the role definition.

M1 selects Pi explicitly at the CLI and lets Pi use its configured provider and model. Capability negotiation and portable role routing begin in M2.

## Consequences

The same role can later run through different adapters. M1 does not claim cross-runtime parity. Runtime and model identity still enter the execution record for inspection when available.
