import { readFile, writeFile, realpath, mkdir, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";

import type { JsonValue } from "@anastom/core";
import { FAILURE_CATEGORIES, type ExecutionHandle, type ExecutionRequest, type ExecutionResult, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeEvent } from "@anastom/runtime-contract";
import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";

export type FakeAttemptDefinition =
  | { outcome?: "succeeded"; output: JsonValue; events?: string[]; files?: Record<string, string> }
  | { outcome: "failed"; failure?: { category?: (typeof FAILURE_CATEGORIES)[number]; message?: string }; events?: string[] }
  | { outcome: "blocked"; reason?: string; events?: string[] }
  | { outcome: "cancelled"; reason?: string; events?: string[] };

export interface FakeScenario {
  nodes: Record<string, FakeAttemptDefinition[]>;
}

const scenarioSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes"],
  properties: {
    nodes: {
      type: "object",
      additionalProperties: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["output"],
              properties: {
                outcome: { const: "succeeded" },
                output: true,
                files: { type: "object", additionalProperties: { type: "string" } },
                events: { type: "array", items: { type: "string" } },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["outcome"],
              properties: {
                outcome: { const: "failed" },
                failure: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    category: { enum: [...FAILURE_CATEGORIES] },
                    message: { type: "string" },
                  },
                },
                events: { type: "array", items: { type: "string" } },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["outcome"],
              properties: {
                outcome: { enum: ["blocked", "cancelled"] },
                reason: { type: "string" },
                events: { type: "array", items: { type: "string" } },
              },
            },
          ],
        },
      },
    },
  },
} as const;

const validateScenario = new Ajv({ allErrors: true, strict: false }).compile(scenarioSchema);

export class FakeScenarioValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid fake scenario:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "FakeScenarioValidationError";
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export function parseFakeScenario(source: string): FakeScenario {
  let candidate: unknown;
  try {
    candidate = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FakeScenarioValidationError([`YAML parse error: ${message}`]);
  }
  if (!validateScenario(candidate)) {
    throw new FakeScenarioValidationError(formatErrors(validateScenario.errors));
  }
  return candidate;
}

export async function loadFakeScenario(filePath: string): Promise<FakeScenario> {
  const absolutePath = resolve(filePath);
  try {
    return parseFakeScenario(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error instanceof FakeScenarioValidationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new FakeScenarioValidationError([`cannot load scenario ${absolutePath}: ${message}`]);
  }
}

interface PendingExecution {
  result: ExecutionResult;
  events: RuntimeEvent[];
}

function normalizeAttempt(nodeId: string, attempt: number, definition: FakeAttemptDefinition | undefined): PendingExecution {
  if (definition === undefined) {
    return {
      result: {
        status: "failed",
        failure: {
          category: "runtime-unavailable",
          message: `No fake result scripted for ${nodeId} attempt ${attempt}`,
        },
      },
      events: [],
    };
  }

  let result: ExecutionResult;
  if ("output" in definition) {
    result = { status: "succeeded", output: definition.output };
  } else if (definition.outcome === "failed") {
    result = {
      status: "failed",
      failure: {
        category: definition.failure?.category ?? "unknown-internal",
        message: definition.failure?.message ?? `Scripted failure for ${nodeId} attempt ${attempt}`,
      },
    };
  } else {
    result = {
      status: definition.outcome,
      reason: definition.reason ?? `Scripted ${definition.outcome} result for ${nodeId} attempt ${attempt}`,
    };
  }
  return {
    result,
    events: (definition.events ?? []).map((message) => ({ type: "log", message })),
  };
}

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "fake";
  private readonly executions = new Map<string, PendingExecution>();

  constructor(private readonly scenario: FakeScenario) {}

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      cancellation: true,
      resumableSession: false,
      nativeSubagents: false,
      mcp: false,
      lsp: false,
      debugger: false,
      browser: false,
      structuredOutput: "native",
      usageReporting: "none",
      sandboxing: ["memory"],
    };
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const id = `fake:${request.runId}:${request.nodeId}:${request.attempt}`;
    const definition = this.scenario.nodes[request.nodeId]?.[request.attempt - 1];
    if (definition && "files" in definition && definition.files) {
      if (request.workspace.mode !== "isolated" || !request.toolPolicy.allowMutations) throw new Error("Fake file changes require an isolated mutable workspace");
      const root = await realpath(request.workspace.path);
      for (const [path, content] of Object.entries(definition.files)) {
        if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) throw new Error("Fake file path escapes workspace");
        const target = resolve(root, path);
        const rel = relative(root, target);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid fake file path");
        let parent = root;
        for (const segment of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) {
          parent = resolve(parent, segment);
          try { if ((await lstat(parent)).isSymbolicLink()) throw new Error("Fake file parent is a symlink"); }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            await mkdir(parent);
          }
        }
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Fake file target is a symlink"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        await writeFile(target, content);
      }
    }
    this.executions.set(
      id,
      normalizeAttempt(request.nodeId, request.attempt, definition),
    );
    return { id };
  }

  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const execution = this.requireExecution(handle);
    yield { type: "started" };
    for (const event of execution.events) yield event;
    yield { type: "completed", status: execution.result.status };
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return structuredClone(this.requireExecution(handle).result);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const execution = this.requireExecution(handle);
    execution.result = { status: "cancelled", reason: "Cancelled by control plane" };
  }

  async recover(): Promise<null> {
    return null;
  }

  private requireExecution(handle: ExecutionHandle): PendingExecution {
    const execution = this.executions.get(handle.id);
    if (execution === undefined) throw new Error(`Unknown fake execution handle: ${handle.id}`);
    return execution;
  }
}
