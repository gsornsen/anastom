# M1 retrospective — Bounded delegation with durable evidence

## Delivered boundary

[PR #9](https://github.com/gsornsen/anastom/pull/9) was squash-merged as `af8eb878dad1a7168dfda84dcbc911022d44cbc6` after the owner reviewed the final revision. M1 delegates one strict Markdown Task to one fresh Pi worker in an Anastom-owned Git worktree, then runs one independent command verifier. SQLite preserves immutable definitions and ordered events; filesystem artifacts preserve contexts, reports, diffs, and command output for later `status` and `inspect` processes.

The completion evidence includes 118 deterministic tests and six passing PR checks, plus the separately authorized live Pi demonstration using Anthropic `claude-opus-4-8`. The live run passed both HTTP acceptance tests, retained nine digest-verified artifacts, and left the source checkout clean. Exact identities, versions, digests, and historical reproduction commands remain in [M1_EVIDENCE.md](M1_EVIDENCE.md).

## What the slice established

The engineering contract can live outside a model conversation. Task parsing, context construction, workspace ownership, deadline policy, output validation, command verification, and replay belong to Anastom. Pi supplies a bounded implementation loop rather than the acceptance decision.

A useful context is an explicit, immutable artifact. Every attempt receives newly constructed canonical bytes rather than a continued conversation. The Pi session suppresses inherited context files, extensions, skills, and prompt templates; automatic compaction and retries are disabled for this slice. Context identity includes the run and workspace, so equivalent tasks in different workspaces need not have identical context digests.

Durable inspection is independently useful before crash recovery exists. Later CLI processes can reconstruct results and inspect evidence without the original memory or a provider connection. A database row does not establish that a worker still exists, that an abandoned attempt is safe to resume, or that a retry has exclusive ownership. M3 must settle those claims explicitly.

Cancellation is a policy boundary, not merely an abort request. The control plane records the deadline first, requests cancellation once, bounds its wait, and prevents a late result from changing the timed-out outcome. Uncertain termination prevents retry. Tests protect these races; they do not establish operating-system isolation for arbitrary worker tools.

## Changes driven by owner review

Readability required changes across the existing code as well as the new slice. Named options and execution stages replaced long positional calls and compressed control flow. Durable CLI tests now explain the fixture's initial failure and use typed, named helpers to prove observable behavior in later processes.

Formatting, useful public JSDoc, package READMEs/changelogs, SemVer plans, and check ownership are now explicit development expectations. Prettier and maintained ESLint rules provide enforcement; a repository-specific gate checks package metadata, documentation, and release plans. Descriptions are required on all JSDoc blocks, while human review assesses their usefulness. Optional TypeDoc generation validated all eight public package entry points without warnings.

The original initialization SQL became an immutable numbered migration with a checksummed journal, full schema validation, and transactional rollback. Representative original fake/live stores reopened without rewriting definitions, events, or artifacts. Migration metadata adds no worker orchestration state. Future migrations must preserve this evidence discipline.

Versioned schema assets and separate fake source files improve review and tooling. Worker reports now require at least thirty non-whitespace summary characters. Existing run definitions retain their embedded schema contracts; a new validation rule does not retroactively invalidate old evidence. The summary requirement guards shape rather than proving truth.

These decisions are recorded in [ADR 0009](adr/0009-m1-implementation-boundaries.md), [ADR 0010](adr/0010-contributor-hygiene-and-schema-migrations.md), and the ongoing [engineering standards](ENGINEERING.md).

## Limits that M2 must expose

M1 proves one real harness. Its Pi adapter declares capabilities, but the engine does not negotiate or durably record a capability snapshot. Public runtime events carry lifecycle observations, bounded logs, and provider/model identity; they do not carry normalized usage. A second adapter must make those differences explicit without moving harness details into core or engine.

The adapters have individual tests rather than a shared lifecycle conformance suite. M2 should exercise both real adapter facades and the fake runtime with the same agent contract. It must preserve the fake runtime's broader M0 node-kind coverage.

The Pi observation queue currently drops the oldest event when full, regardless of its kind. Conformance coverage should require lifecycle, identity, and final usage observations to survive pressure while allowing bounded log loss. It should also settle terminal-result immutability and cancellation after completion across adapters.

The controlled endpoint task is strong evidence for the vertical slice, with a deliberately small acceptance surface. It establishes neither comparative model quality nor general feature-delivery reliability. M2 should reuse its unchanged task and verifier on equivalent repository baselines, then compare contract compliance and verified outcomes rather than demanding identical implementation text.

## Handoff

The [proposed M2 brief](M2_BUILD_BRIEF.md) makes the next proof portable: one selected adapter, one worker, one verifier, and the same durable evidence boundary. Automatic routing remains M12; interruption recovery remains M3. Initial private package versioning is a separate reviewed step under the existing Changeset plan.
