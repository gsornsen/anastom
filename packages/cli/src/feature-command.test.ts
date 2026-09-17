import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CodexRuntimeAdapter } from "@anastom/runtime-codex";
import { createFeatureWorkspaceTopology } from "@anastom/workspaces";

import { openDurableCliServices } from "./durable.js";
import { prepareFeatureCommand } from "./feature-command.js";

const execute = promisify(execFile);
const fixtures: string[] = [];

function featureMarkdown(): string {
  return `---
apiVersion: anastom.dev/v1alpha1
kind: Feature
metadata: {id: test/feature-command, version: 0.1.0}
acceptanceCriteria:
  - Both independent changes are present
verification:
  - id: test
    argv: [pnpm, test]
    maxDuration: 1m
policies: {maxTasks: 2, maxParallel: 2}
---
Implement two independent changes and verify the integrated result.
`;
}

async function createRepository(name: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `anastom-feature-command-${name}-`)));
  fixtures.push(root);
  await execute("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  await execute("git", ["config", "user.name", "Anastom Fixture"], { cwd: root });
  await execute("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  await writeFile(join(root, ".gitignore"), ".anastom/\n");
  await execute("git", ["add", "."], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

describe("Feature command preparation", () => {
  it("binds a repository Feature and its verifier definitions into one protected snapshot", async () => {
    const repository = await createRepository("bound");
    await writeFile(join(repository, "feature.md"), featureMarkdown());
    await execute("git", ["add", "feature.md"], { cwd: repository });
    await execute(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-q",
        "-m",
        "feature",
      ],
      { cwd: repository },
    );

    const prepared = await prepareFeatureCommand({
      sourceRoot: repository,
      target: "feature.md",
      repository,
    });

    expect(prepared.repositoryRoot).toBe(repository);
    expect(prepared.protectedPaths).toEqual(["feature.md"]);
    expect(prepared.workflow.definedSdlc).toMatchObject({
      protectedPaths: ["feature.md"],
      feature: {
        metadata: { id: "test/feature-command", version: "0.1.0" },
        verification: [{ id: "test", command: { argv: ["pnpm", "test"] } }],
      },
      methodology: { metadata: { id: "sdlc/default" } },
    });
  });

  it("rejects a Feature that is outside the selected target repository", async () => {
    const source = await createRepository("source");
    const target = await createRepository("target");
    await writeFile(join(source, "feature.md"), featureMarkdown());

    await expect(
      prepareFeatureCommand({ sourceRoot: source, target: "feature.md", repository: target }),
    ).rejects.toThrow("Feature source must be inside the selected Git repository");
  });

  it("creates durable state only after its protected integration topology exists", async () => {
    const repository = await createRepository("durable");
    await writeFile(join(repository, "feature.md"), featureMarkdown());
    await execute("git", ["add", "feature.md"], { cwd: repository });
    await execute(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-q",
        "-m",
        "feature",
      ],
      { cwd: repository },
    );
    const prepared = await prepareFeatureCommand({
      sourceRoot: repository,
      target: "feature.md",
      repository,
    });
    const services = await openDurableCliServices(join(repository, ".anastom"));
    try {
      const topology = await createFeatureWorkspaceTopology(
        services.workspaces,
        repository,
        "feature-command",
        prepared.protectedPaths,
      );
      const descriptor = await new CodexRuntimeAdapter({
        provider: "openai",
        model: "fixture-model",
        reasoningEffort: "medium",
      }).descriptor();
      const state = await services.coordinator.createRun(prepared.workflow, {
        runId: "feature-command",
        workspace: topology.integration,
        descriptor,
      });
      const retained = await services.store.load("feature-command", "complete-history");

      expect(topology.protectedPaths).toEqual(["feature.md"]);
      expect(topology.integration.branch).toBe("anastom/feature-command--integration");
      expect(state.nodes.analysis?.status).toBe("ready");
      expect(retained?.events.map(({ type }) => type)).toEqual([
        "RunCreated",
        "RuntimeConfigured",
        "WorkspaceAssigned",
        "NodeReady",
      ]);
    } finally {
      services.store.close();
    }
  });
});
