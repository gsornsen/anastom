# Anastom

**Explicit workflows for reliable engineering work across coding agents.**

Anastom is building a local-first, vendor-neutral control plane for software-engineering agents. It is designed to coordinate work through existing coding harnesses while making the engineering process explicit: who acts next, what context they receive, what they may change, how results are verified, and when to retry or stop.

The goal is to make work that spans hours or days understandable, bounded, and recoverable, even as models and coding tools change.

**Current stage: M2.5 is complete, and the full M3 durable-execution implementation is in unmerged PR #24 for owner review.** Anastom can run the same strict Markdown Task through Pi, an exact-pinned Codex CLI worker, or an attested Claude Code CLI worker; check the selected runtime's capabilities before work starts; independently verify the result; and replay public identity and available token observations from durable history. The unchanged endpoint Task passed through all three owner-authenticated harnesses. The M3 work adds credential-free runtime reconstruction descriptors, exact recovery event/reducer contracts, private operational-state paths, production workspace checkpoints, a fenced durable store, a shared POSIX execution supervisor, a vendor-neutral recovery coordinator, CLI `pause` / `cancel` / `resume`, and deterministic crash/restart acceptance. See the [M3 implementation evidence](docs/M3_EVIDENCE.md), [M2 completion evidence](docs/M2_EVIDENCE.md), [M2.5 completion evidence](docs/M2_5_EVIDENCE.md), and [M1 completion evidence](docs/M1_EVIDENCE.md).

The [offline CLI audit](docs/M2_FEASIBILITY.md) led to an [approved discovery/authentication profile](docs/adr/0012-codex-discovery-and-authentication-profile.md). An accumulated-context fixture reproduced native compaction, leading to the [accepted catalog control](docs/adr/0013-codex-client-compaction-profile.md). A managed-policy fixture then found hidden instructions despite native success; [accepted ADR 0014](docs/adr/0014-codex-managed-policy-preflight.md) adds a model-free policy gate before Codex execution. M2.5 added the separately installed Claude Code CLI with explicit subscription/API-key selection and fail-closed native, authentication, and managed-policy checks. This release supports one selected worker and one verifier. The accepted [M3 durability contract](docs/M3_BUILD_BRIEF.md) defines the ownership, orphan, workspace, snapshot, pause, cancel, and resume boundary. [M3 feasibility](docs/M3_FEASIBILITY.md) rejects current handles and direct leader PIDs as recovery identities. Its shared supervisor, SQLite contention, exact workspace, and snapshot-integrity phases now pass on the owner macOS host, Ubuntu 24.04 CI, and clean macOS 15 CI. They establish two-phase start authorization, bounded authenticated IPC, fail-closed supervisor loss, fenced/idempotent transactions, canonical workspace identity, snapshot-plus-tail equality, authoritative prefix binding, and corrupt-snapshot fallback. The [M3 production contract](docs/M3_PRODUCTION_CONTRACT.md) defines the records, package APIs, path boundary, state transitions, transaction order, and compatibility rules now guiding the stacked implementation.

[Changelog](CHANGELOG.md) · [Roadmap](docs/MILESTONES.md) · [Design documents](#learn-more) · [Contributing](CONTRIBUTING.md)

## Why Anastom exists

Anastom grew out of building and using [Mycelium](https://github.com/gsornsen/mycelium), a Claude Code plugin for specialist agents, coordination, workflow infrastructure, and local observability. Mycelium showed the value of reusable expertise, selective agent discovery, explicit handoffs, and operational visibility. That work is an evolutionary foundation for Anastom; the [migration strategy](docs/MYCELIUM_MIGRATION.md) describes what should carry forward.

Using Mycelium inside Claude Code, working with Claude Code on its own, and exploring other agent frameworks exposed a recurring need: engineering work requires execution rules that remain understandable outside a single model conversation. Session context, compaction, tool behavior, and model or harness changes can affect a workflow even when the task and repository stay the same.

The lessons shaping Anastom are:

- **Instructions need enforcement.** A request to use TDD, respect a budget, or stop after repeated failures needs explicit transitions and checks.
- **State needs a home outside the transcript.** Handoffs, context compaction, and process interruption require durable task contracts, artifacts, and history.
- **Verification needs independent evidence.** A worker's completion report must be checked against tests, command results, reviews, or approvals.
- **Context needs deliberate selection.** Workers and reviewers should receive the information relevant to their role; shared reasoning can anchor otherwise independent judgments.
- **Engineering methods need portable execution.** Roles and workflows should survive a change of model or coding harness.

Our [ecosystem research](docs/RUNTIMES_AND_INSPIRATION.md) explores Pi, Codex, TrueForge, OpenHands, and other harnesses alongside methodology tools such as Superpowers, Spec Kit, OpenSpec, and BMAD. Those explorations inform the design and interoperability goals. Delivered integrations are tracked in the roadmap below.

## What Anastom aims to provide

Anastom is intended for developers and teams who already delegate meaningful work to coding agents and want to understand and control its execution.

- **Executable engineering methods:** defined SDLC, delegated TDD, and hypothesis-driven debugging, with explicit phases and acceptance conditions.
- **Bounded delegation:** fresh task context, isolated workspaces, attempt limits, time budgets, and recorded reasons to retry, escalate, or stop.
- **Verified outcomes:** structured results backed by deterministic checks and independent review.
- **Portable workers:** roles describe the work; adapters translate execution into each harness. Model choice can evolve separately.
- **Durable operations:** inspectable event history, artifacts, and eventual pause, intervention, and safe recovery.
- **Independent collaboration:** specialists can investigate, compare approaches, and reconnect through evidence without inheriting every peer's transcript.

The name comes from **anastomosis**: branching structures that reconnect to exchange resources and form resilient networks. It reflects the long-term goal of agents working independently and converging through shared evidence.

## What works today

The TypeScript pnpm workspace supports:

- strict YAML Workflow IR validation, local JSON Schema loading, and normalized workflow definitions;
- source-scoped CLI Task/Workflow/schema reads and a shared canonical-root resolver for existing scenario-file and verifier-directory children;
- dependency scheduling with stable ordering and one active node at a time;
- a scriptable fake runtime with per-node, per-attempt outcomes;
- schema-validated results, verifier pass/fail handling, retries, and failure propagation;
- strict Markdown tasks compiled into one worker followed by one deterministic verification command;
- Pi and exact-pinned Codex CLI adapters with fresh, explicit context per attempt;
- selected-runtime capability preflight before attempt start, with durable accepted snapshots;
- configured identity provenance and available attempt-scoped partial token observations;
- bounded credential-free Pi, Codex, and Claude Code descriptors with exact reconstruction codecs;
- exact prepare/authorize, control, cleanup, orphan, typed pause, and recovery-blocked event contracts for durable Task execution;
- fixed-segment private operational-state paths plus exact double-captured workspace checkpoints with bounded diff and ignored-content evidence;
- fenced durable-run storage plus a shared two-phase POSIX execution host and vendor-neutral coordinator with heartbeat, operator controls, exact orphan/workspace reconciliation, bounded retries, parent-death cleanup, and fail-closed supervisor-loss handling;
- a durable CLI composition root for Pi, Codex, and Claude Code, with exact descriptor reconstruction, `pause` / `cancel` / `resume`, lease and pending-control inspection, snapshot provenance, typed ownership refusal, and fail-closed corrupt-state handling;
- owned Git worktrees retained for review, with base commit, final head, and diff capture;
- bounded command execution with separate stdout/stderr artifacts and typed failures;
- canonical context artifacts, structured reports, public tool summaries, and SHA-256 digests;
- typed append-only events, SQLite persistence, and inspection from later processes; and
- CLI commands to validate, render a graph, run, inspect, show status, pause, cancel, and resume.

Markdown Task runs persist under the target repository's ignored `.anastom/` directory. The YAML fake demo uses process-local persistence. A worker report describes the change; the control plane accepts it only after the declared command exits successfully.

Packages have documented APIs and their own READMEs/changelogs. Prettier, ESLint/JSDoc, contributor hygiene checks, and reviewed SemVer release plans establish the development baseline. SQLite uses versioned, validated migrations with transactional failure rollback. Fake scenarios can reference separate source files for readable diffs and IDE support. See the [engineering standards](docs/ENGINEERING.md) for development, migration, and CI practices.

Pi uses your normal provider authentication and model settings; its Git worktree is checkout isolation, not an operating-system sandbox. Codex uses its normal file-backed CLI authentication, requires an explicit OpenAI model, and runs its worker commands in read-only or workspace-write sandboxing. Claude Code uses an end-user-installed, signed native release with an explicit first-party subscription or API-key source. Codex and Claude Code reject managed policy that their bounded profiles cannot certify. The independent verifier runs with local command permissions. Run trusted tasks and verification commands on repositories you are comfortable exposing to the selected provider. M3's local crash/restart acceptance passes without a provider call; final-code Linux/macOS and repository-required checks remain in review. Human approval, multiple workers, routing, and further adapters remain future milestones.

See the [M0 retrospective](docs/M0_RETROSPECTIVE.md) and [M1 retrospective](docs/M1_RETROSPECTIVE.md) for the implemented boundaries, evidence, and lessons informing portability.

## Try the current demo

Run from the directory containing your authored Task/Workflow source tree with **Node.js 24 or newer** and **pnpm 11.9.0**. CLI-selected source files and schema references must remain inside that directory after symlink resolution; `--repo` can point to a separate target checkout:

```bash
git clone https://github.com/gsornsen/anastom.git
cd anastom
pnpm install --frozen-lockfile
pnpm anastom validate examples/workflows/demo-feature.yaml
pnpm anastom graph examples/workflows/demo-feature.yaml
pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml
```

The example follows `analyze -> implement -> verify` using scripted results. It proves workflow execution without calling a model or changing source files.

To check the development baseline:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm hygiene
```

To exercise durable crash/restart behavior without a model or provider credentials, run:

```bash
pnpm verify:m3
```

The matrix implements `GET /health`, kills the coordinator at controlled process boundaries, resumes safely, runs the fixture's acceptance tests, and audits the retained worktree and artifacts. To make a live provider-backed run on a fresh fixture, use `--runtime pi`, `--runtime codex --provider openai --model YOUR_CODEX_MODEL`, or `--runtime claude-code --provider anthropic --model YOUR_CLAUDE_MODEL --auth-source subscription|api-key`; Codex also accepts `--reasoning-effort medium`. These runs persist reconstructable configuration and accept `pause`, `cancel`, and `resume` with the printed run ID and state directory. Authenticate each selected CLI in your own terminal, and keep credentials out of Task files. See the [M3 evidence](docs/M3_EVIDENCE.md), [M1 demo guide](docs/M1_DEMO.md), [M2 evidence](docs/M2_EVIDENCE.md), [M2.5 evidence](docs/M2_5_EVIDENCE.md), and [Claude Code package guide](packages/runtime-claude-code/README.md) for setup, boundaries, and inspection.

## Roadmap

Each milestone must produce a useful, testable demonstration. Planned milestones have no promised release dates.

| Milestone                        | Status   | Outcome                                                                                                                                                |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M0 — Skeleton**                | Complete | Validate workflows and execute deterministic fake runs.                                                                                                |
| **M1 — Single worker**           | Complete | One Pi worker, fresh context, isolated Git worktree, command verification, SQLite history, and durable `status` / `inspect`.                           |
| **M2 — Portable worker**         | Complete | The same Task through Pi/Codex CLI, selected-runtime capability checks, shared conformance, and available token usage.                                 |
| **M2.5 — Claude Code worker**    | Complete | A third source adapter selects an end-user-installed CLI and explicit subscription/API-key mode; the unchanged Task passed live with durable evidence. |
| **M3 — Durable execution**       | Building | The full implementation and local deterministic crash/restart matrix pass in review; owner acceptance and final-code remote checks remain.             |
| **M4 — Defined SDLC**            | Planned  | Plan, delegate parallel work, integrate, review, and verify a feature.                                                                                 |
| **M5 — Circuit breakers**        | Planned  | Detect repeated failure, enforce budgets, stop mutation, and escalate with evidence.                                                                   |
| **M6 — Hypothesis debugging**    | Planned  | Maintain competing explanations and run experiments that distinguish them.                                                                             |
| **M7 — Delegated TDD**           | Planned  | Separate planning and review from bounded implementation, with role-to-model configuration.                                                            |
| **M8 — Mycelium bridge**         | Planned  | Translate selected Mycelium agents, skills, and workflows into portable Anastom resources.                                                             |
| **M9–M12 — Further composition** | Planned  | Specialist councils, adversarial evaluation, nested methodologies, and adaptive routing.                                                               |

M1 persistence enables inspection from later processes. The M3 review stack adds fenced recovery for an attempt that was running during a coordinator crash.

Claude Code support follows M2 as completed [M2.5](https://github.com/gsornsen/anastom/issues/13), before M3. The source adapter checks the exact native release, a first-party personal-plan subscription login or an explicit API key, and the absence of relevant managed policy before creating a run. It owns a fresh restricted process per attempt, accepts only schema-valid final output, and exposes bounded public evidence. [Model-free and synthetic-native feasibility](docs/M2_5_FEASIBILITY.md) covers the owner macOS installation, authentication selection, ordinary customization suppression, file-tool confinement, and process cleanup without calling Anthropic. Anthropic's bare API-key mode exposed Read/Edit only in the pinned release, so it can edit existing files but cannot create new ones through Write. The subscription-backed unchanged M2 Task succeeded with its independent two-test verifier, 9/9 durable artifacts, a clean source clone, and the same portable workflow digest as the earlier Pi and Codex runs. The owner-accepted [M2.5 evidence](docs/M2_5_EVIDENCE.md) records the live run and completion gates. The [accepted worker profile](docs/adr/0015-claude-code-worker-profile.md) records the legal and managed-policy boundaries; [ADR 0016](docs/adr/0016-path-policy-after-third-adapter.md) compares path rules across the three adapters and the narrow existing-child API added after CodeQL flagged operator-file reads. Executable provenance, managed policy, and durable artifacts keep separate rules. The [Codex SDK backlog](https://github.com/gsornsen/anastom/issues/12) records the limitations that must be resolved or disproven before reconsidering that interface.

See the [full milestones](docs/MILESTONES.md), [M1 build brief](docs/M1_BUILD_BRIEF.md), [M2 build brief](docs/M2_BUILD_BRIEF.md), [M2.5 build brief](docs/M2_5_BUILD_BRIEF.md), accepted [M3 build brief](docs/M3_BUILD_BRIEF.md), accepted [M3 production contract](docs/M3_PRODUCTION_CONTRACT.md), and [changelog](CHANGELOG.md) for scope and progress.

## Learn more

| Question                                                | Document                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| What principles guide the project?                      | [Vision](docs/VISION.md)                                                        |
| Who is it for, and how will it grow?                    | [Strategy](docs/STRATEGY.md)                                                    |
| What is the first useful product target?                | [Minimum lovable product requirements](docs/PRD_MLP.md)                         |
| Who owns execution, state, and verification?            | [Architecture](docs/ARCHITECTURE.md)                                            |
| How are workflows represented?                          | [Workflow IR](docs/WORKFLOW_IR.md)                                              |
| How do we keep contributions readable and maintainable? | [Engineering standards](docs/ENGINEERING.md)                                    |
| Why were foundational decisions made?                   | [Architecture decision records](docs/adr/)                                      |
| What did M0 settle?                                     | [M0 retrospective](docs/M0_RETROSPECTIVE.md)                                    |
| How do I run and inspect a single worker?               | [M1 demo guide](docs/M1_DEMO.md)                                                |
| What proves M1 works?                                   | [M1 completion evidence](docs/M1_EVIDENCE.md)                                   |
| What did M1 teach us?                                   | [M1 retrospective](docs/M1_RETROSPECTIVE.md)                                    |
| What contract governs portable workers?                 | [M2 build brief](docs/M2_BUILD_BRIEF.md)                                        |
| What proves M2 works?                                   | [M2 completion evidence](docs/M2_EVIDENCE.md)                                   |
| What proves M2.5 works?                                 | [Claude Code implementation evidence](docs/M2_5_EVIDENCE.md)                    |
| Which path rules can be shared safely?                  | [Third-adapter path decision](docs/adr/0016-path-policy-after-third-adapter.md) |
| What safety contract governs crash recovery?            | [M3 durable-execution build brief](docs/M3_BUILD_BRIEF.md)                      |
| What has M3 process and supervisor testing established? | [M3 feasibility evidence](docs/M3_FEASIBILITY.md)                               |
| Which exact APIs and records govern M3 production work? | [M3 production contract](docs/M3_PRODUCTION_CONTRACT.md)                        |
| What does the M3 crash/restart matrix prove?            | [M3 implementation evidence](docs/M3_EVIDENCE.md)                               |
| How does Mycelium carry forward?                        | [Migration strategy](docs/MYCELIUM_MIGRATION.md)                                |
| Which existing systems inform the design?               | [Runtimes and inspiration](docs/RUNTIMES_AND_INSPIRATION.md)                    |

## License and community

Feedback, [issues](https://github.com/gsornsen/anastom/issues), [discussions](https://github.com/gsornsen/anastom/discussions), documentation, bug fixes, tests, and code contributions are welcome. Foundational APIs are still evolving, so design feedback is particularly valuable.

Anastom is licensed under the [GNU Affero General Public License version 3 only](LICENSE), identified as `AGPL-3.0-only`. See the [licensing guide](docs/LICENSING.md), [contribution guide](CONTRIBUTING.md), [governance](GOVERNANCE.md), and [community stewardship commitments](COMMUNITY_STEWARDSHIP.md). The project's name and official identity are governed separately by [TRADEMARKS.md](TRADEMARKS.md).
