# 0016 — Path-policy scope after a third worker

- Status: Proposed for owner review with M2.5 implementation
- Date: 2026-09-15

## Problem

Path-related findings have appeared in several packages. A single `resolvePath(input)` API would hide the trust and lifetime differences between an operator-selected Task, a model-selected file, a pinned executable, and durable evidence. The Claude Code adapter supplies a third concrete worker for evaluating which checks truly match. This record makes that comparison before a public path-policy API is cemented.

## Current path uses

| Consumer                             | Input and trust                                               | Root, symlink, type, and lifetime rule                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core Task and workflow loaders       | Operator-selected source file and schema references           | Record an absolute source path for provenance. Schema references can be absolute or relative to the authored file; the operator is trusted to select them. These are read-time inputs, not workspace children.                                                     |
| Fake scenario `fromFile`             | Scenario-authored relative file name                          | Resolve within the scenario's canonical directory, lexically and after following symlinks; an existing file whose symlink target remains inside is allowed. Read before constructing the runtime scenario.                                                         |
| Engine command verifier `cwd`        | Workflow-authored relative working directory                  | Resolve within the canonical workspace, lexically and after following symlinks; an existing directory whose target remains inside is allowed. The verifier is independently run by the control plane.                                                              |
| Workspace manager and artifact store | Run-owned state and generated identities                      | Reject symlinked state/worktree/artifact boundaries, require ownership and file type, and preserve immutable evidence across later-process inspection. Creation and later read have different checks.                                                              |
| Codex authentication profile         | End-user auth store and adapter-created temporary profile     | Accept a trusted auth-file symlink after canonicalization, then deliberately link it into an isolated agent home. The end user's store is not a workspace child; the temporary profile dies with the attempt.                                                      |
| Codex installed native tool          | Pinned project installation                                   | Require the inspected native executable to match the project dependency and selected version. This is executable provenance, not workspace containment.                                                                                                            |
| Claude Code installed native tool    | End-user native-installer file                                | Require an ordinary executable at the exact release path and a SHA-256 in the verified signed manifest. No PATH substitution or symlink is accepted. Attest before each attempt; spawn-time replacement remains a reviewable race.                                 |
| Claude Code managed policy           | Fixed OS directories and effective preference domain          | Reject conflicting or unavailable policy inventory. This is discovery of administrator authority, not resolution of an operator path.                                                                                                                              |
| Claude Code file tools               | Model-selected paths interpreted by the unmodified native CLI | Anastom passes a fixed `--restricted` profile and never resolves or reuses private tool-input paths. Local synthetic tests check workspace, outside, symlink, and protected-file behavior. The control plane accepts only a validated report and its own verifier. |

Claude Code passes its schema as a bounded CLI argument and context on stdin; it creates no adapter-owned prompt/schema file. Durable artifacts belong to the existing artifact store, not to the worker.

## Decision for M2.5

Do not add a catch-all path-policy package to the Claude Code implementation. Keep runtime-specific executable attestation, auth-store rules, managed-policy inventory, native file-tool confinement, and durable artifact ownership at their present boundaries. Centralize a rule only where multiple callers share its actual root/trust/symlink/type semantics, with tests at each caller.

The Fake `fromFile` and engine verifier `cwd` are the clearest candidates for a later small shared operation: both take a relative untrusted child of a canonical trusted root, reject lexical and resolved escape, and permit an internal symlink target. They differ in required file type and read/execute lifetime. A candidate API would make those parameters explicit, for example `resolveExistingChild(root, relativeInput, expectedType)`, and return a canonical existing path. This name and signature are a review question, not an exported API. Before extraction, compare their current malformed-input and race behavior and prove that replacing both call sites preserves observable outcomes. Do not use this helper for immutable artifacts, authentication stores, installed executables, or model-private tool inputs.

The result is an informed follow-up workstream after M2.5, rather than a dependency of the one-worker portability demonstration. If CodeQL flags a current dynamic path, fix the specific trust boundary and revisit this decision; suppressing an alert by routing every path through one generic helper would not make distinct rules equivalent.
