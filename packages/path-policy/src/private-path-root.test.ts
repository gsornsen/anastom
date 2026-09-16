import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensurePrivatePathRoot, PrivatePathError } from "./index.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })));
});

async function fixtureRoot() {
  const fixture = await mkdtemp(join(tmpdir(), "anastom-private-path-"));
  fixtures.push(fixture);
  const state = join(fixture, "state");
  return { fixture, state, root: await ensurePrivatePathRoot(state) };
}

describe("private state path root", () => {
  it("creates exact private modes and atomically replaces bounded records", async () => {
    const { state, root } = await fixtureRoot();
    await root.ensureDirectory(["runs", "run-1"]);
    await root.writeFileAtomic(["runs", "run-1", "manifest.json"], Buffer.from("first"), {
      maxBytes: 16,
    });
    await root.writeFileAtomic(["runs", "run-1", "manifest.json"], Buffer.from("second"), {
      maxBytes: 16,
    });

    expect(await root.readFile(["runs", "run-1", "manifest.json"], { maxBytes: 16 })).toEqual(
      Buffer.from("second"),
    );
    expect((await lstat(state)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(state, "runs", "run-1"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(state, "runs", "run-1", "manifest.json"))).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing owner-controlled root and enforces byte limits", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "anastom-private-path-"));
    fixtures.push(fixture);
    const state = join(fixture, "state");
    await mkdir(state, { mode: 0o755 });
    await chmod(state, 0o755);
    const root = await ensurePrivatePathRoot(state);
    expect((await lstat(state)).mode & 0o777).toBe(0o700);
    await root.writeFileAtomic(["record"], Buffer.from("12345"), { maxBytes: 5 });
    await expect(root.readFile(["record"], { maxBytes: 4 })).rejects.toMatchObject({
      reason: "limit",
    });
    await expect(
      root.writeFileAtomic(["record"], Buffer.from("123456"), { maxBytes: 5 }),
    ).rejects.toMatchObject({ reason: "limit" });
  });

  it("publishes immutable records idempotently and rejects different existing bytes", async () => {
    const { root } = await fixtureRoot();
    await root.writeFileExclusive(["immutable"], Buffer.from("first"), { maxBytes: 16 });
    await root.writeFileExclusive(["immutable"], Buffer.from("first"), { maxBytes: 16 });
    await expect(
      root.writeFileExclusive(["immutable"], Buffer.from("second"), { maxBytes: 16 }),
    ).rejects.toMatchObject({ reason: "changed" });
    expect(await root.readFile(["immutable"], { maxBytes: 16 })).toEqual(Buffer.from("first"));
  });

  it("rejects path expressions and enforces complete socket-path bytes", async () => {
    const { root } = await fixtureRoot();
    await root.ensureDirectory(["sockets"]);
    for (const segment of ["", ".", "..", "a/b", "a\\b", "bad\0name", "/absolute"]) {
      expect(() => root.socketPath(["sockets", segment], { maxBytes: 100 })).toThrow(
        PrivatePathError,
      );
    }
    const socket = root.socketPath(["sockets", "worker.sock"], { maxBytes: 200 });
    expect(socket.endsWith("/sockets/worker.sock")).toBe(true);
    expect(() => root.socketPath(["sockets", "worker.sock"], { maxBytes: 10 })).toThrow(
      /byte limit/,
    );
  });

  it("rejects symlinked roots, parents and records", async () => {
    const { fixture, state, root } = await fixtureRoot();
    const outsideDirectory = join(fixture, "outside");
    await mkdir(outsideDirectory);
    await chmod(outsideDirectory, 0o700);
    await writeFile(join(outsideDirectory, "record"), "outside", { mode: 0o600 });
    await symlink(outsideDirectory, join(state, "alias"), "dir");
    await expect(root.readFile(["alias", "record"], { maxBytes: 16 })).rejects.toMatchObject({
      reason: "wrong-type",
    });

    await symlink(join(outsideDirectory, "record"), join(state, "record"));
    await expect(root.readFile(["record"], { maxBytes: 16 })).rejects.toMatchObject({
      reason: "wrong-type",
    });
    await expect(
      root.writeFileAtomic(["record"], Buffer.from("replacement"), { maxBytes: 16 }),
    ).rejects.toMatchObject({ reason: "wrong-type" });

    const rootAlias = join(fixture, "state-alias");
    await symlink(state, rootAlias, "dir");
    await expect(ensurePrivatePathRoot(rootAlias)).rejects.toBeInstanceOf(PrivatePathError);
  });
});
