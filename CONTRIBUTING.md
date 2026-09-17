# Contributing to Anastom

Anastom welcomes bug reports, design feedback, documentation improvements, tests, and code contributions. The project is still defining foundational APIs, so early discussion is especially valuable when a change affects the Workflow IR, runtime contract, event model, or persistence boundary.

## Before starting

Search existing issues and discussions first. Small, well-scoped fixes may go directly to a pull request. For new features, public API changes, or architecture changes, open a design proposal issue before investing in implementation.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) and should not be reported in a public issue.

## Development setup

Anastom currently requires Node.js 24 or newer and pnpm 11.9.0.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm dead-code
pnpm anastom validate examples/workflows/demo-feature.yaml
pnpm anastom run examples/workflows/demo-feature.yaml --fake-scenario examples/fake/success.yaml
```

Automated M1/M2/M2.5 tests use temporary Git repositories, deterministic Pi sessions, and Codex/Claude Code native-process doubles. M3 feasibility and acceptance also kill deterministic coordinators, supervisors, and their owned fixture process groups to prove recovery boundaries. `pnpm probe:m3:process` exercises the initial ownership findings; `pnpm probe:m3:supervisor` exercises the production-shaped protocol; `pnpm probe:m3:sqlite` exercises real multi-process database contention with an isolated temporary schema; `pnpm probe:m3:workspace` exercises exact content and Git ownership comparisons in disposable repositories; `pnpm probe:m3:snapshot` exercises snapshot/tail equality and authoritative fallback against a disposable current run store; and `pnpm verify:m3` exercises the final production composition with the real 15-second lease. These tests must not call real models, read authentication stores, or require provider credentials. The [M1 demo guide](docs/M1_DEMO.md), [M2 completion evidence](docs/M2_EVIDENCE.md), [M2.5 evidence](docs/M2_5_EVIDENCE.md), [M3 feasibility evidence](docs/M3_FEASIBILITY.md), and [M3 implementation evidence](docs/M3_EVIDENCE.md) document the separate integration and process-level checks.

## Engineering expectations

Contributions should preserve the boundaries in [VISION.md](docs/VISION.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), and [WORKFLOW_IR.md](docs/WORKFLOW_IR.md):

- the runtime governs state, budgets, retries, gates, and verification;
- all state changes pass through typed transitions and durable events;
- core and engine code remain independent of models and harnesses;
- structured output is validated before it can affect workflow state;
- independent agents exchange explicit artifacts and evidence rather than hidden transcript state;
- public behavior has focused tests at the boundary where it is introduced;
- abstractions earn their place through a current use case.

Keep pull requests narrow enough to review. Update design documents when behavior, contracts, or architectural assumptions change. Add a retrospective or decision record when implementation reveals that the design intent should change.

## Keep the project overview current

Update `README.md` in every pull request by default. It should give an external reader an accurate view of the project's purpose, supported behavior, setup, limitations, milestone status, and links to deeper documentation. Keep implemented capabilities distinct from planned work.

A README edit may be omitted when the change has no meaningful effect on that overview, such as a test-only correction or a mechanical change that leaves supported behavior and setup unchanged. Explain the specific reason in the pull request. Avoid artificial README edits made only to satisfy the policy.

Record notable user-facing or project changes in `CHANGELOG.md`. Keep the README's changelog link working; the overview and detailed change history serve different purposes.

## Tests and evidence

Follow the [engineering standards](docs/ENGINEERING.md) for readability, JSDoc, test fixtures, package documentation, SemVer, migrations, and CI ownership. Run `pnpm format` to apply the formatter. Before requesting review, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm dead-code`, `pnpm format:check`, and `pnpm hygiene`. Add a Changeset with `pnpm changeset` for changed package code or contracts; update the affected package README and changelog. Generate optional package API documentation with `pnpm docs:api <package>` when reviewing an API change.

Tests should prove observable behavior and failure handling. Avoid tests that merely repeat an implementation. A pull request should state which checks ran and include relevant output or fixtures for behavior that cannot be covered by the standard commands.

For every implementation or refactor, audit the changed capability and its callers for code, exports, dependencies, wrappers, tests, fixtures, configuration, and current documentation that the new path supersedes. Delete obsolete material in the same pull request. `pnpm dead-code` performs AST and dependency-graph checks in both whole-repository and production-only modes; reviewers still decide whether a reachable test protects supported behavior and whether prose remains accurate. Historical evidence and decision records remain when they explain project history, with superseded conclusions labeled clearly.

## Commits

Use clear, imperative commit subjects. Keep generated files and mechanical changes separate when that helps review.

The project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) for contribution provenance. Add a `Signed-off-by` line with:

```bash
git commit --signoff
```

The sign-off certifies that you have the right to submit the contribution under the repository's contribution and licensing terms. It does not assign your copyright.

Contributions are accepted under `AGPL-3.0-only`, the same license under which the project is distributed, unless a file states otherwise. Anastom does not currently require a contributor license agreement or copyright assignment. Changes to contributor terms follow the public process in [GOVERNANCE.md](GOVERNANCE.md).

## AI-assisted contributions

AI assistance is welcome, but the human contributor remains responsible for the result. Disclose substantial AI assistance in the pull request, review every generated change, run the required checks, and ensure the contribution contains no secrets, private data, or copied material you do not have permission to submit.

## Review

Maintainers evaluate correctness, evidence, architectural fit, scope, compatibility, security, and long-term maintenance cost. A technically sound change may still need revision if it embeds orchestration policy in prompts, couples core code to one harness, or expands a milestone without a reviewed design decision.

Participation in the project must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

The project's reciprocal-use boundary and commitments against community capture are documented in [COMMUNITY_STEWARDSHIP.md](COMMUNITY_STEWARDSHIP.md).
