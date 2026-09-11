# Recommended Initial Project Structure

## Recommendation

Use a TypeScript monorepo.

A good initial structure:

```text
anastom/
├─ README.md
├─ LICENSE
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ biome.json
├─ .github/
│  └─ workflows/
│
├─ docs/
│  ├─ VISION.md
│  ├─ STRATEGY.md
│  ├─ PRD_MLP.md
│  ├─ MILESTONES.md
│  ├─ ARCHITECTURE.md
│  ├─ WORKFLOW_IR.md
│  ├─ RUNTIMES_AND_INSPIRATION.md
│  ├─ MYCELIUM_MIGRATION.md
│  └─ adr/
│
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ ids/
│  │  │  ├─ workflow/
│  │  │  ├─ roles/
│  │  │  ├─ artifacts/
│  │  │  ├─ evidence/
│  │  │  ├─ policy/
│  │  │  ├─ events/
│  │  │  └─ errors/
│  │  └─ test/
│  │
│  ├─ engine/
│  │  ├─ src/
│  │  │  ├─ interpreter/
│  │  │  ├─ scheduler/
│  │  │  ├─ transitions/
│  │  │  ├─ context/
│  │  │  ├─ verification/
│  │  │  ├─ circuit-breakers/
│  │  │  └─ recovery/
│  │  └─ test/
│  │
│  ├─ persistence/
│  │  ├─ src/
│  │  │  ├─ interfaces/
│  │  │  ├─ sqlite/
│  │  │  └─ filesystem/
│  │  └─ test/
│  │
│  ├─ workspaces/
│  │  ├─ src/
│  │  │  ├─ git/
│  │  │  └─ local/
│  │  └─ test/
│  │
│  ├─ runtime-contract/
│  │  ├─ src/
│  │  │  ├─ adapter.ts
│  │  │  ├─ capabilities.ts
│  │  │  ├─ execution.ts
│  │  │  └─ events.ts
│  │  └─ conformance/
│  │
│  ├─ runtime-pi/
│  ├─ runtime-codex/
│  ├─ runtime-fake/
│  ├─ runtime-mycelium/          # later
│  ├─ runtime-trueforge/         # later
│  │
│  ├─ routing/
│  │  ├─ src/
│  │  │  ├─ static.ts
│  │  │  ├─ capability.ts
│  │  │  └─ catalog.ts
│  │  └─ test/
│  │
│  ├─ telemetry/
│  │  ├─ src/
│  │  │  ├─ metrics.ts
│  │  │  ├─ trace.ts
│  │  │  └─ exporters/
│  │  └─ test/
│  │
│  └─ cli/
│     ├─ src/
│     │  ├─ commands/
│     │  ├─ render/
│     │  └─ index.ts
│     └─ test/
│
├─ methodologies/
│  ├─ sdlc/
│  │  └─ default/
│  ├─ debug/
│  │  └─ hypothesis/
│  └─ tdd/
│     └─ delegated/
│
├─ roles/
│  ├─ architect/
│  ├─ debugger/
│  ├─ implementer/
│  ├─ reviewer/
│  └─ verifier/
│
├─ schemas/
│  ├─ workflow/
│  ├─ artifact/
│  ├─ evidence/
│  └─ runtime/
│
├─ examples/
│  ├─ workflows/
│  ├─ tasks/
│  └─ demo-repos/
│
├─ evals/
│  ├─ fixtures/
│  ├─ seeded-bugs/
│  ├─ workflows/
│  ├─ runtime-conformance/
│  └─ reports/
│
└─ scripts/
```

## Why separate `core` and `engine`

`core` should contain pure domain types and validation.

`engine` should contain state-changing orchestration.

This keeps the Workflow IR usable by tools that only need to parse, analyze, render, or validate workflows.

## Why a separate runtime contract package

Runtime adapters will evolve quickly.

A dedicated package makes it easy to:

- publish adapter SDKs later;
- run conformance tests;
- prevent harness-specific type leakage;
- build third-party adapters.

## Why methodologies live outside packages

A methodology should feel like installable data + templates + evaluators, not hardcoded application logic.

The engine supplies primitives; methodologies compose them.

## Why roles live outside methodologies

Roles should be reusable.

`debugger` may appear in:
- SDLC;
- hypothesis debugging;
- incident analysis;
- adversarial review.

A methodology may override a role locally when necessary.

## Initial dependencies

Keep the list small.

Likely:
- TypeScript;
- schema validator such as Zod;
- SQLite client;
- YAML parser;
- CLI parser;
- git process wrapper;
- structured logger;
- test runner;
- package manager workspace tooling.

Avoid introducing:
- Temporal;
- Redis;
- full DI framework;
- web framework;
- React/TUI framework

until a milestone demands them.

## Testing layers

### Unit
Pure workflow/policy transitions.

### Contract
Runtime adapter conformance.

### Integration
Fake runtime + SQLite + workspace.

### Harness integration
Pi/Codex against controlled fixture repos.

### Regression
Seeded bugs and workflow scenarios.

### Long-run reliability
Fault injection:
- kill process;
- kill worker;
- corrupt tool result;
- model schema violation;
- timeout;
- repeated verifier failure.

## Initial ADRs

The initial control-plane, Workflow IR, event sourcing, context, role, adapter, persistence, and worktree decisions are recorded in `docs/adr/`. Later decisions should supersede them with new records instead of removing their history.
