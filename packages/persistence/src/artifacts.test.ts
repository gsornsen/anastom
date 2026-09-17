import { lstat, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileArtifactStore } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anastom-artifacts-"));
  roots.push(root);
  return root;
}

describe("filesystem artifacts", () => {
  it("stores immutable bytes and detects tampering", async () => {
    const root = await artifactRoot();
    const artifacts = new FileArtifactStore(root);
    const input = {
      runId: "persisted",
      nodeId: "work",
      attempt: 1,
      type: "diff",
      mediaType: "text/plain",
      bytes: "original",
    };
    const ref = await artifacts.write(input);
    expect(await artifacts.write(input)).toEqual(ref);
    expect((await artifacts.read(ref)).toString()).toBe("original");
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(ref.uri))).mode & 0o777).toBe(0o700);
    expect((await lstat(ref.uri)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(ref.uri))).filter((name) => name.startsWith("."))).toEqual([]);
    const { readFile, writeFile } = await import("node:fs/promises");
    await writeFile(ref.uri, "tampered");
    await expect(artifacts.read(ref)).rejects.toThrow("digest");
    await expect(artifacts.write(input)).rejects.toThrow("differ");
    expect(await readFile(ref.uri, "utf8")).toBe("tampered");
    await expect(artifacts.write({ ...input, runId: "../outside" })).rejects.toThrow("identity");
    await expect(
      artifacts.write({ ...input, bytes: Buffer.alloc(16 * 1024 * 1024 + 1) }),
    ).rejects.toThrow("16 MiB");
  });

  it("rejects a run-owned artifact parent redirected outside the state root", async () => {
    const root = await artifactRoot();
    const artifacts = new FileArtifactStore(root);
    const ref = await artifacts.write({
      runId: "redirected",
      nodeId: "work",
      attempt: 1,
      type: "diff",
      mediaType: "text/plain",
      bytes: "original",
    });
    const outside = await mkdtemp(join(dirname(root), "anastom-artifact-outside-"));
    roots.push(outside);
    const runDirectory = dirname(dirname(ref.uri));
    await rename(runDirectory, join(outside, "redirected"));
    await symlink(join(outside, "redirected"), runDirectory, "dir");
    await expect(artifacts.read(ref)).rejects.toMatchObject({ reason: "wrong-type" });
  });
});
