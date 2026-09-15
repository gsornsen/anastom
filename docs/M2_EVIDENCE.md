# M2 portable-worker evidence

Status: implementation and offline feasibility in progress. **M2 is not complete.** The paired live Pi/Codex demonstration and owner review of [ADR 0014](adr/0014-codex-managed-policy-preflight.md) are required before this record can be finalized.

## Identities and environment

The accepted M2 design is [PR #11](https://github.com/gsornsen/anastom/pull/11), merged as `8659117`. Codex discovery/authentication refinement [PR #15](https://github.com/gsornsen/anastom/pull/15) merged as `c5ba209`; client-compaction refinement [PR #18](https://github.com/gsornsen/anastom/pull/18) merged as `e9217e5`. The implementation branch's first signed-off checkpoint is `54389aaa9b985df8213e7a0fa3f0273ddc818df6`. The managed-policy refinement is proposed in ADR 0014 and has no accepted design identity yet.

The local offline checks used Node.js `26.4.0`, pnpm `11.9.0`, macOS Darwin `25.2.0` on arm64, `@openai/codex@0.154.0` with native `codex-cli 0.154.0`, and upstream source tag `rust-v0.154.0` at `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. Routine CI targets Node.js 24 and Linux/macOS; its results belong to the implementation PR. The Codex live selection is OpenAI `gpt-5.6-terra` at medium effort; Pi remains Anthropic `claude-opus-4-8`.

## Deterministic checks so far

The full repository suite passed outside the enclosing process sandbox: 22 test files and 171 tests. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm hygiene`, and `git diff --check` passed after the managed-policy and discovery changes. Warning-free TypeDoc HTML was generated for `core`, `runtime-contract`, `engine`, `runtime-pi`, `runtime-codex`, `persistence`, `workspaces`, and `cli`. The original YAML example validated, rendered its three-node graph, and completed the scripted fake run successfully.

One sandboxed full-suite run failed at `process.kill(-pid, 0)` with macOS `EPERM` during an owned-group confirmation. The same complete suite passed outside that sandbox without changing the accepted 100 ms SIGTERM escalation or 300 ms cleanup confirmation limits. Linux/macOS CI and final local checks must still pass on the final implementation commit.

The exact native [offline audit](M2_FEASIBILITY.md) now covers the adapter's system instructions and report schema, synthetic user/project/ancestor instructions and symlinked/explicit skills, synthetic file-backed ChatGPT refresh through the original auth symlink, one-request HTTP/SSE provider exhaustion, schema-preserving accumulated context, and managed cloud conflicts. The owner-file-backed policy probe used the normal Codex login, found no managed policy, and made zero model calls; it printed only a whitelisted authentication-form and policy result. The actual production policy gate rejected synthetic managed requirements and enterprise configuration before a model request. Shared conformance and process doubles test public evidence filtering, outcome validation, cancellation and surviving descendants, framing, pressure, and policy rejection with no credentials or model calls.

## Original M1 store replay

A local clone at original M1-compatible commit `c5ba2093057df5c938e9eda05a7774caf431efa7` created two distinct SQLite histories using its own installed dependencies and fake Task runner. The newer reader reconstructed both histories in later processes without an executable or provider session:

| Original history         | Run ID                                 | New reader                                                    | Events | Event-row SHA-256 before/after                                     | Workflow-row SHA-256 before/after                                  |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------- | -----: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Endpoint accepted        | `fac27741-93ee-4c78-9ac6-21d0e97dc465` | `status` succeeded; JSON `inspect` replayed                   |     27 | `0eae394b672d9004f7ce4c7d31e0dd0f19c3d90b9bd71a091fc7fba141699cc9` | `5ab7c61cabb0ae3605df19f03bf44cbca6f035ed5f70ef70fe48f5c7f7a9e3cf` |
| Endpoint verifier failed | `a35a40c7-e876-44d0-a010-1a6b0b6ee0a4` | `status` failed with verifier exit 1; JSON `inspect` replayed |     27 | `7403f3aed57b492745db7528c57feb5c9e770d260be801ecdf24a5defdec4e87` | `5ab7c61cabb0ae3605df19f03bf44cbca6f035ed5f70ef70fe48f5c7f7a9e3cf` |

The original stores remain in the local temporary fixtures ending `UDUsNX` and `FD6Piz` under the system temp root. The hashes cover ordered `event_json` and `workflow_json` row bytes, not SQLite's mutable page layout. Both before/after pairs matched exactly.

## Remaining completion evidence

After ADR 0014 review and the final offline gates, perform owner-authenticated Pi and Codex runs on the unchanged endpoint Task from two fresh clones sharing the exact base commit. Record both run IDs, Task/workflow digests, accepted capability snapshots, identity provenance, partial/unknown token observations and inclusion semantics, independent verifier exits and acceptance output, clean source checkouts, retained worktrees/diffs, and later-process `status`/`inspect --json`. Independently re-hash every referenced artifact and compare the common engineering contract with observed harness differences. Re-run all required checks on the final code and record implementation/PR commit identities and CI results here.
