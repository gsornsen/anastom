---
"@anastom/path-policy": minor
"@anastom/core": minor
"@anastom/cli": major
"@anastom/engine": patch
"@anastom/runtime-fake": patch
---

Add a narrow existing-child resolver shared by Fake scenario references, verifier working directories, and scoped CLI source reads. Core gains additive scoped Task/Workflow loaders. The CLI now confines authored Task/Workflow/schema files to its current directory; selecting an absolute source outside that tree requires running Anastom from the containing source directory. This is a documented breaking CLI selection change, while direct trusted core loaders retain their previous behavior.
