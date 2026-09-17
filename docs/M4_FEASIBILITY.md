# M4 model-free feasibility evidence

## Status and boundary

The graph-expansion, concurrent-execution, and prepared-Git-integration probes pass on the owner macOS arm64 host without a model call or authentication-store read. They establish the implementation constraints in the [M4 build brief](M4_BUILD_BRIEF.md) and [ADR 0019](adr/0019-durable-defined-sdlc.md). They do not expose package APIs or implement `sdlc/default`.

Run the complete boundary from the repository root:

```bash
pnpm verify:m4:feasibility
```

The three probes are independently runnable as `pnpm probe:m4:graph`, `pnpm probe:m4:concurrency`, and `pnpm probe:m4:integration`.

## Deterministic graph expansion

The graph probe validates a three-task plan with two independent tasks and one dependent task. It creates stable implementation nodes, explicit integration-wave barriers, an integrator, two independent reviewers, and a verifier. Two simulations deliberately choose opposite active-node completion orders.

Observed results:

| Evidence                                        | Result                             |
| ----------------------------------------------- | ---------------------------------- |
| Canonical expansion repeated from the same plan | Equal                              |
| Runtime completion orders                       | Different                          |
| Integration order across both runs              | `server`, `tests`, `documentation` |
| Maximum active nodes with capacity two          | 2                                  |
| Dependency cycle                                | Rejected                           |
| Overlapping ready-task scopes                   | Rejected                           |
| Parent-traversing scope                         | Rejected                           |

This supports persisted wave barriers instead of deriving integration order from worker completion timing. The production contract must validate task IDs, dependencies, scopes, limits, and expansion digest before emitting one authoritative expansion event.

## Concurrent owned executions

The concurrency probe uses the production `LocalExecutionHost` and its checked-in command fixture. It prepares and authorizes two hold executions with distinct execution UUIDs under the same run identity and fencing generation, then reopens the host through another object with no process-local handles.

Observed results:

- both executions are simultaneously `active`;
- the reopened host authenticates and classifies both from private durable records;
- any active observation forbids replacement;
- cancelling both executions concurrently returns two authenticated `absent` observations with `outcome: cancelled` and `cleanup: confirmed`;
- only the all-absent set permits replacement;
- corrupting one terminal record changes that execution to `unknown`, and the mixed unknown/absent set forbids replacement;
- public evidence contains no private fixture sentinel.

The execution host already supports multiple execution identities per run and generation. The current coordinator does not: it selects one ready node, drives it synchronously, and recovery helpers return only the first owned or orphaned attempt. Production work must replace those singular assumptions with deterministic collections and fan-in control/recovery handling while retaining one serialized `OwnedRunSession` mutation stream.

## Prepared Git integration

The Git probe creates a disposable repository, an owned integration worktree, and two task worktrees based on the same commit. Each task changes a disjoint file. The probe captures the exact binary-capable patch bytes, applies them to a temporary Git index, writes the resulting tree and deterministic commit object, and records the expected parent/result before moving the integration branch.

The same preparation produces the same commit. Recovery succeeds at all three interruption boundaries:

1. preparation persisted before branch compare-and-swap;
2. branch moved before worktree synchronization;
3. worktree synchronized before the committed event.

At each accepted boundary the reconciler reaches the exact prepared commit with a clean integration worktree. An unexpected branch head is refused. Integrated file contents match both accepted task patches, and the source checkout remains clean.

The experiment also caught an exact-byte requirement: trimming `git diff --binary` output removed its terminal newline and made `git apply` reject the patch as corrupt. Production artifact and integration APIs must preserve patch bytes without text normalization.

The recorded sample preparation digest was `sha256:37c2532bdba324e766b53e357df2f6b8488307160432cf33081d96f10b029b4a`. The commit itself is deterministic from the parent, ordered patches, message, identity, and fixed metadata; the production implementation must derive and persist its own bounded metadata rather than depend on wall-clock defaults.

## Contract refinements

The probes settle these choices before production APIs:

- expansion inserts explicit integration waves; later-wave workers branch only after the prior wave's integration commit;
- same-wave mutation scopes must be disjoint under segment-aware prefix comparison;
- active-execution recovery and whole-run controls operate over all current owned attempts;
- replacement scheduling requires every affected execution to be conclusively absent and every workspace reconciled;
- exact patch bytes are immutable artifacts and inputs to the prepared integration digest;
- integration preparation writes Git objects without moving an owned ref;
- ref movement uses compare-and-swap from the recorded parent;
- only the inactive, controller-owned integration worktree may be synchronized automatically to a prepared commit;
- any other branch/worktree identity pauses without further mutation.

No persistence migration is required by these probes. Expanded definitions, workspace assignments, integration preparation, and integration completion can remain authoritative events plus snapshots unless the production implementation produces contrary size or transaction evidence.
