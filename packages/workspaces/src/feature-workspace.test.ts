import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEndpointRepository,
  removeEndpointRepository,
} from "../../engine/src/testing/fixture.js";
import {
  GitWorkspaceManager,
  assertIntegrationPreparation,
  captureScopedWorkspacePatch,
  createFeatureTaskWorkspace,
  createFeatureWorkspaceTopology,
  prepareWorkspaceIntegration,
  reconcileWorkspaceIntegration,
} from "./index.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeEndpointRepository(root);
  }
});

async function setup(runId = "feature") {
  const root = await createEndpointRepository();
  roots.push(root);
  const manager = new GitWorkspaceManager(join(root, ".anastom"));
  const topology = await createFeatureWorkspaceTopology(manager, root, runId);
  return { root, manager, topology };
}

async function patchTask(options: {
  manager: GitWorkspaceManager;
  topology: Awaited<ReturnType<typeof createFeatureWorkspaceTopology>>;
  taskId: string;
  path: string;
  append: string;
  mutationScopes?: readonly string[];
  protectedPaths?: readonly string[];
}) {
  const workspace = await createFeatureTaskWorkspace(
    options.manager,
    options.topology,
    options.taskId,
    options.topology.sourceBaseCommit,
  );
  const target = join(workspace.path, ...options.path.split("/"));
  await writeFile(target, (await readFile(target, "utf8")) + options.append);
  const accepted = await captureScopedWorkspacePatch(options.manager, workspace, {
    mutationScopes: options.mutationScopes ?? [options.path],
    protectedPaths: options.protectedPaths ?? ["tasks/add-endpoint.md"],
  });
  return { workspace, accepted };
}

describe("Feature workspace topology", () => {
  it("creates unique task worktrees at the exact dependency-wave base", async () => {
    const { manager, topology } = await setup();
    const server = await createFeatureTaskWorkspace(
      manager,
      topology,
      "server",
      topology.sourceBaseCommit,
    );
    const tests = await createFeatureTaskWorkspace(
      manager,
      topology,
      "tests",
      topology.sourceBaseCommit,
    );

    expect(topology.integration.baseCommit).toBe(topology.sourceBaseCommit);
    expect(server.baseCommit).toBe(topology.sourceBaseCommit);
    expect(tests.baseCommit).toBe(topology.sourceBaseCommit);
    expect(new Set([topology.integration.path, server.path, tests.path]).size).toBe(3);
    expect(new Set([topology.integration.branch, server.branch, tests.branch]).size).toBe(3);
    await expect(
      createFeatureTaskWorkspace(manager, topology, "later", "0".repeat(40)),
    ).rejects.toThrow("integration head");
  });

  it("accepts exact scoped changes and rejects protected or out-of-scope paths", async () => {
    const acceptedFixture = await setup("scope-accepted");
    const { accepted } = await patchTask({
      ...acceptedFixture,
      taskId: "server",
      path: "server.mjs",
      append: "\n// scoped change\n",
    });
    expect(accepted.changedFiles).toEqual(["server.mjs"]);
    expect(accepted.patch.byteLength).toBeGreaterThan(0);
    expect(accepted.patchDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const noChangeFixture = await setup("scope-no-change");
    const noChangeWorkspace = await createFeatureTaskWorkspace(
      noChangeFixture.manager,
      noChangeFixture.topology,
      "no-change",
      noChangeFixture.topology.sourceBaseCommit,
    );
    const noChange = await captureScopedWorkspacePatch(noChangeFixture.manager, noChangeWorkspace, {
      mutationScopes: ["server.mjs"],
      protectedPaths: ["tasks/add-endpoint.md"],
    });
    expect(noChange.changedFiles).toEqual([]);
    expect(noChange.patch).toHaveLength(0);
    expect(noChange.patchDigest).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    const protectedFixture = await setup("scope-protected");
    await expect(
      patchTask({
        ...protectedFixture,
        taskId: "protected",
        path: "tasks/add-endpoint.md",
        append: "\nprotected change\n",
        mutationScopes: ["tasks"],
      }),
    ).rejects.toMatchObject({ reason: "protected-path" });

    const outsideFixture = await setup("scope-outside");
    await expect(
      patchTask({
        ...outsideFixture,
        taskId: "outside",
        path: "server.mjs",
        append: "\noutside scope\n",
        mutationScopes: ["server.test.mjs"],
      }),
    ).rejects.toMatchObject({ reason: "scope" });
  });
});

describe("prepared Git integration", () => {
  it("creates a deterministic commit and synchronizes only the owned integration worktree", async () => {
    const { root, manager, topology } = await setup("integration");
    const server = await patchTask({
      manager,
      topology,
      taskId: "server",
      path: "server.mjs",
      append: "\n// integrated server\n",
    });
    const tests = await patchTask({
      manager,
      topology,
      taskId: "tests",
      path: "server.test.mjs",
      append: "\n// integrated tests\n",
    });
    const patches = [
      { taskId: "server", accepted: server.accepted },
      { taskId: "tests", accepted: tests.accepted },
    ];
    const prepared = await prepareWorkspaceIntegration(manager, topology.integration, patches);
    const repeated = await prepareWorkspaceIntegration(manager, topology.integration, patches);

    expect(prepared.expectedCommit).toBe(repeated.expectedCommit);
    expect(() => assertIntegrationPreparation(prepared)).not.toThrow();
    await expect(
      reconcileWorkspaceIntegration(manager, topology.integration, prepared),
    ).resolves.toMatchObject({ outcome: "committed", movedReference: true });
    expect(await readFile(join(topology.integration.path, "server.mjs"), "utf8")).toContain(
      "integrated server",
    );
    expect(await readFile(join(topology.integration.path, "server.test.mjs"), "utf8")).toContain(
      "integrated tests",
    );
    expect((await execute("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("");
    await expect(
      reconcileWorkspaceIntegration(manager, topology.integration, prepared),
    ).resolves.toMatchObject({
      outcome: "committed",
      movedReference: false,
      synchronizedWorktree: false,
    });

    const noChangeWorkspace = await createFeatureTaskWorkspace(
      manager,
      topology,
      "integration-corrections",
      prepared.expectedCommit,
    );
    const noChange = await captureScopedWorkspacePatch(manager, noChangeWorkspace, {
      mutationScopes: ["server.mjs"],
      protectedPaths: ["tasks/add-endpoint.md"],
    });
    const noChangePreparation = await prepareWorkspaceIntegration(manager, topology.integration, [
      { taskId: "integration-corrections", accepted: noChange },
    ]);
    expect(noChangePreparation.tree).toBe(prepared.tree);
    expect(noChangePreparation.expectedCommit).not.toBe(prepared.expectedCommit);
    await expect(
      reconcileWorkspaceIntegration(manager, topology.integration, noChangePreparation),
    ).resolves.toMatchObject({ outcome: "committed", movedReference: true });
  });

  it("recovers after the branch moves and refuses unrelated branch or worktree state", async () => {
    const moved = await setup("moved-ref");
    const task = await patchTask({
      ...moved,
      taskId: "server",
      path: "server.mjs",
      append: "\n// moved ref\n",
    });
    const prepared = await prepareWorkspaceIntegration(moved.manager, moved.topology.integration, [
      { taskId: "server", accepted: task.accepted },
    ]);
    await execute(
      "git",
      [
        "update-ref",
        `refs/heads/${prepared.branch}`,
        prepared.expectedCommit,
        prepared.parentCommit,
      ],
      { cwd: moved.root },
    );
    await expect(
      reconcileWorkspaceIntegration(moved.manager, moved.topology.integration, prepared),
    ).resolves.toMatchObject({
      movedReference: false,
      synchronizedWorktree: true,
    });

    const dirty = await setup("dirty-integration");
    const dirtyTask = await patchTask({
      ...dirty,
      taskId: "server",
      path: "server.mjs",
      append: "\n// accepted\n",
    });
    const dirtyPreparation = await prepareWorkspaceIntegration(
      dirty.manager,
      dirty.topology.integration,
      [{ taskId: "server", accepted: dirtyTask.accepted }],
    );
    await writeFile(join(dirty.topology.integration.path, "server.mjs"), "unrelated change\n");
    await expect(
      reconcileWorkspaceIntegration(dirty.manager, dirty.topology.integration, dirtyPreparation),
    ).rejects.toMatchObject({ reason: "unexpected-state" });
    expect(await readFile(join(dirty.topology.integration.path, "server.mjs"), "utf8")).toBe(
      "unrelated change\n",
    );

    const unrelated = await setup("unrelated-ref");
    const unrelatedTask = await patchTask({
      ...unrelated,
      taskId: "server",
      path: "server.mjs",
      append: "\n// expected\n",
    });
    const unrelatedPreparation = await prepareWorkspaceIntegration(
      unrelated.manager,
      unrelated.topology.integration,
      [{ taskId: "server", accepted: unrelatedTask.accepted }],
    );
    const unexpected = (
      await execute(
        "git",
        [
          "-c",
          "commit.gpgSign=false",
          "commit-tree",
          unrelatedPreparation.tree,
          "-p",
          unrelatedPreparation.expectedCommit,
          "-m",
          "unrelated",
        ],
        { cwd: unrelated.root },
      )
    ).stdout.trim();
    await execute(
      "git",
      [
        "update-ref",
        `refs/heads/${unrelatedPreparation.branch}`,
        unexpected,
        unrelatedPreparation.parentCommit,
      ],
      { cwd: unrelated.root },
    );
    await expect(
      reconcileWorkspaceIntegration(
        unrelated.manager,
        unrelated.topology.integration,
        unrelatedPreparation,
      ),
    ).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("rejects same-wave scope overlap before applying patches", async () => {
    const { manager, topology } = await setup("overlap");
    const scopes = ["server.mjs", "server.test.mjs"];
    const server = await patchTask({
      manager,
      topology,
      taskId: "server",
      path: "server.mjs",
      append: "\n// server\n",
      mutationScopes: scopes,
    });
    const tests = await patchTask({
      manager,
      topology,
      taskId: "tests",
      path: "server.test.mjs",
      append: "\n// tests\n",
      mutationScopes: scopes,
    });
    await expect(
      prepareWorkspaceIntegration(manager, topology.integration, [
        { taskId: "server", accepted: server.accepted },
        { taskId: "tests", accepted: tests.accepted },
      ]),
    ).rejects.toMatchObject({ reason: "conflict" });
  });
});
