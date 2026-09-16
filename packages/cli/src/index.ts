import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { digestJson, loadTask, loadWorkflow, type WorkflowDefinition } from "@anastom/core";
import {
  InMemoryRunPersistence,
  WorkflowEngine,
  renderRunStatus,
  renderWorkflowGraph,
  renderRunInspection,
  type RunPersistence,
  type RunState,
  type RunEvent,
} from "@anastom/engine";
import { FakeRuntimeAdapter, loadFakeScenario } from "@anastom/runtime-fake";
import { SqliteRunPersistence, FileArtifactStore } from "@anastom/persistence";
import { GitWorkspaceManager, resolveGitRepository, assertRunId } from "@anastom/workspaces";
import { PiRuntimeAdapter } from "@anastom/runtime-pi";
import { CodexRuntimeAdapter } from "@anastom/runtime-codex";
import { ClaudeCodeRuntimeAdapter, type ClaudeAuthSource } from "@anastom/runtime-claude-code";
import { probeRuntime, RuntimePreflightError } from "@anastom/runtime-contract";
import type { RuntimeAdapter } from "@anastom/runtime-contract";

/**
 * Injectable CLI output streams, allowing hosts and tests to capture diagnostics.
 */
export interface CliIo {
  /** Emit normal command output and retained run evidence. */
  stdout(message: string): void;
  /** Emit usage or operator-readable command diagnostics. */
  stderr(message: string): void;
}

/**
 * Optional CLI IO and process-local workflow persistence; Markdown tasks use durable storage.
 */
export interface CliOptions {
  io?: CliIo;
  persistence?: RunPersistence;
}

/** JSON emitted by durable inspect; a versioned workflow snapshot and its event-derived view. */
export interface DurableRunInspection {
  definitionDigest: string;
  workflow: WorkflowDefinition;
  state: RunState;
  events: RunEvent[];
}

const processLocalPersistence = new InMemoryRunPersistence();

function usage(): string {
  return [
    "Usage:",
    "  anastom validate <workflow>",
    "  anastom graph <workflow>",
    "  anastom run <workflow> --fake-scenario <file>",
    "  anastom inspect <run>",
    "  anastom run <task.md> --runtime pi|codex|claude-code|fake [--repo <path>] [--provider <id> --model <id>] [--auth-source subscription|api-key] [--reasoning-effort <level>] [--fake-scenario <file>]",
    "  anastom status <run> [--state-dir <path>]",
    "  anastom inspect <run> [--state-dir <path>] [--json]",
  ].join("\n");
}

function flags(args: readonly string[], allowed: readonly string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (!allowed.includes(flag) || flag in result) {
      throw new Error("Unknown or duplicate option: " + flag);
    }
    if (flag === "--json") {
      result[flag] = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) {
      throw new Error("Missing value for " + flag);
    }
    result[flag] = value;
  }
  return result;
}
function stringFlag(options: Record<string, string | true>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}
function loadTarget(file: string) {
  return extname(file).toLowerCase() === ".md" ? loadTask(file) : loadWorkflow(file);
}

type TaskRuntimeId = "pi" | "fake" | "codex" | "claude-code";
const reasoningLevels = ["low", "medium", "high", "xhigh", "max"] as const;

function checkedReasoningEffort(
  value: string | undefined,
  runtimeId: TaskRuntimeId,
): (typeof reasoningLevels)[number] | undefined {
  if (!value) {
    return undefined;
  }
  if (runtimeId !== "codex") {
    throw new Error("--reasoning-effort is valid for Codex only");
  }
  if (!reasoningLevels.includes(value as (typeof reasoningLevels)[number])) {
    throw new Error("Unsupported Codex reasoning effort");
  }
  return value as (typeof reasoningLevels)[number];
}

function assertClaudeAuthSelection(
  runtimeId: TaskRuntimeId,
  provider: string | undefined,
  model: string | undefined,
  authSource: string | undefined,
): void {
  if (
    runtimeId === "claude-code" &&
    (!provider || !model || (authSource !== "subscription" && authSource !== "api-key"))
  ) {
    throw new Error(
      "Claude Code requires explicit --provider anthropic, --model and --auth-source subscription|api-key",
    );
  }
  if (runtimeId !== "claude-code" && authSource) {
    throw new Error("--auth-source is valid for Claude Code only");
  }
}

function assertTaskSelection(selection: {
  runtimeId: TaskRuntimeId;
  scenario?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  authSource?: string;
}): void {
  const { runtimeId, scenario, provider, model, reasoningEffort, authSource } = selection;
  if (runtimeId === "fake" && !scenario) {
    throw new Error("Fake task execution requires an explicit --fake-scenario <file>");
  }
  if (runtimeId !== "fake" && scenario) {
    throw new Error("--fake-scenario is only valid for fake execution");
  }
  if (
    Boolean(provider) !== Boolean(model) ||
    (runtimeId === "fake" && (provider || model || reasoningEffort || authSource))
  ) {
    throw new Error("--provider and --model must be specified together for real runtimes");
  }
  if (runtimeId === "codex" && (!provider || !model)) {
    throw new Error("Codex requires explicit --provider openai and --model selection");
  }
  assertClaudeAuthSelection(runtimeId, provider, model, authSource);
}

function parseTaskOptions(args: readonly string[]): {
  opts: Record<string, string | true>;
  runtimeId: TaskRuntimeId;
  scenario?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  authSource?: ClaudeAuthSource;
} {
  const opts = flags(args, [
    "--runtime",
    "--repo",
    "--state-dir",
    "--fake-scenario",
    "--provider",
    "--model",
    "--reasoning-effort",
    "--auth-source",
  ]);
  const runtimeId = stringFlag(opts, "--runtime");
  if (
    runtimeId !== "pi" &&
    runtimeId !== "fake" &&
    runtimeId !== "codex" &&
    runtimeId !== "claude-code"
  ) {
    throw new Error("Task run requires --runtime pi, codex, claude-code or fake");
  }
  const scenario = stringFlag(opts, "--fake-scenario");
  const provider = stringFlag(opts, "--provider"),
    model = stringFlag(opts, "--model");
  const reasoningEffort = checkedReasoningEffort(stringFlag(opts, "--reasoning-effort"), runtimeId);
  const authSource = stringFlag(opts, "--auth-source");
  assertTaskSelection({ runtimeId, scenario, provider, model, reasoningEffort, authSource });
  return {
    opts,
    runtimeId,
    scenario,
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(authSource ? { authSource: authSource as ClaudeAuthSource } : {}),
  };
}

async function selectedTaskRuntime(
  selection: ReturnType<typeof parseTaskOptions>,
): Promise<RuntimeAdapter> {
  if (selection.runtimeId === "fake") {
    return new FakeRuntimeAdapter(await loadFakeScenario(selection.scenario as string));
  }
  if (selection.runtimeId === "pi") {
    return new PiRuntimeAdapter({ provider: selection.provider, model: selection.model });
  }
  if (selection.runtimeId === "claude-code") {
    return new ClaudeCodeRuntimeAdapter({
      provider: selection.provider as string,
      model: selection.model as string,
      authSource: selection.authSource as ClaudeAuthSource,
    });
  }
  return new CodexRuntimeAdapter({
    provider: selection.provider as string,
    model: selection.model as string,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  });
}

async function runTask(target: string, args: readonly string[], io: CliIo): Promise<number> {
  const selection = parseTaskOptions(args);
  const opts = selection.opts;
  const workflow = await loadTask(target);
  const runtime = await selectedTaskRuntime(selection);
  const { repoRoot } = await resolveGitRepository(stringFlag(opts, "--repo") ?? process.cwd());
  const stateDir = resolve(stringFlag(opts, "--state-dir") ?? resolve(repoRoot, ".anastom"));
  const manager = new GitWorkspaceManager(stateDir);
  const runId = randomUUID();
  const mutation = workflow.nodes.implement?.mutation;
  if (mutation !== "readonly" && mutation !== "isolated") {
    throw new Error("Task requires a filesystem mutation mode");
  }
  const runtimeNegotiation = await probeRuntime(runtime, mutation);
  const workspace = await manager.create(repoRoot, runId, workflow.nodes.implement?.mutation);
  const persistence = new SqliteRunPersistence(resolve(stateDir, "anastom.sqlite"));
  try {
    const engine = new WorkflowEngine({
      runtime,
      persistence,
      executionMode: "worker",
      artifacts: new FileArtifactStore(stateDir),
      captureWorkspace: (ref) => manager.capture(ref),
    });
    await engine.createRun(workflow, { runId, workspace, runtimeNegotiation });
    io.stdout(
      "Run " +
        runId +
        " created\nWorkspace: " +
        (workspace.mode === "memory" ? "memory" : workspace.path),
    );
    const state = await engine.runToCompletion(runId);
    io.stdout(renderRunInspection(state, workflow, await engine.events(runId)));
    return state.status === "succeeded" ? 0 : 1;
  } finally {
    persistence.close();
  }
}

async function durableInspect(
  command: string,
  target: string,
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  assertRunId(target);
  const opts = flags(args, command === "inspect" ? ["--state-dir", "--json"] : ["--state-dir"]);
  const supplied = stringFlag(opts, "--state-dir");
  const stateDir = supplied
    ? resolve(supplied)
    : resolve((await resolveGitRepository(process.cwd())).repoRoot, ".anastom");
  const path = resolve(stateDir, "anastom.sqlite");
  if (!existsSync(path)) {
    throw new Error("No durable run store at " + path + "; use --state-dir to select a run store");
  }
  const persistence = new SqliteRunPersistence(path);
  try {
    const run = await persistence.load(target);
    if (!run) {
      throw new Error("Run " + target + " was not found");
    }
    const engine = new WorkflowEngine({
      runtime: new FakeRuntimeAdapter({ nodes: {} }),
      persistence,
    });
    const state = await engine.inspect(target);
    if (!state) {
      throw new Error("Run was not found");
    }
    let output: string;
    if (opts["--json"]) {
      output = JSON.stringify(
        {
          definitionDigest: digestJson(run.workflow),
          workflow: run.workflow,
          state,
          events: run.events,
        },
        null,
        2,
      );
    } else if (command === "status") {
      output = renderRunStatus(state, run.workflow);
    } else {
      output = renderRunInspection(state, run.workflow, run.events);
    }
    io.stdout(output);
    return 0;
  } finally {
    persistence.close();
  }
}

/**
 * Execute a CLI command using injectable IO and return its exit code.
 * @returns Zero for success, one for command failure, or two for invalid usage.
 * @remarks Markdown tasks create durable state; YAML fake workflows preserve process-local storage.
 */
export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? {
    stdout: (message: string) => console.log(message),
    stderr: (message: string) => console.error(message),
  };
  const persistence = options.persistence ?? processLocalPersistence;

  try {
    const [command, target, ...rest] = args;
    if (target === undefined) {
      io.stderr(usage());
      return 2;
    }
    if (command === "validate" && rest.length === 0) {
      const workflow = await loadTarget(target);
      io.stdout(
        `valid ${workflow.metadata.id}@${workflow.metadata.version} (${workflow.nodeOrder.length} nodes)`,
      );
      return 0;
    }
    if (command === "graph" && rest.length === 0) {
      io.stdout(renderWorkflowGraph(await loadTarget(target)));
      return 0;
    }
    if (command === "run") {
      if (extname(target).toLowerCase() === ".md") {
        return await runTask(target, rest, io);
      }
      return await runFakeWorkflow(target, rest, { io, persistence });
    }

    if (command === "inspect" && rest.length === 0) {
      const run = await persistence.load(target);
      if (run === null) {
        return await durableInspect(command, target, rest, io);
      }
      const engine = new WorkflowEngine({
        runtime: new FakeRuntimeAdapter({ nodes: {} }),
        persistence,
      });
      const state = await engine.inspect(target);
      if (state === null) {
        throw new Error(`Run ${target} was not found`);
      }
      io.stdout(renderRunStatus(state, run.workflow));
      return 0;
    }
    if (command === "status" || command === "inspect") {
      return await durableInspect(command, target, rest, io);
    }
    io.stderr(usage());
    return 2;
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      io.stderr(error.category + ": " + error.message);
      return 1;
    }
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runFakeWorkflow(
  target: string,
  args: readonly string[],
  options: { io: CliIo; persistence: RunPersistence },
): Promise<number> {
  const scenarioFlag = args.indexOf("--fake-scenario");
  const scenarioPath = scenarioFlag === -1 ? undefined : args[scenarioFlag + 1];
  if (scenarioPath === undefined || args.length !== 2 || scenarioFlag !== 0) {
    throw new Error("run requires exactly one --fake-scenario <file> option");
  }
  const workflow = await loadWorkflow(target);
  const runtime = new FakeRuntimeAdapter(await loadFakeScenario(scenarioPath));
  const engine = new WorkflowEngine({ runtime, persistence: options.persistence });
  const state = await engine.start(workflow);
  options.io.stdout(renderRunStatus(state, workflow));
  return state.status === "succeeded" ? 0 : 1;
}
