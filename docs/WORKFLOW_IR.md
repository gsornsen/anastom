# Workflow IR

## Purpose

The Workflow IR is the most important design surface in Anastom.

It must be expressive enough to encode engineering methodologies without embedding model- or harness-specific behavior.

## Design goals

- declarative where possible;
- deterministic transition semantics;
- typed inputs and outputs;
- composable;
- versioned;
- inspectable;
- testable without an LLM;
- serializable;
- safe to evolve.

## Proposed v0 shape

```yaml
apiVersion: anastom.dev/v1alpha1
kind: Workflow

metadata:
  id: debug/hypothesis
  version: 0.1.0

inputs:
  issue:
    schema: ./schemas/issue.json

state:
  reproduction:
    schema: ./schemas/reproduction.json
  hypotheses:
    schema: ./schemas/hypothesis-list.json
  evidence:
    schema: ./schemas/evidence-list.json

policies:
  defaultAttemptBudget:
    maxAttempts: 2
    maxDuration: 20m

nodes:
  reproduce:
    kind: agent
    role: debugger
    mutation: readonly
    produces:
      - reproduction
    verify:
      - type: schema
        artifact: reproduction
      - type: expression
        condition: "outputs.reproduction.observed == true"

  hypothesize:
    kind: agent
    role: diagnostician
    needs: [reproduce]
    mutation: readonly
    produces:
      - hypotheses

  experiment:
    kind: agent
    role: experimenter
    needs: [hypothesize]
    mutation: controlled
    loop:
      until: "state.hypotheses.top.confidence >= 0.85"
      maxIterations: 6

  fix:
    kind: workflow
    workflow: sdlc/patch
    when: "state.hypotheses.top.confidence >= 0.85"

  verify:
    kind: verifier
    needs: [fix]
```

The exact syntax should remain provisional until M0/M1.

## Node kinds to start with

Do not create twenty node kinds.

Start with:

### `agent`
Execute one bounded model/harness task.

### `command`
Execute a deterministic process.

### `gate`
Require a condition or human approval.

### `fanout`
Instantiate children over a list.

### `fanin`
Aggregate children.

### `workflow`
Call another workflow.

### `verifier`
Evaluate evidence/acceptance criteria.

Later, add specialized constructs only if these are insufficient.

## Roles

Roles should define capabilities, not vendor assignments:

```yaml
roles:
  planner:
    requires:
      reasoning: high
      context: high
      instructionFollowing: high
    prefers:
      cost: medium

  bounded-implementer:
    requires:
      toolUse: high
      instructionFollowing: high
    prefers:
      cost: low
```

A routing policy resolves role -> runtime/model.

## Artifacts and evidence

Every workflow-relevant output should have:

```ts
type ArtifactRef = {
  id: string;
  type: string;
  schemaVersion: string;
  uri: string;
  producer: AttemptRef;
  digest: string;
};
```

Evidence wraps artifacts or observations with meaning:

```ts
type Evidence = {
  claim?: string;
  direction: "supports" | "contradicts" | "neutral";
  strength?: number;
  source: ArtifactRef | ObservationRef;
};
```

## Hypothesis entity

A useful canonical representation:

```ts
type Hypothesis = {
  id: string;
  statement: string;
  confidence: number;

  supports: EvidenceRef[];
  contradicts: EvidenceRef[];

  assumptions: string[];

  nextExperiment?: {
    objective: string;
    discriminatesAgainst: string[];
    expectedIfTrue: string;
    expectedIfFalse: string;
    costEstimate?: string;
  };
};
```

The confidence field does not have to be mathematically Bayesian in the MLP; the key is that changes must cite evidence.

## Verification as a first-class node

A verifier should return structured data:

```ts
type VerificationResult = {
  passed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    evidence: ArtifactRef[];
    summary: string;
  }>;
};
```

A model may help interpret a result, but the pass/fail owner should be deterministic wherever possible.

## Nested workflows

Nested workflows need scoped state:

```text
parent run
  sdlc/default
    implementation node
      call debug/hypothesis
        local hypotheses
        local evidence
      return:
        fixArtifact
        verificationArtifact
```

The child should receive explicitly mapped inputs and return explicitly mapped outputs.

Do not implicitly share all parent state.

## Methodology packages

Suggested layout:

```text
methodologies/
  sdlc/
    default/
      workflow.yaml
      roles.yaml
      prompts/
      schemas/
      evaluators/
      README.md

  debug/
    hypothesis/
      workflow.yaml
      ...

  tdd/
    delegated/
      workflow.yaml
      ...
```

## Workflow testing

Every methodology should support deterministic tests with the fake runtime:

```text
given fake planner returns Plan A
and worker 1 passes
and worker 2 fails verifier twice
expect circuit breaker
expect diagnostics transition
expect no third mutation attempt
```

This should become one of Anastom's strongest quality practices.

## Design constraint

If a methodology requires hidden prompt behavior to remain correct, the Workflow IR is missing a primitive.
