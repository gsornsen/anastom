# @anastom/path-policy changelog

## Unreleased

- Add a separate fixed-segment private-state root with owner/mode checks, bounded stable reads, atomic record replacement, immutable exclusive publication, and socket-path byte limits.
- Add a canonical-root resolver for existing files or directories that rejects lexical and symlink escape while allowing internal symlinks.
- Use the operation at Fake scenario, independent verifier, and scoped local CLI source boundaries; leave unrelated path policies with their owners.

No package releases have been tagged. Changesets will prepend reviewed SemVer release entries when maintainers run `pnpm version:packages`; `0.0.0` is the initial development version.
