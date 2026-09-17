import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  assertFeatureDefinition,
  assertNormalizedFeaturePlan,
  assertSdlcGraphExpansion,
  assertSdlcMethodologySnapshot,
  assertWorkflowDefinition,
  compileSdlcFeature,
  expandSdlcPlan,
  loadFeatureWithinRoot,
  loadSdlcMethodology,
  normalizeFeature,
  normalizeFeaturePlan,
  parseFeatureMarkdown,
  parseReviewReport,
} from "./index.js";

function featureMarkdown(overrides = ""): string {
  return `---
apiVersion: anastom.dev/v1alpha1
kind: Feature
metadata:
  id: demo/health
  version: 0.1.0
acceptanceCriteria:
  - GET /health returns a successful response
verification:
  - id: test
    argv: [pnpm, test]
    maxDuration: 2m
policies:
  maxTasks: 4
  maxParallel: 2
${overrides}---
# Health endpoint

Implement a health endpoint and cover it with an independent test.
`;
}

function validPlan() {
  return {
    summary: "Implement the endpoint and its independent acceptance coverage.",
    tasks: [
      {
        id: "server",
        title: "Implement endpoint",
        objective: "Add the required health endpoint implementation.",
        acceptanceCriteria: ["The endpoint returns a successful response"],
        dependsOn: [],
        mutationScopes: ["src/server.ts"],
      },
      {
        id: "tests",
        title: "Add tests",
        objective: "Add independent coverage for the health endpoint.",
        acceptanceCriteria: ["The endpoint behavior is covered"],
        dependsOn: [],
        mutationScopes: ["test/health.test.ts"],
      },
      {
        id: "docs",
        title: "Document endpoint",
        objective: "Document the verified health endpoint behavior.",
        acceptanceCriteria: ["The endpoint is documented"],
        dependsOn: ["server", "tests"],
        mutationScopes: ["README.md"],
      },
    ],
    risks: ["The fixture may use a different server entry point"],
  };
}

describe("Feature contract", () => {
  it("parses and normalizes operator-owned verification and planning bounds", () => {
    const parsed = parseFeatureMarkdown(featureMarkdown());
    const first = normalizeFeature(parsed, "/tmp/feature.md");
    const second = normalizeFeature(parseFeatureMarkdown(featureMarkdown()), "/other/feature.md");

    expect(first).toMatchObject({
      metadata: { id: "demo/health", version: "0.1.0" },
      policies: {
        maxTasks: 4,
        maxParallel: 2,
        attemptBudget: { maxAttempts: 1, maxDurationMs: 1_200_000 },
      },
      verification: [
        {
          id: "test",
          command: {
            argv: ["pnpm", "test"],
            cwd: ".",
            maxDurationMs: 120_000,
            maxOutputBytes: 1_048_576,
          },
        },
      ],
    });
    expect(first.documentDigest).toBe(second.documentDigest);
  });

  it("rejects unknown fields", () => {
    expect(() => parseFeatureMarkdown(featureMarkdown("unexpected: true\n"))).toThrow(
      "additional properties",
    );
  });

  it("rejects parallelism beyond the task bound", () => {
    const source = featureMarkdown().replace(
      "maxTasks: 4\n  maxParallel: 2",
      "maxTasks: 2\n  maxParallel: 3",
    );
    expect(() => parseFeatureMarkdown(source)).toThrow("cannot exceed");
  });

  it("confines Feature selection to the authorized source root", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "anastom-feature-contract-"));
    const root = join(fixture, "root");
    const inside = join(root, "feature.md");
    const outside = join(fixture, "outside.md");
    try {
      await cp(resolve("methodologies/sdlc/default"), root, { recursive: true });
      await Promise.all([
        writeFile(inside, featureMarkdown()),
        writeFile(outside, featureMarkdown()),
      ]);
      await expect(loadFeatureWithinRoot(root, inside)).resolves.toMatchObject({
        metadata: { id: "demo/health" },
      });
      await expect(loadFeatureWithinRoot(root, outside)).rejects.toMatchObject({
        reason: "outside-root",
      });
      await symlink(outside, join(root, "escape.md"));
      await expect(loadFeatureWithinRoot(root, "escape.md")).rejects.toMatchObject({
        reason: "outside-root",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe("methodology snapshot", () => {
  it("loads every bounded role and remains stable after relocation", async () => {
    const original = await loadSdlcMethodology(resolve("methodologies/sdlc/default"));
    const fixture = await mkdtemp(join(tmpdir(), "anastom-methodology-contract-"));
    try {
      const relocated = join(fixture, "default");
      await cp(resolve("methodologies/sdlc/default"), relocated, { recursive: true });
      const copy = await loadSdlcMethodology(relocated);

      expect(Object.keys(original.roles)).toEqual([
        "analyst",
        "planner",
        "implementer",
        "integrator",
        "specificationReviewer",
        "qualityReviewer",
      ]);
      expect(original.roles.analyst.mutation).toBe("readonly");
      expect(original.roles.implementer.mutation).toBe("isolated");
      expect(original.methodologyDigest).toBe(copy.methodologyDigest);
      expect(() => assertSdlcMethodologySnapshot(original)).not.toThrow();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("rejects methodology resources that escape through a symlink", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "anastom-methodology-escape-"));
    const root = join(fixture, "default");
    try {
      await cp(resolve("methodologies/sdlc/default"), root, { recursive: true });
      const outside = join(fixture, "outside.md");
      await writeFile(outside, "private prompt");
      await rm(join(root, "prompts", "analyst.md"));
      await symlink(outside, join(root, "prompts", "analyst.md"));

      await expect(loadSdlcMethodology(root)).rejects.toMatchObject({
        reason: "outside-root",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe("plan and review contracts", () => {
  it("derives stable topological waves and canonical scopes", () => {
    const plan = validPlan();
    plan.tasks[2]!.mutationScopes = ["./docs/../README.md"];
    const first = normalizeFeaturePlan(plan, { maxTasks: 4, maxParallel: 2 });
    const second = normalizeFeaturePlan(structuredClone(plan), { maxTasks: 4, maxParallel: 2 });

    expect(first.taskOrder).toEqual(["server", "tests", "docs"]);
    expect(first.waves).toEqual([["server", "tests"], ["docs"]]);
    expect(first.tasks.docs?.mutationScopes).toEqual(["README.md"]);
    expect(first.planDigest).toBe(second.planDigest);
    expect(() => assertNormalizedFeaturePlan(first)).not.toThrow();
  });

  it("compiles immutable analysis and planning nodes from Feature methodology", async () => {
    const feature = normalizeFeature(parseFeatureMarkdown(featureMarkdown()), "/tmp/feature.md");
    const methodology = await loadSdlcMethodology(resolve("methodologies/sdlc/default"));
    const workflow = compileSdlcFeature(feature, methodology, { protectedPaths: ["feature.md"] });

    expect(() => assertFeatureDefinition(feature)).not.toThrow();
    expect(() => assertWorkflowDefinition(workflow)).not.toThrow();
    expect(workflow.nodeOrder).toEqual(["analysis", "planning"]);
    expect(workflow.nodes.planning).toMatchObject({
      role: "planner",
      needs: ["analysis"],
      mutation: "readonly",
      output: { ref: "schemas/feature-plan.v1alpha1.json" },
    });
  });

  it.each([
    [
      "unknown dependencies",
      (plan: ReturnType<typeof validPlan>) => plan.tasks[2]!.dependsOn.push("missing"),
      "unknown task",
    ],
    [
      "cycles",
      (plan: ReturnType<typeof validPlan>) => plan.tasks[0]!.dependsOn.push("docs"),
      "cycle",
    ],
    [
      "overlapping ready scopes",
      (plan: ReturnType<typeof validPlan>) => (plan.tasks[1]!.mutationScopes = ["src"]),
      "overlapping mutation scopes",
    ],
    [
      "repository traversal",
      (plan: ReturnType<typeof validPlan>) => (plan.tasks[1]!.mutationScopes = ["../outside"]),
      "unsafe mutation scope",
    ],
  ])("rejects %s", (_name, mutate, expected) => {
    const plan = validPlan();
    mutate(plan);
    expect(() => normalizeFeaturePlan(plan, { maxTasks: 4, maxParallel: 2 })).toThrow(expected);
  });

  it("accepts bounded independent review reports and rejects extra authority", () => {
    const accepted = parseReviewReport({
      approved: true,
      summary: "The integrated revision satisfies the supplied contract.",
      findings: [],
    });
    expect(accepted.approved).toBe(true);
    expect(() => parseReviewReport({ ...accepted, runCommand: "pnpm test" })).toThrow(
      "additional properties",
    );
    expect(() =>
      parseReviewReport({
        approved: false,
        summary: "The integrated revision does not satisfy the contract.",
        findings: [],
      }),
    ).toThrow("requires at least one blocking finding");
  });

  it("expands trusted plans independently of runtime completion order", async () => {
    const feature = normalizeFeature(parseFeatureMarkdown(featureMarkdown()), "/tmp/feature.md");
    const methodology = await loadSdlcMethodology(resolve("methodologies/sdlc/default"));
    const plan = normalizeFeaturePlan(validPlan(), feature.policies);
    const first = expandSdlcPlan(feature, methodology, plan);
    const second = expandSdlcPlan(feature, methodology, structuredClone(plan));

    expect(first.nodeOrder).toEqual([
      "implement.server",
      "implement.tests",
      "integrate.wave-1",
      "implement.docs",
      "integrate.wave-2",
      "integrator",
      "integrate.final",
      "review.specification",
      "review.quality",
      "verify.test",
    ]);
    expect(first.nodes["implement.server"]?.needs).toEqual(["planning"]);
    expect(first.nodes["implement.docs"]?.needs).toEqual(["integrate.wave-1"]);
    expect(first.nodes["review.specification"]?.needs).toEqual(["integrate.final"]);
    expect(first.nodes["implement.server"]).toMatchObject({
      role: "implementer",
      taskId: "server",
      output: { ref: "schemas/worker-report.v1alpha1.json" },
    });
    expect(first.expansionDigest).toBe(second.expansionDigest);
    expect(() => assertSdlcGraphExpansion(first)).not.toThrow();
  });

  it("refuses a persisted expansion whose content no longer matches its digest", async () => {
    const feature = normalizeFeature(parseFeatureMarkdown(featureMarkdown()), "/tmp/feature.md");
    const methodology = await loadSdlcMethodology(resolve("methodologies/sdlc/default"));
    const expansion = expandSdlcPlan(
      feature,
      methodology,
      normalizeFeaturePlan(validPlan(), feature.policies),
    );
    const changed = structuredClone(expansion);
    changed.maxParallel = 1;

    expect(() => assertSdlcGraphExpansion(changed)).toThrow("digest does not match");
  });
});
