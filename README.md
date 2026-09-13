# Anastom

**Explicit workflows for reliable engineering work across coding agents.**

Anastom is building a local-first, vendor-neutral control plane for software-engineering agents. It is designed to coordinate work through existing coding harnesses while making the engineering process explicit: who acts next, what context they receive, what they may change, how results are verified, and when to retry or stop.

The goal is to make work that spans hours or days understandable, bounded, and recoverable, even as models and coding tools change.

**Current stage: M0 is complete.** The repository supports validated workflows and deterministic fake execution. The M1 contract is accepted; real Pi execution, Git worktrees, and SQLite persistence are the next implementation milestone.

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

M0 provides a TypeScript pnpm workspace with:

- strict YAML Workflow IR validation, local JSON Schema loading, and normalized workflow definitions;
- dependency scheduling with stable ordering and one active node at a time;
- a scriptable fake runtime with per-node, per-attempt outcomes;
- schema-validated results, verifier pass/fail handling, retries, and failure propagation;
- typed append-only events, state replay, and in-memory persistence; and
- CLI commands to validate, render a graph, run a fake scenario, and inspect a run within the same process.

There are currently no real model calls, repository mutations, durable cross-process storage, or live human approval flows. `inspect` uses process-local storage; a separate shell invocation cannot inspect an earlier run yet.

See the [M0 retrospective](docs/M0_RETROSPECTIVE.md) for the implemented boundary and decisions.

## Try the current demo

Run from source with **Node.js 24 or newer** and **pnpm 11.9.0**:

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
```

## Roadmap

Each milestone must produce a useful, testable demonstration. These are planned capabilities, with no promised release dates.

| Milestone | Status | Outcome |
| --- | --- | --- |
| **M0 — Skeleton** | Complete | Validate workflows and execute deterministic fake runs. |
| **M1 — Single worker** | Contract accepted; implementation next | One Pi worker, fresh context, isolated Git worktree, command verification, SQLite history, and durable `status` / `inspect`. |
| **M2 — Portable worker** | Planned | Run the same contract through Codex; compare normalized events and capabilities. |
| **M3 — Durable execution** | Planned | Recover safely after interruption, with ownership, orphan detection, pause, and resume semantics. |
| **M4 — Defined SDLC** | Planned | Plan, delegate parallel work, integrate, review, and verify a feature. |
| **M5 — Circuit breakers** | Planned | Detect repeated failure, enforce budgets, stop mutation, and escalate with evidence. |
| **M6 — Hypothesis debugging** | Planned | Maintain competing explanations and run experiments that distinguish them. |
| **M7 — Delegated TDD** | Planned | Separate planning and review from bounded implementation, with role-to-model configuration. |
| **M8 — Mycelium bridge** | Planned | Translate selected Mycelium agents, skills, and workflows into portable Anastom resources. |
| **M9–M12 — Further composition** | Planned | Specialist councils, adversarial evaluation, nested methodologies, and adaptive routing. |

M1 persistence enables inspection from later processes. Recovery of an attempt that was running during a crash is explicitly M3 work.

See the [full milestones](docs/MILESTONES.md), [M1 build brief](docs/M1_BUILD_BRIEF.md), and [changelog](CHANGELOG.md) for scope and progress.

## Learn more

| Question | Document |
| --- | --- |
| What principles guide the project? | [Vision](docs/VISION.md) |
| Who is it for, and how will it grow? | [Strategy](docs/STRATEGY.md) |
| What is the first useful product target? | [Minimum lovable product requirements](docs/PRD_MLP.md) |
| Who owns execution, state, and verification? | [Architecture](docs/ARCHITECTURE.md) |
| How are workflows represented? | [Workflow IR](docs/WORKFLOW_IR.md) |
| Why were foundational decisions made? | [Architecture decision records](docs/adr/) |
| What did M0 settle? | [M0 retrospective](docs/M0_RETROSPECTIVE.md) |
| How does Mycelium carry forward? | [Migration strategy](docs/MYCELIUM_MIGRATION.md) |
| Which existing systems inform the design? | [Runtimes and inspiration](docs/RUNTIMES_AND_INSPIRATION.md) |

## License and community

Feedback, [issues](https://github.com/gsornsen/anastom/issues), [discussions](https://github.com/gsornsen/anastom/discussions), documentation, bug fixes, tests, and code contributions are welcome. Foundational APIs are still evolving, so design feedback is particularly valuable.

Anastom is licensed under the [GNU Affero General Public License version 3 only](LICENSE), identified as `AGPL-3.0-only`. See the [licensing guide](docs/LICENSING.md), [contribution guide](CONTRIBUTING.md), [governance](GOVERNANCE.md), and [community stewardship commitments](COMMUNITY_STEWARDSHIP.md). The project's name and official identity are governed separately by [TRADEMARKS.md](TRADEMARKS.md).
