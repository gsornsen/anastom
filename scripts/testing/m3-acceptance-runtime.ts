import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../packages/core/src/index.js";
import {
  canonicalExistingRoot,
  ensurePrivatePathRoot,
  resolveExistingChild,
} from "../../packages/path-policy/src/index.js";
import {
  assertExecutionRequest,
  assertRuntimeDescriptor,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeEvent,
} from "../../packages/runtime-contract/src/index.js";

export type M3AcceptanceScenario = "clean" | "dirty" | "unknown";

interface FixtureExecution {
  request: ExecutionRequest;
  result: Promise<ExecutionResult>;
  settle?: (result: ExecutionResult) => void;
  keepAlive?: ReturnType<typeof setInterval>;
}

const CONFIGURATION_VERSION = "anastom.dev/runtime-m3-acceptance-config/v1alpha1";
const implementationSource = fileURLToPath(
  new URL("../../examples/fake/health-endpoint/server.mjs", import.meta.url),
);

/** Create the credential-free descriptor used only by the checked-in M3 acceptance fixture. */
export function m3AcceptanceDescriptor(scenario: M3AcceptanceScenario): RuntimeDescriptor {
  return {
    version: "anastom.dev/runtime-descriptor/v1alpha1",
    runtimeId: "m3-acceptance",
    configurationVersion: CONFIGURATION_VERSION,
    configuration: { scenario },
  };
}

/** Parse the exact internal acceptance descriptor without admitting production runtime flags. */
export function parseM3AcceptanceDescriptor(value: unknown): M3AcceptanceScenario {
  assertRuntimeDescriptor(value);
  const descriptor = value;
  if (
    descriptor.runtimeId !== "m3-acceptance" ||
    descriptor.configurationVersion !== CONFIGURATION_VERSION ||
    Object.keys(descriptor.configuration).join(",") !== "scenario" ||
    !["clean", "dirty", "unknown"].includes(descriptor.configuration.scenario as string)
  ) {
    throw new TypeError("Invalid M3 acceptance runtime descriptor");
  }
  return descriptor.configuration.scenario as M3AcceptanceScenario;
}

/** Deterministic internal adapter that holds attempt one and completes only a clean replacement. */
export class M3AcceptanceRuntimeAdapter implements RuntimeAdapter {
  readonly id = "m3-acceptance";
  private readonly executions = new Map<string, FixtureExecution>();

  constructor(
    private readonly scenario: M3AcceptanceScenario,
    private readonly probeRoot: string,
  ) {}

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
      sandboxing: ["isolated-fixture"],
      workspaceModes: ["isolated" as const],
    };
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    assertExecutionRequest(request);
    if (request.workspace.mode !== "isolated") {
      throw new Error("M3 acceptance runtime requires an isolated workspace");
    }
    const id = randomUUID();
    if (request.attempt === 1) {
      if (this.scenario === "dirty") {
        await installImplementation(request.workspace.path);
      }
      let settle!: (result: ExecutionResult) => void;
      const result = new Promise<ExecutionResult>((resolve) => {
        settle = resolve;
      });
      this.executions.set(id, {
        request,
        result,
        settle,
        keepAlive: setInterval(() => undefined, 1_000),
      });
      return { id };
    }
    if (request.attempt !== 2 || this.scenario !== "clean") {
      throw new Error("M3 acceptance runtime started an unauthorized replacement attempt");
    }
    await installImplementation(request.workspace.path);
    const result: ExecutionResult = {
      status: "succeeded",
      output: {
        summary: "Recovered with fresh context and implemented GET /health",
        changedFiles: ["server.mjs"],
        notes: [],
      },
    };
    this.executions.set(id, { request, result: Promise.resolve(result) });
    await this.publishProbe(request, "completed");
    return { id };
  }

  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const execution = this.requireExecution(handle);
    if (execution.request.attempt === 1) {
      await this.publishProbe(execution.request, "ready");
    }
    yield { type: "started" };
    yield {
      type: "metadata",
      provider: "fixture",
      model: "m3-acceptance",
      source: "configured",
    };
    const result = await execution.result;
    yield { type: "completed", status: result.status };
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return structuredClone(await this.requireExecution(handle).result);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const execution = this.requireExecution(handle);
    if (execution.keepAlive) {
      clearInterval(execution.keepAlive);
      execution.keepAlive = undefined;
    }
    execution.settle?.({ status: "cancelled", reason: "Acceptance fixture cleanup" });
    execution.settle = undefined;
    await this.publishProbe(execution.request, "cancelled");
    await execution.result;
  }

  private requireExecution(handle: ExecutionHandle): FixtureExecution {
    const execution = this.executions.get(handle.id);
    if (!execution) {
      throw new Error("Unknown M3 acceptance execution");
    }
    return execution;
  }

  private async publishProbe(
    request: ExecutionRequest,
    phase: "ready" | "completed" | "cancelled",
  ): Promise<void> {
    const root = await ensurePrivatePathRoot(this.probeRoot);
    await root.ensureDirectory([request.runId]);
    await root.writeFileAtomic(
      [request.runId, `attempt-${request.attempt}-${phase}.json`],
      Buffer.from(
        canonicalJson({
          version: "anastom.dev/m3-acceptance-probe/v1alpha1",
          runId: request.runId,
          attempt: request.attempt,
          phase,
          processId: process.pid,
        }),
      ),
      { maxBytes: 4_096 },
    );
  }
}

async function installImplementation(workspacePath: string): Promise<void> {
  const root = await canonicalExistingRoot(workspacePath);
  const target = await resolveExistingChild(root, "server.mjs", "file");
  await writeFile(target, await readFile(implementationSource));
}
