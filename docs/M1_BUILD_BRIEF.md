# M1 Build Brief — Single Worker

## Mission

Build Milestone M1 only: Anastom delegates one bounded software task to Pi in an isolated Git worktree, verifies the result with one deterministic command, and preserves a durable, inspectable run record.

M0 remains the compatibility baseline. Existing fake workflows and evidence commands must continue to pass.

## Demo

From the root of the controlled fixture repository:

```bash
anastom run tasks/add-endpoint.md --runtime pi
```

The command must:

1. strictly parse the Markdown task descriptor;
2. resolve the repository and exact base commit;
3. create an Anastom-owned isolated branch and worktree;
4. compile the task into one agent node followed by one command node;
5. persist the normalized run definition and initial events before starting Pi;
6. build and persist a fresh context envelope;
7. run one ephemeral Pi session rooted at the worktree;
8. validate Pi's structured worker report;
9. execute the declared verification command outside Pi;
10. capture the Git diff and command output as artifacts;
11. complete the run from typed events; and
12. print the run ID, outcome, retained workspace path, and artifact locations.

A later shell invocation must be able to run:

```bash
anastom status <run-id>
anastom inspect <run-id>
```

without access to the original process memory.

## Accepted design

The architecture and IR contracts in `ARCHITECTURE.md` and `WORKFLOW_IR.md` are authoritative for M1. The controlling ADRs are in `docs/adr/`.

M1 uses these boundaries:

- only `agent` nodes cross a real runtime adapter;
- `command` nodes use a deterministic control-plane executor;
- command exit code zero is the M1 acceptance decision;
- Pi receives a newly constructed immutable context for every attempt;
- the control plane creates and owns workspaces;
- SQLite stores immutable run definitions and append-only events;
- the filesystem stores artifact bodies and retained worktrees;
- attempt duration is enforced by the control plane;
- the authoritative node output remains one schema-validated JSON value;
- logs, diffs, reports, and verification output are artifact references.

## Markdown task descriptor

M1 accepts the strict front matter documented in `WORKFLOW_IR.md`. The complete M1 field set is:

```yaml
apiVersion: anastom.dev/v1alpha1
kind: Task
metadata:
  id: string
  version: semver
role: string
workspace:
  mutation: isolated | readonly
acceptanceCriteria:
  - string
verification:
  argv:
    - string
  cwd: optional/workspace/relative/path
  maxDuration: positive-duration
  maxOutputBytes: optional-positive-integer
attemptPolicy:
  maxAttempts: optional-positive-integer
  maxDuration: optional-positive-duration
```

The Markdown body after front matter is a non-empty objective. Unknown fields are rejected. M1 requires `workspace.mutation: isolated` for the end-to-end Pi demo; `readonly` is supported by workspace and context contracts but cannot satisfy a mutating task.

`verification.argv` must be a non-empty string array. It is never joined into a shell command. `cwd` defaults to the workspace root and must remain inside it after path resolution. `maxDuration` is required. `maxOutputBytes` defaults to 1 MiB per stream.

The task compiler produces an immutable internal workflow with stable node IDs `implement` and `verify`. `implement` uses the built-in worker-report JSON Schema. `verify` uses the built-in command-result JSON Schema. These schemas are versioned repository assets and are recorded in the normalized run definition.

## Worker report

The Pi adapter must normalize its final response into:

```ts
type WorkerReport = {
  summary: string;
  changedFiles: string[];
  notes: string[];
};
```

The report describes the attempt; it does not decide whether the task passed. Invalid structured output is a `schema-violation` failure and follows attempt policy.

## Context envelope

Before starting Pi, construct a versioned canonical JSON document containing:

- run, workflow instance, node, and attempt identifiers;
- task ID and version;
- objective and acceptance criteria;
- role ID;
- workspace mode, path, base commit, and allowed mutations;
- validated inputs and dependency outputs;
- selected artifact references;
- verification argument vector and limits;
- required output schema; and
- attempt budget.

Compute a SHA-256 digest from canonical UTF-8 bytes, write the bytes as a run artifact, and append an event referencing the artifact before adapter start. Tests must prove that equal inputs produce equal bytes and that an attempt cannot inherit mutable transcript state from a previous attempt.

## Pi adapter

Create `packages/runtime-pi` implementing `RuntimeAdapter` with the maintained `@earendil-works/pi-coding-agent` SDK. Pin the direct dependency to an exact reviewed version.

Use an in-memory Pi session for each attempt, set its effective working directory to the assigned workspace, subscribe to observable session events, send one prompt derived solely from the context envelope, and dispose the session after collect or cancellation. Use the SDK abort operation for cancellation.

Use Pi's standard authentication and model configuration. Never serialize API keys, OAuth data, complete environment variables, or Pi's private session state. Unit and CI tests must replace the SDK boundary with a deterministic test double and must not make model calls. The real Pi demonstration is an explicit integration check.

## Workspace manager

Create `packages/workspaces` with a Git worktree implementation. The manager must:

- verify the repository and cleanly resolve `HEAD` to a commit;
- create names derived from run IDs under an Anastom namespace;
- create a new branch and worktree without shell interpolation;
- reject paths and branches it does not own;
- record repository root, base commit, branch, worktree path, and final head;
- expose diff capture and explicit cleanup operations;
- retain the workspace after success or failure by default; and
- behave safely if cleanup is called more than once.

Tests use temporary fixture repositories. They must prove that the source checkout is unchanged and that cleanup refuses an unowned directory.

Repository-local state defaults to `.anastom/`, which is ignored by Git:

```text
.anastom/
  anastom.sqlite
  runs/<run-id>/artifacts/
  worktrees/<run-id>/
```

The contract review validated this nested ignored layout with Git on macOS. Implementation tests must validate it on every supported CI platform. A portability-driven fallback requires a documented contract update and the same ownership guarantees.

## Command executor

Create a small control-plane command executor rather than a second runtime adapter. It receives an argument vector, workspace, relative working directory, duration, output cap, and environment policy.

Required behavior:

- use a process API with `shell: false`;
- reject an empty argument vector and working-directory escapes;
- do not accept task-authored environment values in M1;
- capture stdout and stderr separately;
- terminate on timeout with a bounded grace period;
- continue draining or deliberately truncate output without unbounded memory growth;
- record exit code, signal, duration, byte counts, and truncation flags;
- return a typed tool or budget failure on nonzero exit or timeout; and
- write captured output as artifacts even when verification fails.

## SQLite persistence

Create `packages/persistence` and implement the existing `RunPersistence` interface with Node's SQLite support unless an implementation test demonstrates a portability or correctness gap.

The initial schema contains only `runs` and `events`. It must enforce:

- primary key uniqueness for run IDs;
- foreign keys from events to runs;
- unique `(run_id, sequence)` ordering;
- immutable workflow JSON and digest after creation;
- transactional create and append operations;
- optimistic expected-sequence conflicts; and
- validated deserialization before replay.

Open the same database from a second persistence instance in tests to prove cross-process-equivalent durability. Corrupt JSON, missing events, mismatched run IDs, or invalid workflow digests must fail closed with actionable errors.

## Timeout policy

Add the minimum events needed to distinguish a requested timeout, successful cancellation, cancellation failure, and final timed-out attempt. A timeout is a `budget-exhausted` failure and consumes an attempt.

The first terminal outcome wins. Late adapter output can be stored as diagnostic evidence but cannot overwrite the timed-out state. Use injected timer control for deterministic tests; do not make the test suite wait on real multi-second deadlines.

## CLI behavior

Preserve the M0 commands. Add:

```text
anastom run <task.md> --runtime pi [--repo <path>]
anastom status <run-id> [--state-dir <path>]
anastom inspect <run-id> [--state-dir <path>] [--json]
```

Human output goes to stdout. Actionable errors go to stderr and return a nonzero exit status. `run` prints the run ID immediately after durable creation so a failure can still be inspected.

`status` shows the current run and node outcomes. `inspect` shows the immutable task/workflow identity, workspace, attempts, event sequence, context and artifact references, verifier result, and failures. Secret material and unrestricted environment dumps are never rendered.

## Required packages

Add only packages justified by the vertical slice:

```text
packages/persistence
packages/workspaces
packages/runtime-pi
```

The command executor and context builder may remain in `engine` until a second consumer proves a cleaner package boundary.

## Required tests

M1 is incomplete without focused evidence for:

1. strict Markdown task parsing and compilation;
2. M0 Workflow IR compatibility plus M1 field validation;
3. canonical context serialization and digest stability;
4. fresh context on retry;
5. SQLite create, append, reopen, conflict, and corrupt-data handling;
6. isolated worktree creation, source-checkout isolation, diff capture, ownership, and cleanup;
7. command success, nonzero exit, timeout, output truncation, and working-directory escape rejection;
8. execution dispatch that sends only agent nodes to Pi;
9. Pi adapter event mapping, structured-result validation, cancellation, and disposal through a test double;
10. timeout-versus-late-result first-terminal-outcome behavior;
11. durable `status` and `inspect` from a separate CLI invocation;
12. end-to-end task execution against a deterministic adapter in the controlled demo repository; and
13. one explicitly invoked real Pi run producing a valid change and passing command verification.

## Controlled fixture

Add a small, dependency-light HTTP repository below `examples/demo-repos/m1-endpoint/` with a failing acceptance test and a task at `tasks/add-endpoint.md`. The fixture must be quick to copy into a temporary Git repository and must not require network access after dependencies are installed.

The real Pi evidence must operate on a temporary copy, never on Anastom's own working tree.

## Completion evidence

All M0 evidence must continue to succeed:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm anastom validate examples/workflows/demo-feature.yaml
pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml
```

M1 additionally requires:

```bash
pnpm anastom run examples/demo-repos/m1-endpoint/tasks/add-endpoint.md --runtime fake --repo <temporary-fixture-repo>
pnpm anastom status <run-id> --state-dir <temporary-fixture-repo>/.anastom
pnpm anastom inspect <run-id> --state-dir <temporary-fixture-repo>/.anastom
pnpm anastom run examples/demo-repos/m1-endpoint/tasks/add-endpoint.md --runtime pi --repo <temporary-fixture-repo>
```

The final evidence record must include versions of Node, pnpm, Pi SDK, selected provider/model, operating system, the sanitized run ID, terminal outcome, verifier exit code, workflow/context/artifact digests, and the retained diff. It must not contain credentials or private model reasoning.

## Explicit exclusions

Do not implement:

- Codex or another real adapter;
- dynamic model or runtime routing;
- capability-based scheduling;
- multiple workers, fan-out, fan-in, or integration branches;
- nested workflows or methodology packages;
- human gates or intervention;
- pause, resume, live attempt recovery, snapshots, leases, or orphan detection;
- shared or external workspace modes;
- shell command strings;
- arbitrary environment injection;
- multiple task verifiers;
- generalized artifact/evidence graphs;
- UI, API server, or cloud deployment; or
- real model calls in automated tests.

## Stop condition

Stop after the single Pi worker completes the controlled task, the deterministic command passes, a later process can inspect the durable run, every required test passes, and the completion evidence is recorded. Do not begin M2 portability work.
