import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureRepo, removeFixture, taskPath, fakePath } from "../../engine/src/testing/fixture.js";
import { runCli } from "./index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const bin = resolve("packages/cli/src/bin.ts");
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });
function capture() { const stdout: string[] = [], stderr: string[] = []; return { stdout, stderr, io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) } }; }
async function cli(args: string[], cwd: string) {
  return (await exec(process.execPath, ["--import", import.meta.resolve("tsx"), bin, ...args], { cwd, maxBuffer: 2_097_152 })).stdout;
}
describe("durable M1 CLI", () => {
  it("executes a deterministic worker on a fixture and inspects it in later processes", async () => {
    const root = await fixtureRepo(); roots.push(root);
    const original = await readFile(join(root, "server.mjs"), "utf8");
    const result = await cli(["run", taskPath, "--runtime", "fake", "--fake-scenario", fakePath, "--repo", root], process.cwd());
    const runId = /^Run ([^ ]+)/.exec(result)?.[1]; expect(runId).toBeDefined();
    expect(result).toContain("[succeeded]");
    expect(result).toContain("exit=0");
    expect(await readFile(join(root, "server.mjs"), "utf8")).toBe(original);
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("");
    const stateDir = join(root, ".anastom");
    const status = await cli(["status", runId!, "--state-dir", stateDir], process.cwd());
    expect(status).toContain("[succeeded]");
    const inspect = await cli(["inspect", runId!, "--json", "--state-dir", stateDir], process.cwd());
    const data = JSON.parse(inspect) as { definitionDigest: string; state: { status: string; workspace: { path: string }; artifacts: { type: string; uri: string; digest: string }[] }; events: { sequence: number }[] };
    expect(data.state.status).toBe("succeeded");
    expect(data.definitionDigest).toMatch(/^sha256:/);
    expect(data.events.map((event) => event.sequence)).toEqual(data.events.map((_, index) => index + 1));
    const diff = data.state.artifacts.find((artifact) => artifact.type === "diff")!;
    expect(await readFile(diff.uri, "utf8")).toContain("/health");
    expect(await cli(["status", runId!], root)).toContain("[succeeded]");
  });
  it("retains run IDs, failed verifier output, and the workspace on failure", async () => {
    const root = await fixtureRepo(); roots.push(root);
    const stateDir = join(root, ".anastom"); await mkdir(stateDir);
    const scenario = join(stateDir, "no-change.yaml");
    await writeFile(scenario, 'nodes:\n  implement:\n    - output: {summary: "No changes", changedFiles: [], notes: []}\n');
    const output = capture();
    expect(await runCli(["run", taskPath, "--runtime", "fake", "--fake-scenario", scenario, "--repo", root], { io: output.io })).toBe(1);
    expect(output.stdout[0]).toMatch(/^Run .* created/);
    expect(output.stdout[1]).toContain("[failed]");
    const runId = /^Run ([^ ]+)/.exec(output.stdout[0]!)![1]!;
    const inspection = JSON.parse(await cli(["inspect", runId, "--json", "--state-dir", stateDir], root)) as { state: { nodes: { verify: { command: { exitCode: number } } }; workspace: { path: string }; artifacts: { type: string; uri: string }[] } };
    expect(inspection.state.nodes.verify.command.exitCode).toBe(1);
    const stdout = inspection.state.artifacts.find((artifact) => artifact.type === "stdout")!;
    expect(await readFile(stdout.uri, "utf8")).toContain("GET /health");
    expect(await readFile(join(inspection.state.workspace.path, "server.mjs"), "utf8")).toContain("404");
    const missing = capture();
    expect(await runCli(["status", "does-not-exist", "--state-dir", join(root, ".anastom")], { io: missing.io })).toBe(1);
    expect(missing.stderr.join("\n")).toContain("not found");
  });
  it("rejects ambiguous runtime, arbitrary flags, and missing fake scenarios", async () => {
    for (const args of [[], ["--runtime", "fake"], ["--runtime", "pi", "--fake-scenario", fakePath], ["--runtime", "codex"], ["--runtime", "pi", "--unknown", "x"]]) {
      const output = capture(); expect(await runCli(["run", taskPath, ...args], { io: output.io })).toBe(1); expect(output.stderr.length).toBeGreaterThan(0);
    }
  });
});
