# Runtimes, Systems, and Ecosystems to Explore

This document distinguishes **execution substrates** from **workflow/methodology systems**. Anastom should borrow selectively rather than inherit any project's full worldview.

## Runtime/harness priority

### 1. Pi — first runtime target

**Why**
Pi is unusually attractive as a substrate because it exposes a TypeScript SDK and RPC mode while keeping higher-level workflow opinions minimal.

**Borrow / use**

- session/runtime boundary;
- extension/event architecture;
- explicit resource loading;
- tool definition patterns;
- language-agnostic RPC option;
- customizable context/session mechanics.

**Anastom use**
First adapter. Keep Anastom orchestration above it.

**What not to copy**
Do not make Pi extensions the Anastom plugin system. Preserve a neutral core.

Reference:
https://github.com/earendil-works/pi

The maintained SDK package is `@earendil-works/pi-coding-agent`. Earlier releases used the `@mariozechner` scope and the `badlogic/pi-mono` repository; adapters should follow the maintained package and pin an exact reviewed version.

---

### 2. Codex CLI / SDK surface — second runtime target

**Why**
Codex is a strategically important independent execution substrate and model family. Supporting it early proves portability and provides a useful comparison against Anthropic-centric workflows.

**Borrow / use**

- autonomous execution behavior;
- sandbox/workspace semantics where exposed;
- event/stream normalization;
- independent reviewer role;
- long-running task execution.

**Anastom use**
Second adapter and frequent cross-model reviewer.

Reference:
https://github.com/openai/codex

---

### 3. Mycelium — migration source and compatibility runtime

**Why**
Mycelium already contains validated operational ideas:

- 130+ expert agents;
- lazy discovery;
- Redis/TaskQueue/Markdown coordination;
- real-time pub/sub;
- Temporal integration;
- hooks;
- local analytics;
- operational health commands.

**Borrow / preserve**

- agent catalog metadata;
- specialist taxonomies;
- coordination concepts;
- Temporal lessons;
- event-driven collaboration;
- local-first telemetry;
- infrastructure health checks.

**Anastom use**
Treat Mycelium as:

1. source material for the role/skill library;
2. a compatibility adapter where useful;
3. a regression corpus for workflows that were reliable under older Claude Code behavior.

**What to change**
Move authority away from Claude-native orchestration and transcript state.

Reference:
https://github.com/gsornsen/mycelium

---

### 4. TrueForge — architecture/reference implementation

**Why**
TrueForge explicitly separates the agent execution loop from higher-level applications and provides model, MCP, skill, sandbox, approval, context, and session facilities behind an HTTP/TypeScript API.

**Borrow / study**

- resource catalogs;
- deferred tools;
- sandbox-as-tool;
- large-result offloading;
- session API;
- local SQLite -> Postgres/Redis scaling path;
- explicit runtime/service boundary.

**Anastom use**
Potential later adapter. More importantly, use it to pressure-test whether Anastom is accidentally rebuilding harness concerns.

Reference:
https://github.com/truefoundry/trueforge

---

### 5. OpenHands Software Agent SDK — workspace/runtime abstraction

**Why**
OpenHands exposes Python, TypeScript, and REST APIs and supports local or ephemeral Docker/Kubernetes workspaces.

**Borrow / study**

- workspace lifecycle;
- local vs remote execution;
- server/runtime separation;
- multi-agent refactor patterns.

**Anastom use**
Potential adapter for containerized or remote workers.

Reference:
https://github.com/OpenHands/software-agent-sdk

---

### 6. Oh My Pi (OMP) — power-user harness experiments

**Why**
OMP is a batteries-included Pi fork with extensive built-ins including LSP, debugger integration, many providers, subagents, extensions, and import from existing agent configuration.

**Borrow / study**

- LSP-aware mutation;
- debugger as agent capability;
- hash-anchored edits;
- persistent code execution;
- provider/model routing;
- cross-harness config discovery.

**Anastom use**
A reference for how much capability can live below Anastom. Potential adapter after Pi.

Reference:
https://github.com/can1357/oh-my-pi

---

### 7. OpenCode

**Why**
Large open-source coding-agent ecosystem with model portability.

**Borrow / study**

- provider abstraction;
- agent UX;
- ecosystem packaging;
- model-neutral conventions.

**Anastom use**
Potential adapter and interoperability target.

Reference:
https://github.com/anomalyco/opencode

---

## Workflow / methodology systems

### Superpowers

**Best ideas to borrow**

- brainstorming/design before implementation for defined work;
- fresh context per subagent;
- worktree isolation;
- explicit TDD;
- two-stage review: spec compliance then code quality;
- evidence over declarations;
- skill behavior evaluation.

**Do not copy**
Its methodology should not become mandatory global policy.

In Anastom, Superpowers should map to a methodology preset.

Reference:
https://github.com/obra/superpowers

---

### GitHub Spec Kit

**Best ideas to borrow**
Its workflow system now includes:

- commands/prompts/shell steps;
- gates;
- conditionals;
- loops;
- fan-out/fan-in;
- pause/resume;
- JSON output;
- extension/preset/bundle composition.

**Anastom relevance**
Strong reference for Workflow IR ergonomics and workflow packaging.

**Key difference**
Anastom needs deeper agent execution semantics, evidence contracts, role routing, budgets, and failure policy.

Reference:
https://github.com/github/spec-kit

---

### OpenSpec

**Best ideas to borrow**

- lightweight intent/spec artifacts;
- brownfield friendliness;
- separating intent from implementation.

**Anastom relevance**
Potential inspiration for a portable user-facing intent layer above Workflow IR.

Reference:
https://github.com/Fission-AI/openspec

---

### BMAD

**Best ideas to borrow**

- workflow catalogs;
- role specialization;
- multi-lens review;
- scale-aware process;
- structured elicitation;
- artifact validation.

**Do not copy**
Avoid owning the entire product/engineering lifecycle or hardcoding methodology ceremony.

Reference:
https://github.com/bmad-code-org/BMAD-METHOD

---

## Systems concepts worth borrowing outside coding agents

### Temporal

Borrow:

- durable execution;
- replay/idempotency discipline;
- retries as declared policy;
- signals for intervention;
- child workflows;
- activity/workflow separation.

Do not expose Temporal concepts directly in Workflow IR unless they are genuinely universal.

Reference:
https://temporal.io/

### Git

Git remains the best local transaction/isolation primitive for source modification:

- branches;
- worktrees;
- diffs;
- commits;
- rollback;
- merge.

### Event sourcing

Use append-only events and projections/snapshots to make long-running state inspectable and recoverable.

### Blackboard systems

Useful for specialist councils:

- agents publish findings/evidence to a shared board;
- they do not need full transcript sharing.

### Actor systems

Useful conceptual model for isolated agents communicating through messages while owning local state.

### Behavior trees / statecharts

Useful references for explicit transition logic and debugging workflow execution.

### Scientific method / Bayesian experiment design

Important for hypothesis workflows:

- maintain competing explanations;
- select experiments for information gain;
- record evidence;
- avoid confirmation-only experiments.

### Property-based testing

Useful for delegated TDD and verifier design: let the frontier model define invariants while cheaper workers satisfy them.

### Build systems (Bazel/Nix-style thinking)

Useful analogy:

- explicit inputs;
- explicit outputs;
- content addressing;
- deterministic steps;
- cacheable artifacts.

Anastom should increasingly treat agent work like a build graph whose expensive nodes happen to be probabilistic.

## Interoperability standards

Prefer compatibility with:

- `SKILL.md` / Agent Skills conventions;
- MCP;
- JSON Schema;
- OpenTelemetry;
- git;
- standard process I/O;
- HTTP/SSE/WebSocket where remote runtimes require it.

Avoid inventing proprietary formats where a neutral standard is sufficient.
