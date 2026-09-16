import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalExistingRoot, resolveExistingChild } from "./index.js";

describe("existing child of a trusted canonical root", () => {
  it("allows internal symlinks of the expected type and rejects traversal or escapes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "anastom-path-policy-"));
    const root = join(fixture, "root");
    const outside = join(fixture, "outside.txt");
    try {
      await mkdir(join(root, "child"), { recursive: true });
      await writeFile(join(root, "child", "inside.txt"), "inside");
      await writeFile(outside, "outside");
      await symlink(join(root, "child", "inside.txt"), join(root, "internal.txt"));
      await symlink(outside, join(root, "escape.txt"));
      const canonical = await canonicalExistingRoot(root);
      expect(await resolveExistingChild(canonical, ".", "directory")).toBe(canonical);
      await expect(resolveExistingChild(canonical, ".", "file")).rejects.toMatchObject({
        reason: "wrong-type",
      });
      expect(await resolveExistingChild(canonical, "internal.txt", "file")).toBe(
        join(canonical, "child", "inside.txt"),
      );
      expect(await resolveExistingChild(canonical, "child", "directory")).toBe(
        join(canonical, "child"),
      );
      await expect(resolveExistingChild(canonical, "../outside.txt", "file")).rejects.toMatchObject(
        {
          reason: "outside-root",
        },
      );
      await expect(resolveExistingChild(canonical, outside, "file")).rejects.toMatchObject({
        reason: "outside-root",
      });
      await expect(resolveExistingChild(canonical, "escape.txt", "file")).rejects.toMatchObject({
        reason: "outside-root",
      });
      await expect(resolveExistingChild(canonical, "child", "file")).rejects.toMatchObject({
        reason: "wrong-type",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
