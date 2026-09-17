import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEndpointRepository,
  removeEndpointRepository,
} from "../../engine/src/testing/fixture.js";
import { GitWorkspaceManager } from "./index.js";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeEndpointRepository(root);
  }
});
async function setup() {
  const root = await createEndpointRepository();
  roots.push(root);
  return { root, manager: new GitWorkspaceManager(join(root, ".anastom")) };
}
describe("Git worktree ownership", () => {
  it("isolates edits and captures tracked, new, and committed changes without staging them", async () => {
    const { root, manager } = await setup();
    const original = await readFile(join(root, "server.mjs"), "utf8");
    const workspace = await manager.create(root, "isolated");
    if (workspace.mode !== "isolated") {
      throw new Error("wrong mode");
    }
    await writeFile(join(workspace.path, "server.mjs"), original + "\n// change\n");
    await writeFile(join(workspace.path, "new.txt"), "new artifact\n");
    const capture = await manager.capture(workspace);
    expect(capture.diff).toContain("+// change");
    expect(capture.diff).toContain("new artifact");
    expect(capture.changedFiles).toEqual(["new.txt", "server.mjs"]);
    expect(await readFile(join(root, "server.mjs"), "utf8")).toBe(original);
    expect(
      (await exec("git", ["diff", "--cached", "--name-only"], { cwd: workspace.path })).stdout,
    ).toBe("");
    await exec("git", ["add", "."], { cwd: workspace.path });
    await exec(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "worker change",
      ],
      { cwd: workspace.path },
    );
    expect((await manager.capture(workspace)).diff).toContain("new artifact");
    await expect(manager.cleanup(workspace)).rejects.toThrow("worker commits");
    expect(await readFile(join(workspace.path, "new.txt"), "utf8")).toContain("new artifact");
  });
  it("cleans an owned clean worktree idempotently", async () => {
    const { root, manager } = await setup();
    const workspace = await manager.create(root, "cleanup");
    await manager.cleanup(workspace);
    await manager.cleanup(workspace);
    if (workspace.mode !== "isolated") {
      throw new Error("wrong mode");
    }
    await expect(lstat(workspace.path)).rejects.toThrow();
    expect((await exec("git", ["branch", "--list", "anastom/cleanup"], { cwd: root })).stdout).toBe(
      "",
    );
  });
  it("refuses unowned paths and keeps dirty work", async () => {
    const { root, manager } = await setup();
    const workspace = await manager.create(root, "retain");
    if (workspace.mode !== "isolated") {
      throw new Error("wrong mode");
    }
    await expect(manager.cleanup({ ...workspace, path: root })).rejects.toThrow("owned");
    await writeFile(join(workspace.path, "untracked.txt"), "keep");
    await expect(manager.cleanup(workspace)).rejects.toThrow();
    expect(await readFile(join(workspace.path, "untracked.txt"), "utf8")).toBe("keep");
    await expect(manager.create(root, "../escape")).rejects.toThrow("run ID");
  });
  it("represents read-only workspaces without creating a branch", async () => {
    const { root, manager } = await setup();
    const workspace = await manager.create(root, "read", "readonly");
    expect(workspace.mode).toBe("readonly");
    if (workspace.mode === "memory") {
      throw new Error("wrong mode");
    }
    expect(workspace.path).toBe(root);
    await expect(manager.cleanup(workspace)).rejects.toThrow("owned");
  });
  it("refuses to branch from a dirty source checkout", async () => {
    const { root, manager } = await setup();
    await writeFile(join(root, "untracked.txt"), "operator work\n");
    await expect(manager.create(root, "dirty-source")).rejects.toThrow("clean source checkout");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("operator work\n");
  });
});
