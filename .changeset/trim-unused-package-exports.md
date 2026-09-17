---
"@anastom/cli": major
"@anastom/core": major
"@anastom/engine": major
"@anastom/execution-host": major
"@anastom/path-policy": patch
"@anastom/runtime-claude-code": major
"@anastom/runtime-codex": major
"@anastom/runtime-contract": major
"@anastom/runtime-fake": major
"@anastom/runtime-pi": major
"@anastom/workspaces": major
---

Remove unused package-entry exports and direct exports of implementation-only types, constants, parsers, validators, and test helpers before the first supported release. Keep documented package contracts explicit and mark deliberate public contracts or internal test seams for production dead-code analysis.
