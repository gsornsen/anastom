# 0002 — Use a Strict, Versioned Workflow IR

- Status: Accepted
- Date: 2026-09-11

## Context

Engineering policy hidden in prompts cannot be validated, inspected, or replayed. A permissive configuration format would also turn misspellings and unsupported ideas into silent behavior changes.

## Decision

Workflow documents use a versioned serialized contract beginning with `anastom.dev/v1alpha1`. Validation rejects unknown fields and unsupported node kinds. JSON Schema validates serialized data, and a semantic pass validates graph rules before normalization.

Every accepted field must have normalized types, execution semantics, and boundary tests. Future examples do not become accepted syntax until those pieces exist.

## Consequences

The language evolves deliberately and may require explicit migrations while it is alpha. Authors receive early errors instead of prompt-dependent fallback behavior. The accepted subset can be executed and tested without a model.
