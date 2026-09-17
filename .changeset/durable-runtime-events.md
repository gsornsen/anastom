---
"@anastom/runtime-contract": major
"@anastom/engine": minor
"@anastom/runtime-pi": minor
"@anastom/runtime-codex": minor
"@anastom/runtime-claude-code": minor
---

Add bounded credential-free runtime descriptors with exact Pi, Codex, and Claude Code codecs, plus portable workspace checkpoint/difference evidence shapes. Remove the unused adapter-level recovery hook in favor of the shared M3 execution-host boundary.

Add exact prepare/authorize, control, cleanup, orphan, typed pause, and recovery-blocked events and reducer state for durable execution. Runtime and command attempts share the same persisted ownership evidence, while process-local workflow lifecycle events retain their current behavior.
