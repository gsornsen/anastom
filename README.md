# Anastom

**Adaptive orchestration for autonomous software-engineering agents.**

Anastom is a vendor-neutral control plane for engineering work performed by AI agents. It treats development methodology, agent topology, model choice, execution harness, context policy, verification, and recovery behavior as explicit runtime concerns rather than hidden prompt conventions.

The name comes from **anastomosis**: independently branching structures that reconnect to exchange resources, establish alternate paths, and form resilient networks. That is the intended behavior of Anastom workflows: agents may diverge, investigate independently, compete, collaborate, reconnect through durable evidence, and converge on verified outcomes.

## Why Anastom exists

Modern coding agents are powerful but increasingly opaque. A single vendor may simultaneously control the model, system prompt, context policy, compaction, tool loop, subagent behavior, and usage limits. A model or harness update can therefore change the reliability of a previously stable multi-day workflow without any change in the user's repository or instructions.

Anastom moves the important control surfaces out of the model:

- methodology is explicit and composable;
- workflow state is durable and inspectable;
- agents receive bounded task contracts;
- evidence and verification are first-class artifacts;
- retry, escalation, and circuit-breaker policies are deterministic;
- roles are decoupled from models;
- models are decoupled from harnesses;
- execution backends are replaceable;
- multi-agent reasoning can be sequential, parallel, collaborative, or adversarial;
- long-running work can stop, resume, migrate, and recover without relying on one chat transcript.

## Initial product shape

Anastom is organized around five layers:

1. **Intent & Methodology** — what outcome is desired and what reasoning/development method should govern each phase.
2. **Workflow IR** — a typed graph describing phases, roles, dependencies, gates, evidence contracts, budgets, and nested workflows.
3. **Control Plane** — scheduling, policy, routing, state transitions, retries, escalation, supervision, and observability.
4. **Runtime Adapters** — Claude Code/Mycelium, Pi, Codex, TrueForge, OpenHands, and later additional harnesses.
5. **Capabilities** — skills, MCP tools, LSP/debugger access, shell tools, test runners, browsers, and project-local commands.

See the documents in `docs/` for the product vision, strategy, MLP PRD, milestones, architecture, workflow IR, runtime evaluation, and migration plan.

## Build sequence

M0 proves the language and transition engine with a deterministic fake runtime. M1 is the first real vertical slice:

```text
Markdown task
  -> one Workflow IR instance
  -> one isolated worktree
  -> one Pi worker with fresh context
  -> one deterministic command verifier
  -> SQLite event history and filesystem artifacts
  -> durable status and inspection
```

M2 adds Codex as the second adapter and proves that the same contract survives a different execution substrate. Multiple workers, integration branches, and crash recovery follow in their own milestones.

## Reference CLI

The CLI examples in these docs are intentionally aspirational:

```bash
anastom run "Add passwordless authentication" --method sdlc
anastom run bug.md --method debug/hypothesis
anastom run experiment.md --method develop/hypothesis
anastom run architecture.md --method adversarial/tournament

anastom status
anastom inspect <run-id>
anastom graph <run-id>
anastom pause <run-id>
anastom resume <run-id>
anastom intervene <run-id>
```

The first MLP does not require all of these commands. The roadmap defines the order in which they should become real.

## M0 development

M0 is a TypeScript pnpm workspace with a validated Workflow IR, an event-sourced execution engine, a scriptable fake runtime, and a process-local CLI. It intentionally contains no real model or harness integration.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm anastom validate examples/workflows/demo-feature.yaml
pnpm anastom graph examples/workflows/demo-feature.yaml
pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml
```

M0 decisions and evidence are recorded in [docs/M0_RETROSPECTIVE.md](docs/M0_RETROSPECTIVE.md). The accepted M1 scope is in [docs/M1_BUILD_BRIEF.md](docs/M1_BUILD_BRIEF.md).

## License and community

Anastom is free and open-source software licensed under the [GNU Affero General Public License version 3 only](LICENSE), identified as `AGPL-3.0-only`. The license permits commercial and internal use. It requires covered source when modified versions are distributed and requires operators of modified network-interactive versions to offer corresponding source to their remote users.

Contributions, issue reports, design feedback, documentation, and independent integrations are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [COMMUNITY_STEWARDSHIP.md](COMMUNITY_STEWARDSHIP.md) for contribution terms and the project's commitments against community capture. Use of the Anastom name and official project identity is governed separately by [TRADEMARKS.md](TRADEMARKS.md).
