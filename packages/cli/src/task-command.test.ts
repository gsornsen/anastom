import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEndpointRepository,
  healthEndpointTaskPath,
  removeEndpointRepository,
} from "../../engine/src/testing/fixture.js";
import { runCli } from "./index.js";

const repositories: string[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await removeEndpointRepository(repository);
  }
});

function captureCliOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe("Task command validation", () => {
  it("keeps operator-selected Task reads under the CLI's current source directory", async () => {
    const repository = await createEndpointRepository();
    repositories.push(repository);
    const output = captureCliOutput();

    expect(
      await runCli(["validate", join(repository, "tasks", "add-endpoint.md")], { io: output.io }),
    ).toBe(1);
    expect(output.stderr.join("\n")).toContain("escapes its trusted root");
  });

  it.each([
    ["missing runtime", []],
    ["removed fake runtime", ["--runtime", "fake"]],
    ["removed fake scenario option", ["--runtime", "pi", "--fake-scenario", "scenario.yaml"]],
    ["Codex without explicit model", ["--runtime", "codex"]],
    ["unknown runtime", ["--runtime", "unregistered"]],
    [
      "Codex with unsupported provider",
      ["--runtime", "codex", "--provider", "other", "--model", "fixture"],
    ],
    ["Codex with incomplete selection", ["--runtime", "codex", "--provider", "openai"]],
    [
      "Claude Code without auth source",
      ["--runtime", "claude-code", "--provider", "anthropic", "--model", "claude-opus-4-8"],
    ],
    [
      "Claude Code with invalid auth source",
      [
        "--runtime",
        "claude-code",
        "--provider",
        "anthropic",
        "--model",
        "claude-opus-4-8",
        "--auth-source",
        "automatic",
      ],
    ],
    [
      "Claude Code with unsupported provider",
      [
        "--runtime",
        "claude-code",
        "--provider",
        "other",
        "--model",
        "claude-opus-4-8",
        "--auth-source",
        "subscription",
      ],
    ],
    ["Pi with Claude auth source", ["--runtime", "pi", "--auth-source", "subscription"]],
    ["unknown flag", ["--runtime", "pi", "--unknown", "x"]],
  ])("rejects %s before execution", async (_reason, args) => {
    const output = captureCliOutput();
    const exitCode = await runCli(["run", healthEndpointTaskPath, ...args], { io: output.io });
    expect(exitCode).toBe(2);
    expect(output.stderr.length).toBeGreaterThan(0);
  });
});
