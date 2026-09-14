/**
 * End-to-end contract: the fixture starts with a failing GET /health test.
 * A scripted worker fixes it in an isolated worktree; a separate verifier runs
 * the fixture tests. Later CLI processes must recover status and evidence from
 * SQLite while the original source repository stays unchanged.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRef } from "@anastom/runtime-contract";
import {
  createEndpointRepository,
  removeEndpointRepository,
  healthEndpointTaskPath,
  healthEndpointScenarioPath,
} from "../../engine/src/testing/fixture.js";
import { runCli, type DurableRunInspection } from "./index.js";

const execute = promisify(execFile);
const repositories: string[] = [];
const cliEntrypoint = resolve("packages/cli/src/bin.ts");

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await removeEndpointRepository(repository);
  }
});

async function newEndpointRepository(): Promise<string> {
  const repository = await createEndpointRepository();
  repositories.push(repository);
  return repository;
}

function captureCliOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (text: string) => {
      stdout.push(text);
    },
    stderr: (text: string) => {
      stderr.push(text);
    },
  };
  return { stdout, stderr, io };
}

/** Start the real CLI in a fresh process so in-memory state cannot satisfy the test. */
async function runCliInNewProcess(args: string[], cwd = process.cwd()): Promise<string> {
  const result = await execute(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), cliEntrypoint, ...args],
    { cwd, maxBuffer: 2_097_152 },
  );
  return result.stdout;
}

function createdRunId(output: string): string {
  const id = /^Run ([^ ]+) created/m.exec(output)?.[1];
  if (!id) {
    throw new Error("Expected CLI output to identify the created run: " + output);
  }
  return id;
}

async function inspectInNewProcess(
  runId: string,
  repository: string,
): Promise<DurableRunInspection> {
  const text = await runCliInNewProcess([
    "inspect",
    runId,
    "--json",
    "--state-dir",
    join(repository, ".anastom"),
  ]);
  return JSON.parse(text) as DurableRunInspection;
}

function evidence(inspection: DurableRunInspection, type: string): ArtifactRef {
  const artifact = inspection.state.artifacts?.find((item) => item.type === type);
  if (!artifact) {
    throw new Error("Expected retained " + type + " evidence");
  }
  return artifact;
}

function fakeTaskArguments(repository: string, scenario = healthEndpointScenarioPath): string[] {
  return [
    "run",
    healthEndpointTaskPath,
    "--runtime",
    "fake",
    "--fake-scenario",
    scenario,
    "--repo",
    repository,
  ];
}

describe("Durable task execution", () => {
  it("runs the scripted endpoint fix and verifier successfully", async () => {
    const repository = await newEndpointRepository();

    const output = await runCliInNewProcess(fakeTaskArguments(repository));

    expect(output).toContain("[succeeded]");
    expect(output).toContain("Verification: passed=true exit=0");
  });

  it("keeps the source repository unchanged while retaining the worktree diff", async () => {
    const repository = await newEndpointRepository();
    const originalServer = await readFile(join(repository, "server.mjs"), "utf8");

    const output = await runCliInNewProcess(fakeTaskArguments(repository));
    const inspection = await inspectInNewProcess(createdRunId(output), repository);

    expect(await readFile(join(repository, "server.mjs"), "utf8")).toBe(originalServer);
    const status = await execute("git", ["status", "--porcelain"], { cwd: repository });
    expect(status.stdout).toBe("");
    const diff = evidence(inspection, "diff");
    expect(await readFile(diff.uri, "utf8")).toContain("/health");
  });

  it("recovers status, definition digest, and ordered events in later processes", async () => {
    const repository = await newEndpointRepository();
    const output = await runCliInNewProcess(fakeTaskArguments(repository));
    const runId = createdRunId(output);

    const status = await runCliInNewProcess([
      "status",
      runId,
      "--state-dir",
      join(repository, ".anastom"),
    ]);
    const inspection = await inspectInNewProcess(runId, repository);

    expect(status).toContain("[succeeded]");
    expect(inspection.state.status).toBe("succeeded");
    expect(inspection.definitionDigest).toMatch(/^sha256:/);
    expect(inspection.events.map((event) => event.sequence)).toEqual(
      inspection.events.map((_, index) => index + 1),
    );
    expect(await runCliInNewProcess(["status", runId], repository)).toContain("[succeeded]");
  });

  it("retains the failed verifier's output and workspace when the worker makes no changes", async () => {
    const repository = await newEndpointRepository();
    const stateDirectory = join(repository, ".anastom");
    await mkdir(stateDirectory);
    const scenario = join(stateDirectory, "no-change.yaml");
    await writeFile(
      scenario,
      [
        "nodes:",
        "  implement:",
        "    - output:",
        "        summary: Inspected the endpoint request but intentionally left the server unchanged.",
        "        changedFiles: []",
        "        notes: []",
        "",
      ].join("\n"),
    );
    const output = captureCliOutput();

    const exitCode = await runCli(fakeTaskArguments(repository, scenario), { io: output.io });
    const inspection = await inspectInNewProcess(
      createdRunId(output.stdout.join("\n")),
      repository,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout.join("\n")).toContain("[failed]");
    expect(inspection.state.nodes.verify?.command?.exitCode).toBe(1);
    const verifierOutput = evidence(inspection, "stdout");
    expect(await readFile(verifierOutput.uri, "utf8")).toContain("GET /health");
    const workspace = inspection.state.workspace;
    if (!workspace || workspace.mode !== "isolated") {
      throw new Error("Expected a retained worktree");
    }
    expect(await readFile(join(workspace.path, "server.mjs"), "utf8")).toContain("404");
  });

  it("reports a missing run without inventing state", async () => {
    const repository = await newEndpointRepository();
    await runCliInNewProcess(fakeTaskArguments(repository));
    const output = captureCliOutput();

    const exitCode = await runCli(
      ["status", "does-not-exist", "--state-dir", join(repository, ".anastom")],
      { io: output.io },
    );

    expect(exitCode).toBe(1);
    expect(output.stderr.join("\n")).toContain("not found");
  });

  it.each([
    ["missing runtime", []],
    ["missing fake scenario", ["--runtime", "fake"]],
    ["fake scenario with Pi", ["--runtime", "pi", "--fake-scenario", healthEndpointScenarioPath]],
    ["unknown runtime", ["--runtime", "codex"]],
    ["unknown flag", ["--runtime", "pi", "--unknown", "x"]],
  ])("rejects %s before execution", async (_reason, args) => {
    const output = captureCliOutput();
    const exitCode = await runCli(["run", healthEndpointTaskPath, ...args], { io: output.io });
    expect(exitCode).toBe(1);
    expect(output.stderr.length).toBeGreaterThan(0);
  });
});
