---
apiVersion: anastom.dev/v1alpha1
kind: Task
metadata:
  id: demo/add-endpoint
  version: 0.1.0
role: bounded-implementer
workspace:
  mutation: isolated
acceptanceCriteria:
  - GET /health returns HTTP 200 and the JSON body {"status":"ok"}.
  - Unmatched routes continue to return HTTP 404.
  - Existing acceptance tests pass without editing the tests.
verification:
  argv: [node, --test, server.test.mjs]
  maxDuration: 30s
  maxOutputBytes: 1048576
attemptPolicy:
  maxAttempts: 1
  maxDuration: 5m
---

# Add a health endpoint

Implement GET /health in server.mjs using the existing HTTP server conventions.
Change only server.mjs. Do not modify the acceptance tests or add dependencies.
