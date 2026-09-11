# Repository Setup

This checklist captures the repository controls that cannot be expressed entirely as committed files.

## Initial publication

- Keep the unmodified GNU AGPL version 3 license text in `LICENSE`, and use the SPDX expression `AGPL-3.0-only` in package metadata.
- Perform a professional trademark clearance before relying on the Anastom name for a business, registering a mark, or investing materially in brand assets. A web or registry search is only preliminary clearance.
- Reserve the GitHub organization or repository, relevant package namespaces, primary domains, and social handles that will identify official releases. Record who controls each account and enable two-factor authentication.
- Create `gsornsen/anastom` as a public repository without generated README, license, or `.gitignore` files.
- Push the prepared local `main` branch.
- Add the description: `Adaptive orchestration for autonomous software-engineering agents.`
- Add topics such as `agpl`, `ai-agents`, `developer-tools`, `open-source`, `orchestration`, `typescript`, and `workflow-engine`.
- Enable Issues and Discussions. Disable the wiki unless it gains a clear purpose; durable technical documentation belongs in the repository.
- Enable squash merging, automatic branch deletion, and automatic merge. Keep merge commits disabled unless the release process later needs them.
- Point the project website and package metadata back to one canonical repository so users can distinguish official artifacts from mirrors and forks.

## Main branch ruleset

Create the ruleset after the initial branch exists:

- require a pull request before merge;
- require the `Test, types, lint, and demo`, `DCO sign-off`, and `Dependency review` status checks;
- require all conversations to be resolved;
- require branches to be up to date before merge;
- block force pushes and branch deletion;
- require linear history;
- allow the repository owner to bypass for recovery and initial administration.

Do not require an approving review while there is only one maintainer because authors cannot approve their own pull requests. Require at least one approval when a second active maintainer can review changes.

## Security

- Enable private vulnerability reporting.
- Enable Dependabot alerts and security updates.
- Enable secret scanning and push protection.
- Enable CodeQL default setup for JavaScript and TypeScript.
- Keep Actions token permissions read-only by default.
- Allow only required GitHub Actions and prefer full commit-SHA pins.
- Review dependency and action update pull requests rather than enabling blind auto-merge.
- Add dependency review on pull requests before accepting runtime dependencies.
- Publish build provenance and an SBOM when distributable packages or container images are introduced.

## Community and maintenance

- Create the labels referenced by the issue forms and release configuration.
- Keep the committed DCO workflow required before accepting third-party commits.
- Pin a welcome discussion describing current scope and how design decisions are made.
- Create milestones only for approved scopes; do not use issue labels as a substitute for acceptance criteria.
- Record foundational API decisions in design proposals or architecture decision records.
- Tag releases from reviewed commits and publish generated release notes with the curated changelog.
- Revisit `GOVERNANCE.md`, `SECURITY.md`, and the support window before the first stable release.
- Review [COMMUNITY_STEWARDSHIP.md](../COMMUNITY_STEWARDSHIP.md) whenever a stable extension boundary, hosted component, commercial program, project telemetry, or new legal steward is proposed.

## Licensing

Anastom uses `AGPL-3.0-only`. It permits internal and revenue-producing business use while requiring source availability for covered modifications and modified network deployments. It may not reach an independent proprietary wrapper around an unmodified Anastom process. [LICENSING.md](LICENSING.md) records the decision and its practical boundaries.

The recommended launch policy offers no paid or proprietary exceptions, uses DCO sign-off, and leaves copyright with each contributor. Before changing that policy, follow the public review requirements in `GOVERNANCE.md`; DCO provenance does not transfer copyright or automatically grant rights to relicense a contributor's work commercially.
