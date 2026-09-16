import { readFile, writeFile, realpath, mkdir, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { PathPolicyError, resolveExistingChild } from "@anastom/path-policy";

import type { JsonValue } from "@anastom/core";
import type { FAILURE_CATEGORIES } from "@anastom/runtime-contract";
import {
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
} from "@anastom/runtime-contract";
import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";
import scenarioSchema from "../schemas/scenario.v1alpha1.json" with { type: "json" };

/**
 * A deterministic result script, optionally including logs and isolated workspace file changes.
 */
export type FakeAttemptDefinition =
  | {
      outcome?: "succeeded";
      output: JsonValue;
      events?: string[];
      files?: Record<string, string | FakeFileReference>;
    }
  | {
      outcome: "failed";
      failure?: { category?: (typeof FAILURE_CATEGORIES)[number]; message?: string };
      events?: string[];
    }
  | { outcome: "blocked"; reason?: string; events?: string[] }
  | { outcome: "cancelled"; reason?: string; events?: string[] };

/**
 * Ordered attempt scripts selected by node ID; no real model or subprocess integration is involved.
 */
export interface FakeScenario {
  nodes: Record<string, FakeAttemptDefinition[]>;
}

/** Source file relative to the scenario directory, materialized before execution. */
export interface FakeFileReference {
  fromFile: string;
}

const validateScenario = new Ajv({ allErrors: true, strict: false }).compile<FakeScenario>(
  scenarioSchema,
);

/**
 * Actionable diagnostics for malformed scenarios or unsafe file references.
 */
export class FakeScenarioValidationError extends Error {
  /**
   * Collect actionable scenario parsing and file-reference diagnostics.
   */
  constructor(readonly issues: readonly string[]) {
    super(`Invalid fake scenario:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "FakeScenarioValidationError";
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

/**
 * Parse and validate a deterministic scenario; file references remain unresolved until loadFakeScenario.
 */
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

/**
 * Load a local scenario and materialize file references relative to its directory.
 * @remarks References cannot escape that directory lexically or through symlinks. Inline file text remains supported.
 */
export async function loadFakeScenario(filePath: string): Promise<FakeScenario> {
  const absolutePath = resolve(filePath);
  try {
    const scenario = parseFakeScenario(await readFile(absolutePath, "utf8"));
    const root = await realpath(dirname(absolutePath));
    for (const attempts of Object.values(scenario.nodes)) {
      for (const attempt of attempts) {
        await materializeFiles(root, attempt);
      }
    }
    return scenario;
  } catch (error) {
    if (error instanceof FakeScenarioValidationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new FakeScenarioValidationError([`cannot load scenario ${absolutePath}: ${message}`]);
  }
}

async function loadReferencedFile(root: string, source: string): Promise<string> {
  if (isAbsolute(source) || source.split(/[\\/]/).includes("..") || source.includes("\0")) {
    throw new FakeScenarioValidationError([
      "Scenario file reference must stay within its directory",
    ]);
  }
  let path: string;
  try {
    path = await resolveExistingChild(root, source, "file");
  } catch (error) {
    if (error instanceof PathPolicyError && error.reason === "outside-root") {
      throw new FakeScenarioValidationError(["Scenario file reference escapes its directory"]);
    }
    throw error;
  }
  return readFile(path, "utf8");
}

interface PendingExecution {
  result: ExecutionResult;
  events: RuntimeEvent[];
  finished?: boolean;
}

function normalizeAttempt(
  nodeId: string,
  attempt: number,
  definition: FakeAttemptDefinition | undefined,
): PendingExecution {
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
      reason:
        definition.reason ??
        `Scripted ${definition.outcome} result for ${nodeId} attempt ${attempt}`,
    };
  }
  return {
    result,
    events: (definition.events ?? []).map((message) => ({ type: "log", message })),
  };
}

/**
 * A deterministic RuntimeAdapter for contracts, fixtures, and repeatable failure-handling tests.
 */
export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "fake";
  private readonly executions = new Map<string, PendingExecution>();

  /**
   * Bind explicit scripted results; unresolved file references must be materialized by loadFakeScenario.
   */
  constructor(private readonly scenario: FakeScenario) {
    this.scenario = structuredClone(scenario);
  }

  /**
   * Describe deterministic fake execution and its supported observable contract features.
   */
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
      workspaceModes: ["memory", "readonly", "isolated"],
    };
  }

  /**
   * Select the node's scripted attempt and apply only authorized isolated workspace changes.
   */
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    request = structuredClone(request);
    const id = `fake:${request.runId}:${request.nodeId}:${request.attempt}`;
    const definition = this.scenario.nodes[request.nodeId]?.[request.attempt - 1];
    if (definition && "files" in definition && definition.files) {
      await applyFileChanges(request, definition.files);
    }
    this.executions.set(
      id,
      structuredClone(normalizeAttempt(request.nodeId, request.attempt, definition)),
    );
    return { id };
  }

  /**
   * Stream the scripted public lifecycle and log observations in deterministic order.
   */
  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const execution = this.requireExecution(handle);
    yield { type: "started" };
    for (const event of execution.events) {
      yield event;
    }
    execution.finished = true;
    yield { type: "completed", status: execution.result.status };
  }

  /**
   * Return a defensive copy of the selected terminal result.
   */
  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const execution = this.requireExecution(handle);
    execution.finished = true;
    return structuredClone(execution.result);
  }

  /**
   * Replace the pending scripted result with a cancelled outcome.
   */
  async cancel(handle: ExecutionHandle): Promise<void> {
    const execution = this.requireExecution(handle);
    if (execution.finished) {
      return;
    }
    execution.result = { status: "cancelled", reason: "Cancelled by control plane" };
  }

  /**
   * Return null because fake execution handles are process-local.
   */
  async recover(): Promise<null> {
    return null;
  }

  private requireExecution(handle: ExecutionHandle): PendingExecution {
    const execution = this.executions.get(handle.id);
    if (execution === undefined) {
      throw new Error(`Unknown fake execution handle: ${handle.id}`);
    }
    return execution;
  }
}

async function materializeFiles(root: string, attempt: FakeAttemptDefinition): Promise<void> {
  if (!("files" in attempt) || !attempt.files) {
    return;
  }
  for (const [target, content] of Object.entries(attempt.files)) {
    if (typeof content !== "string") {
      attempt.files[target] = await loadReferencedFile(root, content.fromFile);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error("Fake file path is a symlink");
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function createSafeParents(root: string, target: string): Promise<void> {
  let parent = root;
  for (const segment of relative(root, dirname(target)).split(/[\\/]/).filter(Boolean)) {
    parent = resolve(parent, segment);
    await rejectSymlink(parent);
    await mkdir(parent, { recursive: false }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    });
  }
}

async function applyFileChanges(
  request: ExecutionRequest,
  files: Record<string, string | FakeFileReference>,
): Promise<void> {
  if (request.workspace.mode !== "isolated" || !request.toolPolicy.allowMutations) {
    throw new Error("Fake file changes require an isolated mutable workspace");
  }
  const root = await realpath(request.workspace.path);
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string") {
      throw new FakeScenarioValidationError([
        "Load file references with loadFakeScenario before execution",
      ]);
    }
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) {
      throw new Error("Fake file path escapes workspace");
    }
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Invalid fake file path");
    }
    await createSafeParents(root, target);
    await rejectSymlink(target);
    await writeFile(target, content);
  }
}
