---
apiVersion: anastom.dev/v1alpha1
kind: Feature
metadata: { id: demo/parallel-normalizers, version: 0.1.0 }
acceptanceCriteria:
  - normalizeDisplayName validates string input, trims its ends, collapses internal whitespace, preserves letter case, and does not add dependencies
  - normalizeLabels validates an array of strings, trims and lowercases each label, removes empty and duplicate labels, returns code-point sorted output, does not mutate its input, and does not add dependencies
  - The protected acceptance program passes against the integrated result
verification:
  - id: acceptance
    argv: [node, acceptance.mjs]
    maxDuration: 30s
policies:
  maxTasks: 2
  maxParallel: 2
  protectedPaths: [acceptance.mjs, AGENTS.md]
  attemptPolicy: { maxAttempts: 1, maxDuration: 10m }
---

Implement the two independent normalization modules already present under `src/`. Plan exactly one task for `src/normalize-display-name.mjs` and one task for `src/normalize-labels.mjs` so they can run concurrently. Preserve the public export names and dependency-free ESM design. Combine the accepted task patches, review the complete behavior, and run only the authored acceptance command.
