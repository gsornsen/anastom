import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../packages/core/src/index.js";
import { ensurePrivatePathRoot } from "../../packages/path-policy/src/index.js";
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

export type DefinedSdlcAcceptanceScenario =
  | "left-first"
  | "right-first"
  | "hold-workers"
  | "worker-failure"
  | "review-rejection"
  | "verifier-failure"
  | "integration-crash";

interface FixtureExecution {
  request: ExecutionRequest;
  result: Promise<ExecutionResult>;
  settle?: (result: ExecutionResult) => void;
}

const CONFIGURATION_VERSION = "anastom.dev/runtime-defined-sdlc-acceptance-config/v1alpha1";
const scenarios: readonly DefinedSdlcAcceptanceScenario[] = [
  "left-first",
  "right-first",
  "hold-workers",
  "worker-failure",
  "review-rejection",
  "verifier-failure",
  "integration-crash",
];

/** Build the credential-free descriptor used only by the checked-in acceptance fixture. */
export function definedSdlcAcceptanceDescriptor(
  scenario: DefinedSdlcAcceptanceScenario,
): RuntimeDescriptor {
  return {
    version: "anastom.dev/runtime-descriptor/v1alpha1",
    runtimeId: "defined-sdlc-acceptance",
    configurationVersion: CONFIGURATION_VERSION,
    configuration: { scenario },
  };
}

/** Parse the exact acceptance descriptor without adding a supported CLI runtime. */
export function parseDefinedSdlcAcceptanceDescriptor(
  value: unknown,
): DefinedSdlcAcceptanceScenario {
  assertRuntimeDescriptor(value);
  if (
    value.runtimeId !== "defined-sdlc-acceptance" ||
    value.configurationVersion !== CONFIGURATION_VERSION ||
    Object.keys(value.configuration).join(",") !== "scenario" ||
    !scenarios.includes(value.configuration.scenario as DefinedSdlcAcceptanceScenario)
  ) {
    throw new TypeError("Invalid defined-SDLC acceptance runtime descriptor");
  }
  return value.configuration.scenario as DefinedSdlcAcceptanceScenario;
}

/** Deterministic process fixture for analysis, planning, concurrent work, integration, and review. */
export class DefinedSdlcAcceptanceRuntimeAdapter implements RuntimeAdapter {
  readonly id = "defined-sdlc-acceptance";
  private readonly executions = new Map<string, FixtureExecution>();

  constructor(
    private readonly scenario: DefinedSdlcAcceptanceScenario,
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
      throw new Error("Defined-SDLC acceptance requires an isolated workspace");
    }
    const id = randomUUID();
    await this.publishProbe(request, "started");
    const execution = this.createExecution(request);
    this.executions.set(id, execution);
    return { id };
  }

  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const execution = this.requireExecution(handle);
    yield { type: "started" };
    yield {
      type: "metadata",
      provider: "fixture",
      model: "defined-sdlc-acceptance",
      source: "configured",
    };
    const result = await execution.result;
    yield { type: "completed", status: result.status };
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const execution = this.requireExecution(handle);
    const result = await execution.result;
    await this.publishProbe(execution.request, "completed");
    return structuredClone(result);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const execution = this.requireExecution(handle);
    execution.settle?.({ status: "cancelled", reason: "Acceptance fixture control" });
    execution.settle = undefined;
    await execution.result;
    await this.publishProbe(execution.request, "cancelled");
  }

  private createExecution(request: ExecutionRequest): FixtureExecution {
    if (this.shouldHold(request)) {
      let settle!: (result: ExecutionResult) => void;
      const keepAlive = setInterval(() => undefined, 1_000);
      const result = new Promise<ExecutionResult>((resolve) => {
        settle = (value) => {
          clearInterval(keepAlive);
          resolve(value);
        };
      });
      return { request, result, settle };
    }
    return { request, result: this.executeNode(request) };
  }

  private shouldHold(request: ExecutionRequest): boolean {
    return (
      request.nodeId.startsWith("implement.") &&
      (this.scenario === "hold-workers" ||
        (this.scenario === "worker-failure" && request.nodeId === "implement.right"))
    );
  }

  private delay(request: ExecutionRequest): number {
    if (request.nodeId === "implement.left") {
      return this.scenario === "right-first" ? 250 : 50;
    }
    if (request.nodeId === "implement.right") {
      return this.scenario === "right-first" ? 50 : 250;
    }
    return request.nodeId.startsWith("review.") ? 100 : 5;
  }

  private async executeNode(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.workspace.mode !== "isolated") {
      throw new Error("Acceptance execution lost its isolated workspace");
    }
    const workspacePath = request.workspace.path;
    if (request.nodeId.startsWith("implement.")) {
      await this.waitForSiblingStart(request);
      await new Promise<void>((resolve) => setTimeout(resolve, this.delay(request)));
    } else if (request.nodeId.startsWith("review.")) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delay(request)));
    }
    if (request.nodeId === "analysis") {
      return {
        status: "succeeded",
        output: {
          summary: "The fixture has two independent files and one protected acceptance program.",
          boundaries: ["left.txt", "right.txt"],
          risks: [],
        },
      };
    }
    if (request.nodeId === "planning") {
      return { status: "succeeded", output: featurePlan() };
    }
    if (request.nodeId === "implement.left") {
      if (this.scenario === "worker-failure") {
        return {
          status: "failed",
          failure: { category: "tool", message: "Intentional left worker failure" },
        };
      }
      await writeFile(join(workspacePath, "left.txt"), "left implementation\n");
      return workerReport(["left.txt"], "Implemented the complete independent left-side behavior.");
    }
    if (request.nodeId === "implement.right") {
      await writeFile(join(workspacePath, "right.txt"), "right implementation\n");
      return workerReport(
        ["right.txt"],
        "Implemented the complete independent right-side behavior.",
      );
    }
    if (request.nodeId === "integrator") {
      await appendFile(join(workspacePath, "left.txt"), "integration correction\n");
      return workerReport(["left.txt"], "Applied the bounded cross-task integration correction.");
    }
    if (request.nodeId.startsWith("review.")) {
      const rejected = this.scenario === "review-rejection" && request.nodeId === "review.quality";
      return {
        status: "succeeded",
        output: rejected
          ? {
              approved: false,
              summary: "The independent quality review found one blocking fixture concern.",
              findings: [
                {
                  severity: "blocking",
                  summary: "Intentional acceptance rejection",
                  evidence: ["fixture/review-rejection"],
                },
              ],
            }
          : {
              approved: true,
              summary: "The independent review approved the complete integrated fixture result.",
              findings: [],
            },
      };
    }
    throw new Error(`Unexpected acceptance node ${request.nodeId}`);
  }

  private async waitForSiblingStart(request: ExecutionRequest): Promise<void> {
    const sibling = request.nodeId === "implement.left" ? "implement-right" : "implement-left";
    const root = await ensurePrivatePathRoot(this.probeRoot);
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await root.readFile([request.runId, `${sibling}-started.json`], { maxBytes: 4_096 });
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("Concurrent acceptance worker did not start");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  private requireExecution(handle: ExecutionHandle): FixtureExecution {
    const execution = this.executions.get(handle.id);
    if (!execution) {
      throw new Error("Unknown defined-SDLC acceptance execution");
    }
    return execution;
  }

  private async publishProbe(
    request: ExecutionRequest,
    phase: "started" | "completed" | "cancelled",
  ): Promise<void> {
    const root = await ensurePrivatePathRoot(this.probeRoot);
    await root.ensureDirectory([request.runId]);
    await root.writeFileAtomic(
      [request.runId, `${request.nodeId.replaceAll(".", "-")}-${phase}.json`],
      Buffer.from(
        canonicalJson({
          version: "anastom.dev/defined-sdlc-acceptance-probe/v1alpha1",
          runId: request.runId,
          nodeId: request.nodeId,
          phase,
          observedAtMs: Date.now(),
          processId: process.pid,
        }),
      ),
      { maxBytes: 4_096 },
    );
  }
}

function workerReport(changedFiles: string[], summary: string): ExecutionResult {
  return { status: "succeeded", output: { summary, changedFiles, notes: [] } };
}

function featurePlan() {
  return {
    summary: "Implement two independent files concurrently and combine their accepted patches.",
    tasks: [
      {
        id: "left",
        title: "Implement left behavior",
        objective: "Implement the complete independent behavior in the left fixture file.",
        acceptanceCriteria: ["The left implementation and integration correction are present"],
        dependsOn: [],
        mutationScopes: ["left.txt"],
      },
      {
        id: "right",
        title: "Implement right behavior",
        objective: "Implement the complete independent behavior in the right fixture file.",
        acceptanceCriteria: ["The right implementation is present"],
        dependsOn: [],
        mutationScopes: ["right.txt"],
      },
    ],
    risks: [],
  };
}
