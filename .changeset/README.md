# Package release plans

Run `pnpm changeset` for a package code or contract change, select its affected packages and SemVer change, and write a reader-facing summary. Commit the generated file in the same PR. Private packages are intentionally versioned but are not tagged or published automatically.

Choose patch for compatible fixes, minor for compatible functionality, and major for incompatible public API changes. Explain contract compatibility in the PR, including persisted data and separately versioned IR/schema changes. The first feature release is planned as 0.1.0; current manifests remain 0.0.0 until reviewed versioning.

`pnpm hygiene` checks new release plans for package changes. Test-only and documentation-only changes do not require a release plan. A maintainer runs `pnpm version:packages` in a reviewed release PR to apply plans, update package versions and changelogs, then runs `pnpm install` to refresh the lockfile. The versioning PR still needs README/changelog review and all checks. No publishing workflow is enabled.

See [engineering standards](../docs/ENGINEERING.md) for the complete development and CI contract.
