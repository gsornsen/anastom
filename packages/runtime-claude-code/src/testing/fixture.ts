import { chmod, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  conformanceReport,
  type ConformanceCase,
} from "../../../runtime-contract/src/testing/conformance.js";

export type ClaudeDoubleScenario =
  | ConformanceCase
  | "split"
  | "oversize"
  | "premature"
  | "descendant"
  | "term-resistant"
  | "late-write"
  | "initializing"
  | "auth-wrong";

/** A local native-process double that never connects to a provider or reads auth. */
export interface SyntheticClaudeCode {
  root: string;
  executable: string;
  started: () => number;
  finalized: () => number;
  captured: () => Promise<
    Array<{ prompt: string; requiredOutputSchema: unknown; resourceId: string }>
  >;
  dispose: () => Promise<void>;
}

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "darwin") {
      try {
        const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
          timeout: 1_000,
          encoding: "utf8",
        }).trim();
        return state === "" || ["Z", "X"].includes(state[0]!);
      } catch {
        return false;
      }
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
    throw error;
  }
}

/** Copy a committed .mjs process double; never create executable inline code strings. */
export async function syntheticClaudeCode(
  scenario: ClaudeDoubleScenario,
): Promise<SyntheticClaudeCode> {
  const root = await mkdtemp(join(tmpdir(), "anastom-claude-double-"));
  const executable = join(root, "claude-double.mjs");
  const sources = dirname(fileURLToPath(import.meta.url));
  await copyFile(join(sources, "claude-double.mjs"), executable);
  await copyFile(join(sources, "late-write-child.mjs"), join(root, "late-write-child.mjs"));
  await chmod(executable, 0o700);
  await writeFile(
    join(root, "fixture.json"),
    JSON.stringify({
      scenario,
      report: scenario === "invalid" ? {} : conformanceReport,
    }),
    { mode: 0o600 },
  );
  const entries = () => readdirSync(root).filter((name) => /^entry-\d+\.json$/.test(name));
  return {
    root,
    executable,
    started: () => entries().length,
    finalized: () => entries().filter((name) => exited(Number(name.slice(6, -5)))).length,
    captured: async () =>
      Promise.all(
        (await readdir(root))
          .filter((name) => /^entry-\d+\.json$/.test(name))
          .sort()
          .map(async (name) => {
            const entry = JSON.parse(await readFile(join(root, name), "utf8")) as {
              prompt: string;
              requiredOutputSchema: unknown;
              resourceId: string;
            };
            return {
              prompt: entry.prompt,
              requiredOutputSchema: entry.requiredOutputSchema,
              resourceId: entry.resourceId,
            };
          }),
      ),
    dispose: async () => {
      for (const name of entries()) {
        const entry = JSON.parse(readFileSync(join(root, name), "utf8")) as { resourceId: string };
        if (!exited(Number(entry.resourceId))) {
          throw new Error("Synthetic Claude Code process is still running");
        }
      }
      if (existsSync(join(root, "child-pid"))) {
        const pid = Number(readFileSync(join(root, "child-pid"), "utf8"));
        if (!exited(pid)) {
          throw new Error("Synthetic Claude Code descendant is still running");
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
