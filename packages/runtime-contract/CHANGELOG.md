# @anastom/runtime-contract changelog

## Unreleased

- Keep nested role, tool-policy, failure-category and capability-validation details internal while retaining the documented request, result, adapter and codec contracts.
- Add exact process-boundary validation for persisted execution requests and normalized terminal results, including 4 MiB request and 1 MiB result limits.
- Add exact validation for versioned workspace checkpoints, ownership evidence, digests, identifiers, and ignored-content limits.
- Add bounded credential-free runtime descriptors, durable adapter and exact codec contracts, a versioned descriptor envelope schema, and portable workspace checkpoint/difference evidence shapes. Remove the unused adapter-level recovery hook and recovery types so M3 process ownership can live in the shared execution host.
- Add versioned capability/observation validation, workspace-mode negotiation, configured/reported identity provenance, and optional partial token counters without changing existing lifecycle variants.
- Extend explicit runtime requests with fresh context, filesystem workspace, artifact, and budget contracts.
- Document public lifecycle events and stable failure classifications.
- Stop exact runtime schema validation on the first error to bound work on invalid public records.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
