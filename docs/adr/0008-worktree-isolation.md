# 0008 — Use Anastom-Owned Git Worktrees for Mutation Isolation

- Status: Accepted
- Date: 2026-09-11

## Context

An agent modifying the user's active checkout can overwrite unrelated work and makes concurrent execution unsafe. Allowing a harness to choose its workspace also hides a key control-plane decision.

## Decision

The control plane creates an isolated Git branch and worktree from a recorded base commit for every mutating M1 run. It passes the resulting workspace reference to the runtime, captures the final diff, and retains the workspace for inspection by default.

Cleanup operates only on paths and branches proven to belong to Anastom. M1 also represents read-only workspaces. Shared integration and runtime-managed external workspaces are deferred.

## Consequences

The user's checkout remains unchanged and each worker has a traceable mutation boundary. Worktrees consume disk until explicitly cleaned. Git isolation does not restrict host filesystem, network, process, or credential access and must not be described as a security sandbox.
