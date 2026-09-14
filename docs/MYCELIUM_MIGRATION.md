# Mycelium → Anastom Migration Strategy

## Goal

Preserve the parts of Mycelium that have demonstrated value while removing Claude Code as the architectural center of gravity.

Mycelium should remain usable while Anastom is built.

## Current strengths worth preserving

The current Mycelium repository describes:

- 130+ expert agents across many domains;
- lazy agent discovery with indexed metadata and caching;
- Redis, TaskQueue, and Markdown coordination modes;
- real-time pub/sub;
- Temporal integration;
- event hooks;
- infrastructure/team/pipeline status concepts;
- local-only performance analytics;
- explicit meta-orchestration roles.

These map naturally into Anastom.

## Concept mapping

| Mycelium                     | Anastom                                  |
| ---------------------------- | ---------------------------------------- |
| Spore / expert agent         | Role + capability profile + skill assets |
| Fruiting body / orchestrator | Methodology/workflow                     |
| Hypha / workflow thread      | Workflow instance / nested workflow      |
| Substrate                    | Persistence/event/runtime infrastructure |
| Coordination client          | Control-plane event/state interfaces     |
| Redis pub/sub                | Event transport / distributed projection |
| TaskQueue                    | Scheduler/task backend                   |
| Markdown mode                | Local artifact/state projection          |
| Temporal workflows           | Durable execution backend                |
| Claude plugin agent          | Claude/Mycelium runtime adapter          |
| Agent discovery index        | Role/skill registry                      |
| Local analytics              | Runtime/model/workflow telemetry         |

## Migration rule

**Import semantics, not directory structure.**

Do not recreate `.mycelium` under a new name.

Instead write importers that translate Mycelium assets into Anastom-native resources.

## Migration stages

### Stage 1 — Freeze Mycelium as a regression/reference corpus

Before heavy migration:

- record representative workflows that previously behaved well;
- identify 10–20 high-value specialist agents;
- record coordination scenarios;
- preserve example multi-day handoff artifacts;
- create golden expected outputs where practical.

These become Anastom evaluation fixtures.

### Stage 2 — Agent importer

Translate front matter and prompt content into:

```text
role metadata
capability hints
skill/instruction assets
tool requirements
```

Do not assume one imported agent equals one permanent Anastom role.

### Stage 3 — Skill normalization

Where possible, emit portable:

```text
.agents/skills/<skill>/SKILL.md
```

while retaining richer Anastom metadata separately.

### Stage 4 — Workflow extraction

Identify Mycelium meta-orchestrators and express their actual state transitions as Workflow IR.

The exercise will reveal where orchestration previously depended on Claude interpretation.

Those points should become explicit IR primitives or policy.

### Stage 5 — Claude compatibility adapter

Allow Anastom to launch a bounded Mycelium/Claude worker.

Claude becomes one runtime among several.

### Stage 6 — Temporal reuse

Only after Anastom's local workflow semantics are proven, map durable nodes/workflows to Temporal.

Potential reusable lessons:

- activity boundaries;
- retries;
- signals;
- heartbeat/health;
- worker registration;
- idempotency.

## What should not migrate initially

- all 130+ agents;
- every slash command;
- Claude-specific UX;
- old global coordination files;
- any workflow whose behavior exists only as narrative prompt instructions.

## Suggested first imported roles

Choose roles that exercise meaningfully different needs:

1. `architect`
2. `debugger`
3. `typescript-implementer`
4. `python-implementer`
5. `ml-experimenter`
6. `security-reviewer`
7. `test-engineer`
8. `performance-reviewer`
9. `integrator`
10. `evidence-synthesizer`

## Compatibility objective

Anastom should eventually be able to say:

```bash
anastom import mycelium ../mycelium
```

and produce a migration report:

```text
agents discovered:       130
roles auto-translated:    92
skills emitted:           41
manual review required:   38
workflows inferred:        7
Claude-only dependencies: 12
```

The exact numbers are illustrative.

## Strategic outcome

Mycelium becomes Anastom's evolutionary ancestor rather than a dependency that constrains its future.
