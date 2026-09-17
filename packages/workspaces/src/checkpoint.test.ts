import { execFile } from "node:child_process";
import { mkdir, readFile, rename, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEndpointRepository,
  removeEndpointRepository,
} from "../../engine/src/testing/fixture.js";
import {
  captureWorkspaceCheckpoint,
  compareWorkspaceCheckpoints,
  GitWorkspaceManager,
} from "./index.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeEndpointRepository(root);
  }
});

async function setup(runId = "checkpoint") {
  const root = await createEndpointRepository();
  roots.push(root);
  await writeFile(join(root, ".gitignore"), "ignored/\nlarge.bin\n");
  await exec("git", ["add", ".gitignore"], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      "checkpoint fixture",
    ],
    { cwd: root },
  );
  const manager = new GitWorkspaceManager(join(root, ".anastom"));
  const workspace = await manager.create(root, runId);
  if (workspace.mode !== "isolated") {
    throw new Error("Expected an isolated workspace");
  }
  return { root, manager, workspace };
}

describe("workspace checkpoints", () => {
  it("captures complete content twice without changing staging", async () => {
    const { manager, workspace } = await setup();
    const server = join(workspace.path, "server.mjs");
    await writeFile(server, `${await readFile(server, "utf8")}\n// checkpoint\n`);
    await exec("git", ["add", "server.mjs"], { cwd: workspace.path });
    await writeFile(join(workspace.path, "binary.dat"), Buffer.from([0, 255, 1, 254]));
    await symlink("server.mjs", join(workspace.path, "server-link"));
    await mkdir(join(workspace.path, "ignored", "nested"), { recursive: true });
    await writeFile(join(workspace.path, "ignored", "nested", "cache.bin"), Buffer.from([3, 2, 1]));

    const stagedBefore = (
      await exec("git", ["diff", "--cached", "--binary"], {
        cwd: workspace.path,
        encoding: "buffer",
      })
    ).stdout;
    const first = await captureWorkspaceCheckpoint(manager, workspace);
    const repeated = await captureWorkspaceCheckpoint(manager, workspace);
    const stagedAfter = (
      await exec("git", ["diff", "--cached", "--binary"], {
        cwd: workspace.path,
        encoding: "buffer",
      })
    ).stdout;

    expect(compareWorkspaceCheckpoints(first.checkpoint, repeated.checkpoint)).toEqual({
      matches: true,
      differences: [],
    });
    expect(first.checkpoint.changedFiles).toEqual(["binary.dat", "server-link", "server.mjs"]);
    expect(first.checkpoint.ignoredEntryCount).toBe(3);
    expect(first.checkpoint.ignoredByteCount).toBe(3);
    expect(first.diff).toContain("GIT binary patch");
    expect(stagedAfter).toEqual(stagedBefore);
  });

  it("treats staging layout as irrelevant and detects ignored-content changes", async () => {
    const { manager, workspace } = await setup("content");
    const server = join(workspace.path, "server.mjs");
    await writeFile(server, `${await readFile(server, "utf8")}\n// same content\n`);
    await exec("git", ["add", "server.mjs"], { cwd: workspace.path });
    await mkdir(join(workspace.path, "ignored"));
    const ignored = join(workspace.path, "ignored", "cache.txt");
    await writeFile(ignored, "first");
    const staged = await captureWorkspaceCheckpoint(manager, workspace);

    await exec("git", ["reset", "-q"], { cwd: workspace.path });
    const unstaged = await captureWorkspaceCheckpoint(manager, workspace);
    expect(compareWorkspaceCheckpoints(staged.checkpoint, unstaged.checkpoint).matches).toBe(true);

    await writeFile(ignored, "second");
    const changed = await captureWorkspaceCheckpoint(manager, workspace);
    expect(compareWorkspaceCheckpoints(staged.checkpoint, changed.checkpoint)).toEqual({
      matches: false,
      differences: ["ignored-content"],
    });
  });

  it("ignores only the later artifact reference during comparison", async () => {
    const { manager, workspace } = await setup("artifact");
    const capture = await captureWorkspaceCheckpoint(manager, workspace);
    const withArtifact = { ...capture.checkpoint, diffArtifactId: "artifact-1" };
    expect(compareWorkspaceCheckpoints(capture.checkpoint, withArtifact)).toEqual({
      matches: true,
      differences: [],
    });
  });

  it("fails closed for ownership changes and ignored content over the byte limit", async () => {
    const { root, manager, workspace } = await setup("ownership");
    const manifest = join(root, ".anastom", "runs", workspace.id, "workspace.json");
    const savedManifest = join(root, "saved-workspace.json");
    await rename(manifest, savedManifest);
    await symlink(savedManifest, manifest);
    await expect(captureWorkspaceCheckpoint(manager, workspace)).rejects.toThrow(
      "ownership manifest",
    );

    const second = await setup("large");
    const large = join(second.workspace.path, "large.bin");
    await writeFile(large, "");
    await truncate(large, 64 * 1024 * 1024 + 1);
    await expect(captureWorkspaceCheckpoint(second.manager, second.workspace)).rejects.toThrow(
      "byte limit",
    );
  });

  it("rejects a branch that no longer matches the owned workspace", async () => {
    const { manager, workspace } = await setup("branch");
    await exec("git", ["switch", "-q", "-c", "other-branch"], { cwd: workspace.path });
    await expect(captureWorkspaceCheckpoint(manager, workspace)).rejects.toThrow("ownership");
  });

  it("checkpoints readonly selections only when private state is outside the repository", async () => {
    const root = await createEndpointRepository();
    roots.push(root);
    const externalState = join(dirname(root), `${basename(root)}-readonly-state`);
    roots.push(externalState);
    const manager = new GitWorkspaceManager(externalState);
    const workspace = await manager.create(root, "readonly", "readonly");
    const first = await captureWorkspaceCheckpoint(manager, workspace);
    const repeated = await captureWorkspaceCheckpoint(manager, workspace);
    expect(compareWorkspaceCheckpoints(first.checkpoint, repeated.checkpoint).matches).toBe(true);
    expect(first.checkpoint.changedFiles).toEqual([]);

    const nested = new GitWorkspaceManager(join(root, ".anastom"));
    const nestedWorkspace = await nested.create(root, "nested", "readonly");
    await expect(captureWorkspaceCheckpoint(nested, nestedWorkspace)).rejects.toThrow(
      "outside the repository",
    );
  });

  it("rejects a workspace that changes between its two captures", async () => {
    const { manager, workspace } = await setup("unstable");
    const capture = manager.capture.bind(manager);
    let calls = 0;
    manager.capture = async (selected) => {
      const observed = await capture(selected);
      calls += 1;
      if (calls === 1) {
        await writeFile(join(workspace.path, "changed-between-captures.txt"), "changed");
      }
      return observed;
    };
    await expect(captureWorkspaceCheckpoint(manager, workspace)).rejects.toThrow(
      "changed while its checkpoint",
    );
  });

  it("rejects ignored trees over the entry limit", async () => {
    const { manager, workspace } = await setup("entries");
    const ignored = join(workspace.path, "ignored");
    await mkdir(ignored);
    for (let offset = 0; offset < 4_096; offset += 128) {
      await Promise.all(
        Array.from({ length: 128 }, (_, index) =>
          writeFile(join(ignored, `entry-${offset + index}`), ""),
        ),
      );
    }
    await expect(captureWorkspaceCheckpoint(manager, workspace)).rejects.toThrow("entry limit");
  });
});
