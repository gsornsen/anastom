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
    "  anastom run <task.md> --runtime pi|fake [--repo <path>] [--fake-scenario <file>]",
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

async function runTask(target: string, args: readonly string[], io: CliIo): Promise<number> {
  const opts = flags(args, [
    "--runtime",
    "--repo",
    "--state-dir",
    "--fake-scenario",
    "--provider",
    "--model",
  ]);
  const runtimeId = stringFlag(opts, "--runtime");
  if (runtimeId !== "pi" && runtimeId !== "fake") {
    throw new Error("Task run requires --runtime pi or --runtime fake");
  }
  const scenario = stringFlag(opts, "--fake-scenario");
  if (runtimeId === "fake" && !scenario) {
    throw new Error("Fake task execution requires an explicit --fake-scenario <file>");
  }
  if (runtimeId === "pi" && scenario) {
    throw new Error("--fake-scenario is only valid for fake execution");
  }
  const provider = stringFlag(opts, "--provider"),
    model = stringFlag(opts, "--model");
  if (Boolean(provider) !== Boolean(model) || (runtimeId === "fake" && (provider || model))) {
    throw new Error("--provider and --model must be specified together for Pi");
  }
  const workflow = await loadTask(target);
  const runtime =
    runtimeId === "fake"
      ? new FakeRuntimeAdapter(await loadFakeScenario(scenario as string))
      : new PiRuntimeAdapter({ provider, model });
  const { repoRoot } = await resolveGitRepository(stringFlag(opts, "--repo") ?? process.cwd());
  const stateDir = resolve(stringFlag(opts, "--state-dir") ?? resolve(repoRoot, ".anastom"));
  const manager = new GitWorkspaceManager(stateDir);
  const runId = randomUUID();
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
    await engine.createRun(workflow, { runId, workspace });
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
