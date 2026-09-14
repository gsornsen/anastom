# Additional Recommendations

## 1. Build an eval corpus from day one

Anastom's long-term advantage can become empirical rather than anecdotal.

Create a growing corpus of:

- seeded bugs;
- refactors;
- full-stack features;
- ambiguous architecture choices;
- ML feasibility experiments;
- integration failures.

Record:

- workflow version;
- runtime;
- model;
- effort;
- cost;
- elapsed time;
- attempts;
- verifier outcomes;
- human intervention;
- final quality.

This becomes the basis for future routing.

## 2. Version methodologies independently from Anastom core

A regression in `debug/hypothesis@1.4` should not require a core release.

Runs should record exact methodology versions.

## 3. Add "why" to every control-plane decision

Future trace events should capture machine-readable reasons:

```json
{
  "decision": "switch-runtime",
  "from": "claude",
  "to": "codex",
  "reason": "repeated_verifier_failure",
  "evidence": ["verifier:unit-tests:attempt-2"]
}
```

This makes behavior debuggable.

## 4. Treat prompts like compiled assets

Prompt templates should have:

- versions;
- tests;
- expected structured outputs;
- token size measurements.

But prompts should not own workflow state.

## 5. Preserve failed approaches as evidence, not context

Failed work matters, but it should become a concise artifact:

```text
approach
assumption
experiment
result
why rejected
```

rather than remaining as thousands of transcript tokens.

## 6. Make clean-room review easy

Add a reviewer context mode that intentionally hides:

- implementation reasoning;
- previous reviews;
- author/model identity.

This will be valuable for both quality and future benchmark data.

## 7. Capture runtime/model regressions

Because Anastom normalizes workloads across runtimes, it can detect:

> the same methodology + task class suddenly needs more attempts after model version X.

That could become one of Anastom's most useful capabilities.

## 8. Distinguish execution budget from reasoning budget

Budgets should eventually exist at:

- run;
- workflow;
- node;
- attempt.

And may include:

- tokens;
- cost;
- elapsed time;
- mutation count;
- tool calls;
- retries.

## 9. Allow methodology overlays

Instead of duplicating workflows, support future overlays such as:

```text
sdlc/default
+ security/high-risk
+ compliance/soc2
+ frontend/accessibility
```

An overlay can add:

- required reviewers;
- gates;
- verifiers;
- artifacts.

## 10. Keep the Workflow IR human-readable

Developers should be able to inspect a methodology and understand what will happen without running it.

Avoid turning the IR into a general programming language.

Use extension nodes or code evaluators for exceptional cases.

## 11. Add a simulation/dry-run mode early

Before execution:

```bash
anastom plan feature.md --method sdlc/default
```

should eventually show:

- expected graph;
- candidate runtimes/models;
- estimated parallelism;
- configured budgets;
- required human gates.

This is a high-value trust feature.

## 12. Make interoperability a product feature

Potential commands:

```bash
anastom import superpowers ...
anastom import mycelium ...
anastom export skill ...
anastom doctor runtime pi
anastom doctor runtime codex
```

The ecosystem will keep fragmenting. Anastom can benefit by being the layer that absorbs fragmentation.

## 13. Use Anastom to build Anastom as early as practical

Once M2/M3 are stable, dogfood the runtime on its own backlog.

But avoid recursive self-modification before circuit breakers and recovery are trustworthy.

## 14. Keep a "known model behavior" registry

Do not encode stereotypes in workflows, but allow empirical annotations:

```text
model X:
  strong: architecture, semantic review
  weak: strict bounded edits
  observed_at: date/version
  sample_size: N
```

Routing can later consume measured data rather than folklore.

## 15. Define an Anastom run bundle

A portable run bundle could contain:

```text
manifest
workflow version
policy
events
artifacts metadata
evidence
usage
final diff refs
verification records
```

This would make bug reports, benchmarking, audit, and replay dramatically easier.

## 16. Explicitly test orchestrator failure

Most agent evals test worker intelligence.

Anastom should test:

- wrong retry;
- wrong escalation;
- accidental context leakage;
- duplicate work;
- lost state;
- invalid fan-in;
- stale evidence;
- run resumption.

The control plane is the product. Test it accordingly.
