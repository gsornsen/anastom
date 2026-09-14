# Bootstrap Build Brief for Claude Code / Codex

Use this document as the initial implementation brief in a new Anastom repository.

## Mission

Build Milestone M0 only.

Do not begin Pi integration until M0 is complete and reviewed.

## M0 objective

Create a TypeScript monorepo containing a minimal, strongly typed Workflow IR that can:

1. load a YAML workflow;
2. validate it;
3. convert it to normalized internal types;
4. identify executable nodes based on dependency state;
5. emit deterministic transition events;
6. execute nodes through a fake runtime;
7. render workflow status as text;
8. persist/reload a run through an in-memory persistence interface implementation.

Do not implement real LLM calls.

## Required packages

Start with:

```text
packages/core
packages/engine
packages/runtime-contract
packages/runtime-fake
packages/cli
```

Persistence may initially be an interface plus in-memory implementation inside `engine` or a small `persistence` package if separation remains clean.

## Required Workflow IR v0 subset

Support:

- metadata;
- inputs;
- nodes;
- dependency list;
- role;
- node kind:
  - `agent`
  - `command`
  - `gate`
  - `verifier`
- simple attempt policy;
- required output schema reference;
- node status.

Do not implement:

- loops;
- fan-out;
- nested workflows;
- real worktrees;
- dynamic model routing.

The schema should leave room for them.

## Required states

At minimum:

```text
pending
ready
running
blocked
succeeded
failed
paused
cancelled
```

## Runtime contract

Create a fake implementation of the runtime adapter contract documented in `ARCHITECTURE.md`.

The fake runtime must be scriptable by tests so a test can declare:

```text
attempt 1 returns schema error
attempt 2 returns valid output
```

or:

```text
node A succeeds
node B fails verifier twice
```

without any LLM.

## Required CLI

```bash
anastom validate <workflow>
anastom graph <workflow>
anastom run <workflow> --fake-scenario <file>
anastom inspect <run>
```

The exact persistence of `<run>` may remain process-local in M0 if necessary; M1 introduces SQLite durability.

## Engineering constraints

- No harness-specific imports in core or engine.
- No hidden state encoded only in prompts.
- All transitions produce typed events.
- State changes must occur through one transition path.
- Reject invalid structured output.
- Favor pure functions around state transitions.
- Every public boundary must have tests.
- Do not add abstractions solely for hypothetical future needs.
- Do not implement a UI.

## Required tests

1. workflow schema validation;
2. dependency scheduling;
3. successful fake run;
4. schema-invalid fake result;
5. retry exhaustion;
6. verifier pass/fail;
7. event sequence determinism;
8. state reload and continued execution;
9. adapter conformance test example;
10. invalid transition rejection.

## Demo fixture

Create:

```text
examples/workflows/demo-feature.yaml
```

with:

```text
analyze -> implement -> verify
```

The fake scenario should simulate a complete run.

## Completion evidence

M0 is complete only when:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm anastom validate examples/workflows/demo-feature.yaml
pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml
```

all succeed.

Produce a short `docs/M0_RETROSPECTIVE.md` documenting:

- final IR decisions;
- assumptions;
- rejected alternatives;
- anything in the original architecture docs that should change before M1.

## Stop condition

After M0 completion, stop.

Do not opportunistically implement M1.

The next design review should validate whether the Workflow IR and runtime boundary survived contact with the fake execution engine before connecting Anastom to a real coding harness.
