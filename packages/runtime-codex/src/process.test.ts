import { describe, expect, it, vi } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { conformanceRequest, drainEvents } from "../../runtime-contract/src/testing/conformance.js";
import { CodexRuntimeAdapter } from "./index.js";
import { syntheticCodex } from "./testing/fixture.js";

function adapter(executable: string, authDirectory: string): CodexRuntimeAdapter {
  return new CodexRuntimeAdapter({
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    executable,
    authDirectory,
  });
}

async function descendantGone(root: string, requireSpawn = false): Promise<boolean> {
  let pid: number;
  try {
    pid = Number(await readFile(join(root, "child-pid"), "utf8"));
  } catch (error) {
    if (!requireSpawn && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
    throw error;
  }
}

describe("owned Codex process boundaries", () => {
  it.each([
    ["managed-requirements", "policy-violation"],
    ["managed-config", "policy-violation"],
    ["policy-unavailable", "runtime-unavailable"],
  ] as const)("rejects %s before starting the model execution", async (scenario, category) => {
    const fixture = await syntheticCodex(scenario);
    try {
      const runtime = adapter(fixture.executable, fixture.authDirectory);
      await expect(runtime.start(conformanceRequest(fixture.workspace))).rejects.toMatchObject({
        category,
      });
      expect(fixture.started()).toBe(0);
      const policyFiles = (await readdir(fixture.root)).filter((name) =>
        /^policy-\d+\.json$/.test(name),
      );
      expect(policyFiles).toHaveLength(1);
      const policy = JSON.parse(await readFile(join(fixture.root, policyFiles[0]!), "utf8")) as {
        codexHome: string;
      };
      await expect(stat(policy.codexHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.dispose();
    }
  });
  it("classifies a policy-reader launch failure before model execution", async () => {
    const fixture = await syntheticCodex("success");
    try {
      const runtime = adapter(join(fixture.root, "missing-native"), fixture.authDirectory);
      await expect(runtime.start(conformanceRequest(fixture.workspace))).rejects.toMatchObject({
        category: "runtime-unavailable",
      });
      expect(fixture.started()).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });
  it("accepts split native frames without retaining private bodies", async () => {
    const split = await syntheticCodex("split");
    try {
      const runtime = adapter(split.executable, split.authDirectory);
      const handle = await runtime.start(conformanceRequest(split.workspace));
      const observed = await drainEvents(runtime, handle);
      expect(await runtime.collect(handle)).toMatchObject({ status: "succeeded" });
      expect(JSON.stringify(observed)).not.toContain("PRIVATE_SENTINEL");
    } finally {
      await split.dispose();
    }
  });
  it.each([1, 2, 3, 4, 5])(
    "rejects an oversized native frame after confirmed cleanup (sample %i)",
    async () => {
      const oversized = await syntheticCodex("oversize");
      try {
        const runtime = adapter(oversized.executable, oversized.authDirectory);
        const handle = await runtime.start(conformanceRequest(oversized.workspace));
        const result = await runtime.collect(handle);
        if (result.status !== "failed" || result.failure.category !== "schema-violation") {
          throw new Error("Oversized frame fixture failed: " + JSON.stringify(result));
        }
      } finally {
        await oversized.dispose();
      }
    },
  );
  it("cancels a TERM-resistant process once and closes the terminal stream", async () => {
    const fixture = await syntheticCodex("term-resistant");
    try {
      const runtime = adapter(fixture.executable, fixture.authDirectory);
      const handle = await runtime.start(conformanceRequest(fixture.workspace));
      await Promise.all([runtime.cancel(handle), runtime.cancel(handle)]);
      expect((await runtime.collect(handle)).status).toBe("cancelled");
      expect((await drainEvents(runtime, handle)).at(-1)).toEqual({
        type: "completed",
        status: "cancelled",
      });
      expect(await descendantGone(fixture.root)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
  it.skipIf(process.platform !== "darwin")(
    "confirms descendant cleanup when Darwin group-wide kill(0) denies inspection",
    async () => {
      const fixture = await syntheticCodex("term-resistant");
      const nativeKill = process.kill.bind(process);
      try {
        const runtime = adapter(fixture.executable, fixture.authDirectory);
        const handle = await runtime.start(conformanceRequest(fixture.workspace));
        const intercepted = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid < 0 && signal === 0) {
            throw Object.assign(new Error("synthetic group inspection denial"), {
              code: "EPERM",
            });
          }
          return nativeKill(pid, signal);
        });
        try {
          await runtime.cancel(handle);
          expect((await runtime.collect(handle)).status).toBe("cancelled");
          expect(await descendantGone(fixture.root)).toBe(true);
        } finally {
          intercepted.mockRestore();
        }
      } finally {
        await fixture.dispose();
      }
    },
  );
  it("stops a surviving descendant before accepting the final report", async () => {
    const fixture = await syntheticCodex("descendant");
    try {
      const runtime = adapter(fixture.executable, fixture.authDirectory);
      const handle = await runtime.start(conformanceRequest(fixture.workspace));
      const result = await runtime.collect(handle);
      if (result.status !== "succeeded") {
        throw new Error("Descendant cleanup fixture failed: " + JSON.stringify(result));
      }
      expect(await descendantGone(fixture.root, true)).toBe(true);
      await runtime.cancel(handle);
      expect(await runtime.collect(handle)).toMatchObject({ status: "succeeded" });
    } finally {
      await fixture.dispose();
    }
  });
});
