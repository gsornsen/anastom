import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { conformanceRequest, drainEvents } from "../../runtime-contract/src/testing/conformance.js";
import { ClaudeCodeRuntimeAdapter } from "./index.js";
import { syntheticClaudeCode, type SyntheticClaudeCode } from "./testing/fixture.js";

function adapter(fixture: SyntheticClaudeCode): ClaudeCodeRuntimeAdapter {
  return new ClaudeCodeRuntimeAdapter({
    provider: "anthropic",
    model: "claude-opus-4-8",
    authSource: "subscription",
    testing: { executable: fixture.executable, environment: { PATH: process.env.PATH } },
  });
}

async function descendantGone(root: string): Promise<boolean> {
  const pid = Number(await readFile(join(root, "child-pid"), "utf8"));
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

describe("owned Claude Code native process boundaries", () => {
  it("stops a surviving descendant before accepting a final report", async () => {
    const fixture = await syntheticClaudeCode("descendant");
    try {
      const runtime = adapter(fixture);
      const handle = await runtime.start(conformanceRequest(fixture.root));
      const result = await runtime.collect(handle);
      if (result.status !== "succeeded") {
        throw new Error("Descendant cleanup fixture failed: " + JSON.stringify(result));
      }
      expect(await descendantGone(fixture.root)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
  it("cancels a TERM-resistant leader and descendant, with one terminal outcome", async () => {
    const fixture = await syntheticClaudeCode("term-resistant");
    try {
      const runtime = adapter(fixture);
      const handle = await runtime.start(conformanceRequest(fixture.root));
      await vi.waitFor(() => expect(fixture.started()).toBe(1));
      await Promise.all([runtime.cancel(handle), runtime.cancel(handle)]);
      expect(await runtime.collect(handle)).toMatchObject({ status: "cancelled" });
      expect(
        (await drainEvents(runtime, handle)).filter((event) => event.type === "completed"),
      ).toEqual([{ type: "completed", status: "cancelled" }]);
      expect(await descendantGone(fixture.root)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
  it("cancels during native initialization before any result frame", async () => {
    const fixture = await syntheticClaudeCode("initializing");
    try {
      const runtime = adapter(fixture);
      const handle = await runtime.start(conformanceRequest(fixture.root));
      await vi.waitFor(() => expect(existsSync(join(fixture.root, "startup-pid"))).toBe(true));
      await runtime.cancel(handle);
      expect(await runtime.collect(handle)).toMatchObject({ status: "cancelled" });
      expect(await descendantGone(fixture.root)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
  it("blocks a descendant's late write before revealing native success", async () => {
    const fixture = await syntheticClaudeCode("late-write");
    try {
      const runtime = adapter(fixture);
      const handle = await runtime.start(conformanceRequest(fixture.root));
      expect(await runtime.collect(handle)).toMatchObject({ status: "succeeded" });
      expect(await descendantGone(fixture.root)).toBe(true);
      await new Promise<void>((done) => setTimeout(done, 850));
      expect(existsSync(join(fixture.root, "late-write-marker"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
  it("owns concurrent attempts with separate native process identities", async () => {
    const fixture = await syntheticClaudeCode("success");
    try {
      const runtime = adapter(fixture);
      const [first, second] = await Promise.all([
        runtime.start(conformanceRequest(fixture.root)),
        runtime.start(conformanceRequest(fixture.root, 2)),
      ]);
      expect(first.id).not.toBe(second.id);
      expect(await Promise.all([runtime.collect(first), runtime.collect(second)])).toMatchObject([
        { status: "succeeded" },
        { status: "succeeded" },
      ]);
      expect(fixture.started()).toBe(2);
      expect(fixture.finalized()).toBe(2);
    } finally {
      await fixture.dispose();
    }
  });
  it("accepts split frames and rejects oversized or incomplete native JSONL", async () => {
    for (const [scenario, category] of [
      ["split", "succeeded"],
      ["oversize", "schema-violation"],
      ["premature", "schema-violation"],
    ] as const) {
      const fixture = await syntheticClaudeCode(scenario);
      try {
        const runtime = adapter(fixture);
        const handle = await runtime.start(conformanceRequest(fixture.root));
        const result = await runtime.collect(handle);
        if (category === "succeeded") {
          expect(result.status).toBe("succeeded");
        } else {
          if (result.status !== "failed" || result.failure.category !== category) {
            throw new Error(`${scenario} classified incorrectly: ${JSON.stringify(result)}`);
          }
        }
        expect(JSON.stringify(await drainEvents(runtime, handle))).not.toContain(
          "PRIVATE_SENTINEL",
        );
      } finally {
        await fixture.dispose();
      }
    }
  });
  it.skipIf(process.platform !== "darwin")(
    "confirms cleanup when Darwin group-wide inspection returns EPERM",
    async () => {
      const fixture = await syntheticClaudeCode("term-resistant");
      const nativeKill = process.kill.bind(process);
      try {
        const runtime = adapter(fixture);
        const handle = await runtime.start(conformanceRequest(fixture.root));
        await vi.waitFor(() => expect(fixture.started()).toBe(1));
        const intercepted = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid < 0 && signal === 0) {
            throw Object.assign(new Error("synthetic group inspection denial"), { code: "EPERM" });
          }
          return nativeKill(pid, signal);
        });
        try {
          await runtime.cancel(handle);
          expect(await runtime.collect(handle)).toMatchObject({ status: "cancelled" });
          expect(await descendantGone(fixture.root)).toBe(true);
        } finally {
          intercepted.mockRestore();
        }
      } finally {
        await fixture.dispose();
      }
    },
  );
});
