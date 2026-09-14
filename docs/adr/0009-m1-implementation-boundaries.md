# 0009 — Clarify M1 implementation boundaries

- Status: Accepted implementation refinement
- Date: 2026-09-13

## Context

The M1 contract leaves fake task mutation, partially supplied attempt policies, command environment inheritance, path aliases, and uncertain cancellation details to implementation. Defaults at these boundaries must be explicit and testable.

## Decision

- Fake Markdown task runs require `--fake-scenario`; no fixture-specific behavior is inferred. A successful fake attempt may declare explicit workspace-relative file contents, with mutation-mode and symlink/path checks.
- Optional worker policy fields independently default to one attempt and ten minutes. A partially supplied policy cannot silently remove the deadline.
- Command verification inherits only path, home, temporary-directory, platform command, and locale variables. Task-authored environment values remain unsupported. This policy reduces accidental credential environment propagation and does not sandbox trusted commands.
- Canonical paths account for operating-system aliases such as macOS `/var` and `/private/var`. Symlink checks apply inside owned state directories; durable ownership comparison uses structural equality rather than JSON insertion order.
- Read-only tasks require a clean source checkout so base-relative mutation detection is meaningful. Read-only tools and worktrees are execution conventions, without operating-system isolation.
- Deadline, cancellation, and late-result events have ordered reducer transitions. Timeout cannot transition to success. An unconfirmed or failed cancellation prevents retry; runtime stream/collection errors also stop retries because safe termination cannot be established.
- Cleanup retains dirty work and worker commits rather than deleting evidence. It operates only on recorded owned worktrees and is safe to repeat after clean removal.
- Capture the workspace after worker execution and after verification so final evidence includes verifier-side changes as well.
- Task loading intentionally reads an operator-selected local filename, consistent with workflow loading. It is not a network authorization boundary. A future server must authorize filesystem access at its call site before invoking the loader; M1 introduces no server. CodeQL alert 6 (`js/path-injection`) is a false positive for this profile and is dismissed individually with this rationale, without disabling the query. Review formatting re-reported the identical read as alert 7 on commit `d7bb4d9`; it was compared with alert 6 and individually triaged on the same local-file boundary. No additional path or network capability was introduced.

## Consequences

M0's authored workflows and fake paths remain compatible. M1 keeps one worker and one independent verifier, with no routing, recovery, cleanup sweeper, or general artifact graph. The [demo guide](../M1_DEMO.md) documents these limits; boundary tests prove the accepted behavior.
