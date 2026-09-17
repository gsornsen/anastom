# Repository instructions for agents

Follow the [engineering standards](docs/ENGINEERING.md) and [contribution expectations](CONTRIBUTING.md) for every code addition, extension, refactor, test, and review.

Package source, comments, JSDoc, identifiers, filenames, fixtures, and test names must describe durable capabilities and behavior without requiring milestone context. Keep labels such as `M1`, `M2`, and `M3` in roadmaps, build briefs, evidence, retrospectives, and other historical planning documents. Remove transitional APIs and compatibility wrappers when their replacement is complete unless a current supported caller, released contract, or retained user data requires them.

Every implementation and refactor must satisfy the [implementation definition of done](docs/ENGINEERING.md#definition-of-done-for-implementation). Run `pnpm dead-code`, delete unreachable or superseded source, exports, dependencies, fixtures, and tests, and inspect related documentation for stale descriptions or links. Static reachability does not prove that a test or document remains useful, so include that semantic audit in review. During pre-release MLP development, prefer direct replacement and deletion over compatibility code when no supported boundary requires it.

Update [README.md](README.md) in every pull request by default so an external reader can understand the project's purpose, current support, setup, limitations, roadmap, and documentation. Keep delivered capabilities distinct from plans and preserve the [changelog](CHANGELOG.md) link.

If a change has no meaningful effect on the overview, leave the README unchanged and explain the specific reason in the pull request. Do not make artificial edits merely to satisfy the policy. Record notable changes in `CHANGELOG.md`.
