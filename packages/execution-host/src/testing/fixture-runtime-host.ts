import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { canonicalJson } from "@anastom/core";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
import {
  assertExecutionRequest,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeEvent,
} from "@anastom/runtime-contract";

import { runExecutionRuntimeHost } from "../runtime-host.js";

type FixtureOwner = "pi" | "codex" | "claude-code";
type FixtureScenario = "success" | "hold" | "pressure";

interface FixtureExecution {
  child: ChildProcess;
  descendant?: number;
  cancelled: boolean;
  result: Promise<ExecutionResult>;
}

function signal(pid: number | undefined, value: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

class FixtureRuntimeAdapter implements RuntimeAdapter {
  readonly id: FixtureOwner;
  private readonly executions = new Map<string, FixtureExecution>();

  constructor(
    owner: FixtureOwner,
    private readonly scenario: FixtureScenario,
  ) {
    this.id = owner;
  }

  async capabilities() {
    return {
      streaming: true,
      cancellation: true,
      resumableSession: false,
      nativeSubagents: false,
      mcp: false,
      lsp: false,
      debugger: false,
      browser: false,
      structuredOutput: "native" as const,
      usageReporting: "none" as const,
      sandboxing: [],
      workspaceModes: ["readonly" as const, "isolated" as const],
    };
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    assertExecutionRequest(request);
    if (request.workspace.mode === "memory") {
      throw new Error("Fixture runtime requires a filesystem workspace");
    }
    const id = randomUUID();
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("fixture-worker.mjs", import.meta.url)), this.scenario, this.id],
      {
        cwd: request.workspace.path,
        detached: false,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const execution: FixtureExecution = {
      child,
      cancelled: false,
      result: Promise.resolve({
        status: "failed",
        failure: { category: "unknown-internal", message: "Fixture initialization failed" },
      }),
    };
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split("\n")[0];
      if (line) {
        const parsed = JSON.parse(line) as { descendant: number | null };
        execution.descendant = parsed.descendant ?? undefined;
      }
    });
    execution.result = new Promise<ExecutionResult>((resolve) => {
      let startFailed = false;
      child.once("error", () => {
        startFailed = true;
      });
      child.once("close", (code) => {
        if (execution.cancelled) {
          resolve({ status: "cancelled", reason: "Fixture execution cancelled" });
        } else if (!startFailed && code === 0) {
          resolve({
            status: "succeeded",
            output: {
              summary: "Fixture execution completed",
              changedFiles: ["side-effect.json"],
              notes: [],
            },
          });
        } else {
          resolve({
            status: "failed",
            failure: { category: "tool", message: "Fixture execution failed" },
          });
        }
      });
    });
    this.executions.set(id, execution);
    return { id };
  }

  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const execution = this.lookup(handle);
    yield { type: "started" };
    yield { type: "metadata", provider: "fixture", model: this.id, source: "configured" };
    if (this.scenario === "pressure") {
      for (let index = 0; index < 2_048; index += 1) {
        yield { type: "log", message: `bounded fixture log ${index}` };
      }
    }
    const result = await execution.result;
    yield { type: "completed", status: result.status };
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return structuredClone(await this.lookup(handle).result);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const execution = this.lookup(handle);
    execution.cancelled = true;
    const deadline = Date.now() + 1_000;
    while (
      execution.descendant === undefined &&
      execution.child.exitCode === null &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    signal(execution.descendant, "SIGKILL");
    signal(execution.child.pid, "SIGKILL");
    await execution.result;
  }

  private lookup(handle: ExecutionHandle): FixtureExecution {
    const execution = this.executions.get(handle.id);
    if (!execution) {
      throw new Error(`Unknown fixture execution ${handle.id}`);
    }
    return execution;
  }
}

function parseFixtureDescriptor(descriptor: RuntimeDescriptor): {
  owner: FixtureOwner;
  scenario: FixtureScenario;
} {
  const owner = descriptor.runtimeId;
  const configuration = descriptor.configuration;
  if (
    descriptor.version !== "anastom.dev/runtime-descriptor/v1alpha1" ||
    !["pi", "codex", "claude-code"].includes(owner) ||
    descriptor.configurationVersion !== "fixture-v1" ||
    Object.keys(configuration).sort().join(",") !== "scenario" ||
    !["success", "hold", "pressure"].includes(configuration.scenario as string)
  ) {
    throw new TypeError("Invalid fixture runtime descriptor");
  }
  return { owner: owner as FixtureOwner, scenario: configuration.scenario as FixtureScenario };
}

if (process.argv[2] === "start-gated") {
  const probeRoot = process.argv[3];
  if (!probeRoot) {
    throw new Error("Start-gated fixture runtime host requires a probe root");
  }
  const root = await ensurePrivatePathRoot(probeRoot);
  const record = Buffer.from(canonicalJson({ pid: process.pid }));
  await root.writeFileAtomic(["runtime-host.json"], record, { maxBytes: 4 * 1024 });
  await new Promise<void>(() => {});
} else {
  await runExecutionRuntimeHost(async (descriptor) => {
    const fixture = parseFixtureDescriptor(descriptor);
    return new FixtureRuntimeAdapter(fixture.owner, fixture.scenario);
  });
}
