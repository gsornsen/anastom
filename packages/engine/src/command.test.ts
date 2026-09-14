import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "@anastom/core";
import type { WorkspaceRef } from "@anastom/runtime-contract";
import { LocalCommandExecutor } from "./command.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function workspace(): Promise<WorkspaceRef> {
  const path = await mkdtemp(join(tmpdir(), "anastom-command-"));
  roots.push(path);
  return { id: "command", mode: "readonly", path, repoRoot: path, baseCommit: "fixture" };
}
function command(script: string, extra: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    argv: [process.execPath, "-e", script],
    cwd: ".",
    maxDurationMs: 2000,
    maxOutputBytes: 4096,
    ...extra,
  };
}
describe("control-plane commands", () => {
  it("passes exact arguments without a shell and omits provider credentials", async () => {
    vi.stubEnv("ANASTOM_TEST_SECRET", "fixture-secret");
    const run = await new LocalCommandExecutor().execute(
      command(
        "process.stdout.write(process.argv[1]); process.stderr.write(String(process.env.ANASTOM_TEST_SECRET))",
        {
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(process.argv[1]); process.stderr.write(String(process.env.ANASTOM_TEST_SECRET))",
            "$HOME; echo surprise",
          ],
        },
      ),
      await workspace(),
    );
    expect(run.output.passed).toBe(true);
    expect(run.stdout.toString()).toBe("$HOME; echo surprise");
    expect(run.stderr.toString()).toBe("undefined");
    expect(run.output.exitCode).toBe(0);
  });
  it("preserves output and reports a nonzero exit or unavailable executable", async () => {
    const target = await workspace();
    const executor = new LocalCommandExecutor();
    const result = await executor.execute(
      command("console.log('evidence'); console.error('failure'); process.exit(7)"),
      target,
    );
    expect(result.failure?.category).toBe("tool");
    expect(result.output.exitCode).toBe(7);
    expect(result.stdout.toString()).toContain("evidence");
    expect(result.stderr.toString()).toContain("failure");
    expect(
      (await executor.execute(command("", { argv: ["anastom-nonexistent-executable"] }), target))
        .failure?.category,
    ).toBe("tool");
  });
  it("drains excess output while bounding retained bytes per stream", async () => {
    const result = await new LocalCommandExecutor().execute(
      command("process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(50000))"),
      await workspace(),
    );
    expect(result.output).toMatchObject({
      passed: true,
      stdoutBytes: 100000,
      stderrBytes: 50000,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(result.stdout.length).toBe(4096);
    expect(result.stderr.length).toBe(4096);
  });
  it("terminates a process that ignores SIGTERM after a bounded grace", async () => {
    const target = await workspace();
    if (target.mode === "memory") {
      throw new Error("Expected filesystem fixture");
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ready = join(target.path, "ready");
    const running = new LocalCommandExecutor(20).execute(
      command(
        "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(" +
          JSON.stringify(ready) +
          ", 'ready'); setInterval(() => {}, 1000)",
        { maxDurationMs: 1_000_000 },
      ),
      target,
    );
    await vi.waitFor(async () => {
      expect(await readFile(ready, "utf8")).toBe("ready");
    });
    await vi.advanceTimersByTimeAsync(1_000_020);
    const result = await running;
    expect(result.failure?.category).toBe("budget-exhausted");
    expect(result.output.passed).toBe(false);
    expect(result.output.signal).toBe("SIGKILL");
  });
  it("rejects lexical and symlink cwd escapes, empty argv, and invalid limits", async () => {
    const target = await workspace();
    if (target.mode === "memory") {
      throw new Error("Expected filesystem fixture");
    }
    await symlink(tmpdir(), join(target.path, "escape"), "dir");
    const executor = new LocalCommandExecutor();
    for (const cwd of ["..", "/", "escape"]) {
      await expect(executor.execute(command("void 0", { cwd }), target)).rejects.toThrow();
    }
    await expect(executor.execute(command("", { argv: [] }), target)).rejects.toThrow("argument");
    await expect(executor.execute(command("void 0", { maxDurationMs: 0 }), target)).rejects.toThrow(
      "limits",
    );
  });
});
