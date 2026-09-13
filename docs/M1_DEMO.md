# M1 single-worker demo

Run these commands from the Anastom checkout with Node.js 24 or newer and pnpm 11.9.0. Install dependencies with `pnpm install --frozen-lockfile`.

## Deterministic run

The setup helper copies `examples/demo-repos/m1-endpoint/` into a temporary Git repository and commits its initial state using a fixture identity. Its two acceptance tests require `GET /health` to return `{ "status": "ok" }` and unmatched routes to return 404. The initial implementation intentionally fails the health test.

```bash
fixture="$(pnpm exec tsx scripts/create-m1-fixture.ts)"
pnpm anastom validate examples/demo-repos/m1-endpoint/tasks/add-endpoint.md
pnpm anastom graph examples/demo-repos/m1-endpoint/tasks/add-endpoint.md
pnpm anastom run examples/demo-repos/m1-endpoint/tasks/add-endpoint.md \
  --runtime fake --fake-scenario examples/fake/m1-endpoint.yaml --repo "$fixture"
```

Copy the printed run ID into later invocations:

```bash
pnpm anastom status <run-id> --state-dir "$fixture/.anastom"
pnpm anastom inspect <run-id> --state-dir "$fixture/.anastom"
pnpm anastom inspect <run-id> --state-dir "$fixture/.anastom" --json
git -C "$fixture" status --short
```

`status` reconstructs node outcomes from SQLite. `inspect` includes the immutable definition digest, exact base commit, retained branch/worktree, final head, attempts, command exit/signal, failures, artifact paths/digests, and sequenced events. JSON inspection also includes the normalized definition. These commands do not initialize Pi or require model credentials.

The fake scenario supplies an explicit file edit and a structured report. The actual verifier still runs `node --test server.test.mjs` outside the worker. The source checkout remains unchanged; only the owned worktree receives the implementation.

## Live Pi run

The maintained Pi SDK is pinned to `@earendil-works/pi-coding-agent@0.85.1` (MIT). See its [official SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md). A global Pi installation is optional: the pinned dependency supplies the CLI for login.

Authenticate in your own terminal through Pi's normal configuration:

```bash
pnpm --filter @anastom/runtime-pi exec pi
```

Use `/login` and select a provider/model. Keep credentials in Pi's auth storage or supported provider environment variables. Never put them in task files, scenarios, artifacts, issues, or chat. Anastom uses the configured default model; paired `--provider <provider> --model <model-id>` flags can explicitly select another configured model.

Create a fresh fixture for the live demonstration:

```bash
live_fixture="$(pnpm exec tsx scripts/create-m1-fixture.ts)"
pnpm anastom run examples/demo-repos/m1-endpoint/tasks/add-endpoint.md \
  --runtime pi --repo "$live_fixture"
pnpm anastom status <run-id> --state-dir "$live_fixture/.anastom"
pnpm anastom inspect <run-id> --state-dir "$live_fixture/.anastom"
```

A successful run requires a schema-valid worker report and verifier exit zero. Authentication/provider failures, invalid reports, command failure, or timeout produce a failed run with inspectable history. The fixture task limits the worker to one five-minute attempt and the verifier to thirty seconds, with a 1 MiB output cap per stream.

## Context, evidence, and limits

Every attempt receives newly built, recursively frozen context. Canonical JSON bytes and a SHA-256 digest are persisted before worker start. Dependencies contribute validated structured outputs; previous transcripts, reports, and reasoning are not automatically inherited. Pi uses an in-memory session with inherited context files, prompt templates, skills, extensions, automatic compaction, and automatic retry disabled.

The filesystem stores context, public tool log summaries, structured worker reports, diffs, and separate verifier stdout/stderr/result artifacts. SQLite stores references and events. Inspection prints provider/model identity and public tool names/outcomes, without private reasoning or raw provider errors. Artifact bodies are local evidence: inspect them before choosing to publish them.

Verification uses an argument vector with `shell: false`. Task-authored environment injection is rejected. The inherited environment is limited to `PATH`, `HOME`, temporary-directory variables, platform command variables, and locale variables; provider API environment variables are omitted. The relative command directory is checked against the real workspace path, including symlink escapes. Stdout/stderr are drained with bounded retained bytes. On POSIX, timeout sends SIGTERM to the process group, then SIGKILL after a bounded grace.

Worktree isolation protects the original checkout from ordinary edits. Neither Pi's tools nor verification are an operating-system sandbox. Tasks, executable code, commands, provider configuration, and the target repository must be trusted. Read-only mode omits mutating Pi tools and requires a clean source checkout for mutation detection; it is not a filesystem access-control boundary. Linux and macOS are the validation targets; Windows process-tree termination is not certified by M1.

At an attempt deadline, the control plane requests cancellation once and records the cancellation outcome. Late success remains diagnostic; the attempt fails with `budget-exhausted`. Retry is refused when termination is unconfirmed. M1 does not recover attempts that were live during a process crash. A later `status` or `inspect` shows the last committed state; it does not restart a worker.

## Retention and explicit cleanup

Success and failure both retain `.anastom/runs/<run-id>/artifacts/`, the SQLite history, and isolated worktrees. `.anastom/` must remain ignored in target repositories; the fixture includes that rule. An explicit `--state-dir` may place state outside the repository when needed.

`GitWorkspaceManager.cleanup(workspace)` is the M1 programmatic cleanup operation. It checks the ownership manifest, canonical path, Git registration, and branch namespace. It refuses dirty worktrees, worker commits, read-only/source directories, and unowned paths. Repeating cleanup of an owned clean workspace is safe. There is no broad deletion command in M1; review and preserve changes before removing temporary demo repositories yourself.

The [build brief](M1_BUILD_BRIEF.md) defines the completion checklist. M2 adapters and M3 recovery remain separate milestones.
