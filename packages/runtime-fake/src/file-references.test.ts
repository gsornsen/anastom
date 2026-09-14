import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadFakeScenario, parseFakeScenario, FakeRuntimeAdapter } from "./index.js";
import type { ExecutionRequest } from "@anastom/runtime-contract";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function scenarioFixture(source = "server.mjs") {
  const root = await mkdtemp(join(tmpdir(), "anastom-scenario-"));
  roots.push(root);
  const directory = join(root, "scenario");
  await mkdir(directory);
  const file = join(directory, "worker.yaml");
  await writeFile(
    file,
    JSON.stringify({
      nodes: {
        work: [
          {
            output: {},
            files: { "target.mjs": { fromFile: source }, "inline.txt": "inline text" },
          },
        ],
      },
    }),
  );
  return { root, directory, file };
}

describe("Scenario file references", () => {
  it("resolves source files relative to the scenario and preserves inline content", async () => {
    const { directory, file } = await scenarioFixture();
    await writeFile(join(directory, "server.mjs"), "export const value = 42;\n");

    const scenario = await loadFakeScenario(file);

    expect(scenario.nodes.work?.[0]).toMatchObject({
      files: { "target.mjs": "export const value = 42;\n", "inline.txt": "inline text" },
    });
  });

  it.each(["../outside.mjs", "/etc/passwd", "..\\outside.mjs"])(
    "rejects a reference outside the scenario directory: %s",
    async (source) => {
      const { file } = await scenarioFixture(source);
      await expect(loadFakeScenario(file)).rejects.toThrow("within its directory");
    },
  );

  it("rejects a source symlink escape and reports a missing source", async () => {
    const { root, directory, file } = await scenarioFixture();
    const outside = join(root, "outside.mjs");
    await writeFile(outside, "private outside content");
    await symlink(outside, join(directory, "server.mjs"));
    await expect(loadFakeScenario(file)).rejects.toThrow("escapes its directory");
    const missing = await scenarioFixture("missing.mjs");
    await expect(loadFakeScenario(missing.file)).rejects.toThrow("cannot load scenario");
  });

  it("materializes a referenced file before writing it into an authorized worktree", async () => {
    const { root, directory, file } = await scenarioFixture();
    await writeFile(join(directory, "server.mjs"), "export const value = 42;\n");
    const workspace = join(root, "worktree");
    await mkdir(workspace);
    const request: ExecutionRequest = {
      runId: "file-reference",
      workflowInstanceId: "file-reference:root",
      nodeId: "work",
      nodeKind: "agent",
      attempt: 1,
      workspace: {
        id: "owned",
        mode: "isolated",
        repoRoot: root,
        path: workspace,
        baseCommit: "base",
        branch: "owned",
      },
      context: { inputs: {}, dependencyOutputs: {} },
      budget: { maxAttempts: 1 },
      requiredOutputSchema: {},
      toolPolicy: { allowMutations: true },
    };
    const adapter = new FakeRuntimeAdapter(await loadFakeScenario(file));
    await adapter.start(request);
    expect(await readFile(join(workspace, "target.mjs"), "utf8")).toBe(
      "export const value = 42;\n",
    );
    const unresolved = new FakeRuntimeAdapter(parseFakeScenario(await readFile(file, "utf8")));
    await expect(unresolved.start(request)).rejects.toThrow("loadFakeScenario");
  });

  it("rejects malformed pointer objects and workspace symlink targets", async () => {
    expect(() =>
      parseFakeScenario(
        '{"nodes":{"work":[{"output":{},"files":{"x":{"fromFile":"x","extra":true}}}]}}',
      ),
    ).toThrow("Invalid fake scenario");
    const { root, directory, file } = await scenarioFixture();
    await writeFile(join(directory, "server.mjs"), "replacement");
    const workspace = join(root, "worktree");
    await mkdir(workspace);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "preserved");
    await symlink(outside, join(workspace, "target.mjs"));
    const request: ExecutionRequest = {
      runId: "unsafe-target",
      workflowInstanceId: "unsafe-target:root",
      nodeId: "work",
      nodeKind: "agent",
      attempt: 1,
      workspace: {
        id: "owned",
        mode: "isolated",
        repoRoot: root,
        path: workspace,
        baseCommit: "base",
        branch: "owned",
      },
      context: { inputs: {}, dependencyOutputs: {} },
      budget: { maxAttempts: 1 },
      requiredOutputSchema: {},
      toolPolicy: { allowMutations: true },
    };
    await expect(
      new FakeRuntimeAdapter(await loadFakeScenario(file)).start(request),
    ).rejects.toThrow("symlink");
    expect(await readFile(outside, "utf8")).toBe("preserved");
  });
});
