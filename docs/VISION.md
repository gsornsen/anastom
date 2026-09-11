# Anastom Vision

## Vision statement

**Anastom makes autonomous engineering reliable by separating engineering intent and orchestration policy from any individual model or agent harness.**

A developer should be able to express a goal, choose—or allow Anastom to choose—the right engineering methodology, and delegate meaningful work to a network of specialized agents without surrendering control to one opaque model session.

Anastom should make multi-hour and multi-day agent work feel less like supervising an unpredictable chatbot and more like operating a distributed engineering system.

## The world Anastom is designed for

Software development is moving from a single human interacting with a single coding assistant toward heterogeneous networks of:

- frontier reasoning models;
- inexpensive implementation models;
- domain-specialized agents;
- local models;
- coding harnesses;
- deterministic tools;
- test environments;
- external services;
- human decision makers.

The hard problem is no longer merely "can the model write code?"

The hard problems are:

- Which methodology is appropriate for this phase?
- Which agent should act next?
- What context should it receive?
- What evidence must it produce?
- Which model and harness should execute the role?
- How should multiple agents collaborate without contaminating one another's reasoning?
- How should competing approaches be evaluated?
- When should the system retry, escalate, switch models, switch harnesses, or stop?
- How does work survive context compaction, process restarts, provider outages, and multi-day execution?
- How does a human understand and safely intervene in the system?

Anastom exists to answer those questions explicitly.

## Product principles

### 1. The runtime governs; the model proposes

Important control decisions must not depend on the same language model that is currently failing.

Budgets, retry limits, allowed mutations, gates, state transitions, circuit breakers, and verification policies belong in deterministic runtime logic.

### 2. Methodology is executable policy

"Use TDD" or "debug scientifically" should not be a paragraph in a prompt. A methodology should define:

- phases;
- required artifacts;
- entry and exit conditions;
- allowed transitions;
- agent roles;
- evidence requirements;
- verification;
- escalation;
- optional human gates.

### 3. Workflows are composable

Real engineering changes methodology midstream.

A defined SDLC implementation may enter hypothesis-driven debugging when a test fails. An exploratory ML effort may graduate into TDD once feasibility is proven. A specialist council may invoke an adversarial tournament for one disputed architectural choice.

Nested workflows are therefore a core primitive, not an advanced add-on.

### 4. Independent signal must remain independent

Parallel agents should not automatically inherit the full reasoning history of the orchestrator or their peers.

Anastom should prefer:

- fresh worker context;
- immutable task contracts;
- shared evidence artifacts;
- selective synchronization;
- blind evaluation where useful.

This reduces anchoring, groupthink, and epistemic contamination.

### 5. Evidence over declarations

An agent saying "fixed" is not a state transition.

A state transition should be supported by evidence such as:

- a failing test reproduced before a fix;
- a passing acceptance suite after the final mutation;
- a benchmark result;
- a structured experiment outcome;
- an independent review;
- a human approval.

### 6. Roles are not models

`architect`, `debugger`, `bounded-implementer`, and `reviewer` are capability requirements, not aliases for a vendor model.

Routing should be able to consider:

- task complexity;
- task risk;
- required context;
- historical performance;
- remaining budget;
- model price;
- provider health;
- context size;
- harness capabilities.

### 7. Harnesses are replaceable execution substrates

Claude Code, Codex, Pi, TrueForge, OpenHands, and future runtimes should be adapters behind a common execution contract.

Anastom should never require a workflow author to know how a particular harness represents sessions, tools, or subagents.

### 8. Durable state belongs outside the chat transcript

The authoritative state of a run should live in durable, typed artifacts and an append-only event history.

A compacted or lost conversation should be reconstructible from durable state.

### 9. Human intervention is a first-class transition

Pause, inspect, redirect, approve, reject, edit policy, inject evidence, and resume should be ordinary operations.

Human intervention must not require destroying a run or manually reconstructing context.

### 10. Graceful degradation beats magical autonomy

If Redis, Temporal, a remote sandbox, or a preferred model is unavailable, Anastom should degrade predictably where possible rather than silently changing semantics.

## Core methodologies Anastom must eventually support

Anastom should support at least these methodology families:

### Defined SDLC
For known full-stack work with known or discoverable requirements.

Typical graph:

```text
clarify -> design -> plan -> implement -> integrate -> review -> verify
```

### Five Whys / Root Cause Analysis
For systemic defects and incidents.

```text
symptom -> evidence -> causal why -> evidence -> causal why -> ... -> root cause -> corrective action
```

### Hypothesis-driven debugging
For unknown defects.

```text
reproduce -> generate hypotheses -> rank -> discriminating experiment
   ^                                               |
   +---------------- update beliefs ---------------+
                         |
                      converge
                         |
                    fix -> verify
```

### Hypothesis-driven development
For uncertain feasibility, ML/AI exploration, prototypes, and R&D.

```text
goal -> candidate approaches -> cheapest falsifying experiments
     -> update evidence -> kill / continue / branch -> decision
```

### Delegated TDD
For using expensive models to define complex behavior while cheaper agents execute bounded implementation.

```text
frontier planner
  -> acceptance contracts/tests
  -> task decomposition
  -> parallel bounded workers
  -> deterministic integration
  -> frontier semantic review
```

### Specialist council
For cross-domain problems.

```text
independent specialist analyses
  -> shared evidence
  -> cross-critique
  -> synthesis
  -> unresolved disagreement handling
```

### Adversarial search
For multiple viable paths.

```text
competing candidates
  -> advocates / attackers
  -> empirical tests
  -> blind or rubric-driven judge
  -> refinement / selection
```

## Long-term product identity

Anastom should become a **vendor-neutral engineering-agent control plane**, not an AI IDE and not another chatbot.

Its durable competitive advantage should be:

- execution semantics;
- workflow composition;
- methodology primitives;
- evidence models;
- runtime policy;
- model/harness routing;
- reliability;
- replayability;
- observability;
- empirical performance history.

The model ecosystem will change rapidly. Anastom should become more valuable when it does.
