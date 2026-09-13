# Workflow IR

## Status

`anastom.dev/v1alpha1` is an experimental, strictly validated format. This document separates the compatible M0 profile, implemented M1 additions, and later design directions so examples cannot silently become APIs.

The parser rejects unknown fields, unknown node kinds, invalid schema references, missing dependencies, self-dependencies, duplicate dependencies, and dependency cycles. A field described under a future direction is not accepted until its milestone adds validation, normalized types, execution semantics, and tests.

## Purpose

The Workflow IR describes engineering policy without embedding model- or harness-specific behavior. It must remain versioned, deterministic, typed, inspectable, serializable, and executable with a fake runtime.

## Implemented M0 profile

The compatible M0 authored shape is:

```yaml
apiVersion: anastom.dev/v1alpha1
kind: Workflow

metadata:
  id: feature/demo
  version: 0.1.0

inputs:
  request:
    schema: ../schemas/request.json

policies:
  defaultAttemptBudget:
    maxAttempts: 2
    maxDuration: 20m

nodes:
  analyze:
    kind: agent
    role: analyst
    output:
      schema: ../schemas/analysis.json

  implement:
    kind: agent
    role: implementer
    needs: [analyze]
    output:
      schema: ../schemas/implementation.json

  verify:
    kind: verifier
    needs: [implement]
    output:
      schema: ../schemas/verification.json
```

All declared inputs are required. Unknown input names are rejected. JSON Schema validates each input value.

Every node has exactly one authoritative structured output. `output.schema` is resolved relative to the workflow file and embedded in the normalized definition. Artifact files, logs, diffs, and command evidence are separate records; they do not become additional authoritative node outputs.

`needs` contains node IDs. Declaration order is the stable scheduling tie-breaker. M0 executes one ready node at a time.

`role` is required for `agent` nodes and rejected for deterministic node kinds. A role expresses requested capability; it does not select a model or harness.

`maxAttempts` defaults to one. `maxDuration` accepts a positive integer followed by `ms`, `s`, `m`, or `h`, within the process timer range. M1 enforces declared adapter attempt durations in the control plane, including fake attempts. Commands enforce their own required duration limit.

## Implemented node semantics

### `agent`

Requests one bounded harness attempt. The adapter result must satisfy the node output schema.

### `command`

Crosses the fake runtime boundary in M0. M1 gives it deterministic process semantics through the control plane. It does not acquire a role or model assignment.

### `gate`

Crosses the fake runtime boundary in M0 so blocked transitions can be tested. Human approval, resume, and condition syntax remain outside M1.

### `verifier`

Crosses the fake runtime boundary in M0. Its schema-valid output must also contain a boolean `passed`. `passed: false` is a verification failure and consumes an attempt.

M1 command verification uses a deterministic `command` node. General verifier plugins and model-assisted review remain later work.

## M1 additions

M1 adds only the authored information needed for one real worker:

- an `agent` node declares `mutation: readonly | isolated`;
- a `command` node declares a non-shell `argv` vector, a workspace-relative working directory, a duration limit, and an output-size limit;
- normalized runs retain a digest of the exact workflow definition used to create them;
- execution records may reference named artifacts such as a diff, command stdout, command stderr, and a worker report.

The implementation must reject `shared-integration`, `external`, shell strings, undeclared environment injection, absolute command working directories, and other unimplemented modes. These additions remain part of `v1alpha1`; compatibility is documented in the M1 build brief and exercised by parser tests before a real adapter can consume them.

The authored command fields are nested under `command`:

```yaml
verify:
  kind: command
  needs: [implement]
  command:
    argv: [node, --test, server.test.mjs]
    cwd: .
    maxDuration: 30s
    maxOutputBytes: 1048576
  output:
    schema: command-result.json
```

`cwd` defaults to `.`; `maxOutputBytes` defaults to 1 MiB per stream and is capped at 16 MiB. `argv` and `maxDuration` are required when `command` is supplied. Only agent nodes accept `mutation`; only command nodes accept `command`. Legacy fake command nodes may omit the process configuration, while worker execution rejects them before an attempt.

## Markdown task descriptor

The M1 demo accepts a Markdown task because bounded engineering work is more readable as prose than as a workflow graph. A task descriptor is a CLI input format, not a second workflow language. The CLI strictly validates its YAML front matter and compiles it into one `agent` node followed by one deterministic `command` node.

```markdown
---
apiVersion: anastom.dev/v1alpha1
kind: Task
metadata:
  id: demo/add-endpoint
  version: 0.1.0
role: bounded-implementer
workspace:
  mutation: isolated
acceptanceCriteria:
  - GET /health returns HTTP 200 with a JSON status body.
verification:
  argv: [pnpm, test]
  maxDuration: 5m
---

# Add a health endpoint

Implement the endpoint using the repository's existing conventions.
```

The Markdown body is the objective. Front matter is policy. Prose cannot override the workspace, verification, budget, or output contract. M1 supports exactly one command verifier in a task descriptor; multiple verifiers and user-authored task-to-workflow templates require a later decision.

Optional `attemptPolicy.maxAttempts` and `attemptPolicy.maxDuration` default independently to one attempt and ten minutes. The compiler assigns stable node IDs `implement` and `verify` and embeds the [worker-report](../packages/core/schemas/worker-report.v1alpha1.json) and [command-result](../packages/core/schemas/command-result.v1alpha1.json) schemas. See the [demo guide](M1_DEMO.md) for execution, environment, and isolation limits.

## Artifacts and evidence

M1 introduces artifact references without turning every artifact into workflow state:

```ts
type ArtifactRef = {
  id: string;
  type: string;
  mediaType: string;
  uri: string;
  digest: string; // sha256:<64 lowercase hex digits>
  producer: {
    runId: string;
    nodeId: string;
    attempt: number;
  };
  digest: string;
};
```

The digest covers the stored bytes. Artifact metadata belongs in the durable run history; artifact bodies belong in the run artifact directory. M1 does not add an evidence graph, confidence score, named workflow state slots, or multi-output node transitions.

## Deferred directions

The following concepts remain design intent rather than accepted syntax:

- optional inputs and defaults;
- `fanout` and `fanin`;
- loops and expressions;
- nested `workflow` calls and explicit parent/child mappings;
- shared integration workspaces;
- human approval gates and resume;
- named authoritative outputs and workflow state slots;
- role-to-model routing and runtime capability requirements;
- evidence graphs and hypothesis entities.

When added, nested workflows must receive explicitly mapped inputs and return explicitly mapped outputs. They must not inherit all parent state or transcript history.

## Methodology packages

Methodologies are versioned data, prompts, schemas, and deterministic evaluators composed from accepted IR primitives:

```text
methodologies/
  sdlc/default/
    workflow.yaml
    roles.yaml
    prompts/
    schemas/
    evaluators/
    README.md
```

Every methodology must support deterministic fake-runtime tests. If correctness depends on an unrecorded prompt convention, the Workflow IR or control-plane contract is missing a primitive.
