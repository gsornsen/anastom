import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  conformanceReport,
  type ConformanceCase,
} from "../../../runtime-contract/src/testing/conformance.js";

/** A native-JSONL process double with no provider transport or actual authentication. */
export interface SyntheticCodex {
  root: string;
  executable: string;
  authDirectory: string;
  workspace: string;
  started: () => number;
  finalized: () => number;
  captured: () => Promise<
    Array<{ prompt: string; requiredOutputSchema: unknown; resourceId: string }>
  >;
  dispose: () => Promise<void>;
}

/** Build a fresh executable and fake file-backed store; provider credential bytes are synthetic. */
export async function syntheticCodex(
  scenario: ConformanceCase | "split" | "oversize" | "descendant" | "term-resistant",
): Promise<SyntheticCodex> {
  const root = await mkdtemp(join(tmpdir(), "anastom-codex-double-"));
  const executable = join(root, "codex-double.mjs");
  const authDirectory = join(root, "auth");
  const workspace = join(root, "workspace");
  await mkdir(authDirectory);
  await mkdir(workspace);
  await writeFile(
    join(authDirectory, "auth.json"),
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-no-network" }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "fixture.json"),
    JSON.stringify({
      scenario,
      report: scenario === "invalid" ? "{}" : JSON.stringify(conformanceReport),
    }),
    { mode: 0o600 },
  );
  const sources = dirname(fileURLToPath(import.meta.url));
  await copyFile(join(sources, "codex-double.mjs"), executable);
  await chmod(executable, 0o700);
  const entryNames = () => readdirSync(root).filter((name) => /^entry-\d+\.json$/.test(name));
  return {
    root,
    executable,
    authDirectory,
    workspace,
    started: () => entryNames().length,
    finalized: () =>
      entryNames().filter((name) => {
        const entry = JSON.parse(readFileSync(join(root, name), "utf8")) as { codexHome: string };
        return !existsSync(entry.codexHome);
      }).length,
    captured: async () =>
      Promise.all(
        (await readdir(root))
          .filter((name) => /^entry-\d+\.json$/.test(name))
          .sort()
          .map(async (name) => {
            const entry = JSON.parse(await readFile(join(root, name), "utf8")) as {
              prompt: string;
              requiredOutputSchema: unknown;
              codexHome: string;
            };
            return {
              prompt: entry.prompt,
              requiredOutputSchema: entry.requiredOutputSchema,
              resourceId: entry.codexHome,
            };
          }),
      ),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
