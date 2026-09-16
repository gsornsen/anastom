# @anastom/path-policy

Provide one narrow operation for an **existing child of a caller-authorized canonical directory**. `canonicalExistingRoot(root)` resolves an existing directory; `resolveExistingChild(root, input, expectedType)` rejects lexical and symlink escape, checks an existing file or directory, and permits an internal symlink target. Callers choose and authorize the root and retain their own grammar, creation, and lifetime rules.

This operation is used for Fake scenario file references and the control-plane verifier's working directory. The CLI also applies it to operator-selected Task/Workflow files and their schema references under its current directory, so a path from CLI arguments cannot make the loader read outside that explicit local source scope. Run Anastom from a directory containing the authored source tree; `--repo` may still select a separate target Git repository. Direct core loaders remain local APIs for trusted callers that authorize their own files.

The operation is deliberately unsuitable for immutable artifact creation, end-user authentication stores, signed executable provenance, managed-policy discovery, or model-private native file-tool inputs. Those boundaries have different roots, symlink rules, and lifetimes. [ADR 0016](../../docs/adr/0016-path-policy-after-third-adapter.md) records the third-adapter comparison. The [public source entry](src/index.ts) has JSDoc; generate optional API HTML with `pnpm docs:api path-policy`.

Run `pnpm test packages/path-policy`, `pnpm typecheck`, and `pnpm lint` from the repository root. Follow [CONTRIBUTING.md](../../CONTRIBUTING.md). License: [AGPL-3.0-only](../../LICENSE).
