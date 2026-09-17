import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { loadTaskWithinRoot, loadWorkflowWithinRoot } from "@anastom/core";
import {
  InMemoryRunPersistence,
  RunNotFoundError,
  RunOwnershipBlockedError,
  RunStoreError,
  WorkflowEngine,
  LiveRunProjector,
  renderRunStatus,
  renderWorkflowGraph,
  type RunPersistence,
  type RunState,
} from "@anastom/engine";
import { FakeRuntimeAdapter, loadFakeScenario } from "@anastom/runtime-fake";
import {
  createFeatureWorkspaceTopology,
  resolveGitRepository,
  assertRunId,
} from "@anastom/workspaces";
import { PiRuntimeAdapter } from "@anastom/runtime-pi";
import { CodexRuntimeAdapter } from "@anastom/runtime-codex";
import { ClaudeCodeRuntimeAdapter, type ClaudeAuthSource } from "@anastom/runtime-claude-code";
import { RuntimePreflightError } from "@anastom/runtime-contract";
import type { DurableRuntimeAdapter } from "@anastom/runtime-contract";

import {
  inspectDurableRun,
  openDurableCliServices,
  openDurableRunStore,
  renderDurableRunInspection,
} from "./durable.js";
import { CliUsageError } from "./errors.js";
import { prepareFeatureCommand } from "./feature-command.js";
import { LiveRunRenderer, terminalSafeText } from "./live.js";
import { renderTerminalSnapshot } from "./terminal-frame.js";
import { ProcessTerminalHost, type TerminalHost } from "./terminal-host.js";
import { runTerminalSession } from "./terminal-session.js";
import { projectTerminalRunView } from "./terminal-view.js";

/**
 * Injectable CLI output streams, allowing hosts and tests to capture diagnostics.
 */
interface CliIo {
  /** Emit normal command output and retained run evidence. */
  stdout(message: string): void;
  /** Emit usage or operator-readable command diagnostics. */
  stderr(message: string): void;
  /** Whether stdout supports terminal styling rather than newline-delimited JSON. */
  isTty?: boolean;
}

/**
 * Optional CLI IO, terminal host, and process-local persistence; Markdown runs use durable storage.
 */
export interface CliOptions {
  io?: CliIo;
  persistence?: RunPersistence;
  /** Optional interactive terminal capability; omitted hosts retain plain output behavior. */
  terminal?: TerminalHost;
}

const processLocalPersistence = new InMemoryRunPersistence();

function usage(): string {
  return [
    "Usage:",
    "  anastom validate <workflow>",
    "  anastom graph <workflow>",
    "  anastom run <workflow> --fake-scenario <file>",
    "  anastom inspect <run>",
    "  anastom run <task.md> --runtime pi|codex|claude-code [--repo <path>] [--provider <id> --model <id>] [--auth-source subscription|api-key] [--reasoning-effort <level>]",
    "  anastom run <feature.md> --method sdlc/default --runtime pi|codex|claude-code [--repo <path>] [--provider <id> --model <id>] [--auth-source subscription|api-key] [--reasoning-effort <level>]",
    "  anastom status <run> [--state-dir <path>]",
    "  anastom inspect <run> [--state-dir <path>] [--json]",
    "  anastom attach <run> [--state-dir <path>] [--snapshot]",
    "  anastom pause <run> [--state-dir <path>] [--operation-id <uuid>]",
    "  anastom cancel <run> [--state-dir <path>] [--operation-id <uuid>]",
    "  anastom resume <run> [--state-dir <path>] [--operation-id <uuid>]",
  ].join("\n");
}

function flags(args: readonly string[], allowed: readonly string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (!allowed.includes(flag) || flag in result) {
      throw new CliUsageError("Unknown or duplicate option: " + flag);
    }
    if (flag === "--json" || flag === "--snapshot") {
      result[flag] = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError("Missing value for " + flag);
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
  const root = process.cwd();
  return extname(file).toLowerCase() === ".md"
    ? loadTaskWithinRoot(root, file)
    : loadWorkflowWithinRoot(root, file);
}

type SelectedRuntimeId = "pi" | "codex" | "claude-code";
const reasoningLevels = ["low", "medium", "high", "xhigh", "max"] as const;

function checkedReasoningEffort(
  value: string | undefined,
  runtimeId: SelectedRuntimeId,
): (typeof reasoningLevels)[number] | undefined {
  if (!value) {
    return undefined;
  }
  if (runtimeId !== "codex") {
    throw new CliUsageError("--reasoning-effort is valid for Codex only");
  }
  if (!reasoningLevels.includes(value as (typeof reasoningLevels)[number])) {
    throw new CliUsageError("Unsupported Codex reasoning effort");
  }
  return value as (typeof reasoningLevels)[number];
}

function assertClaudeAuthSelection(
  runtimeId: SelectedRuntimeId,
  provider: string | undefined,
  model: string | undefined,
  authSource: string | undefined,
): void {
  if (
    runtimeId === "claude-code" &&
    (!provider || !model || (authSource !== "subscription" && authSource !== "api-key"))
  ) {
    throw new CliUsageError(
      "Claude Code requires explicit --provider anthropic, --model and --auth-source subscription|api-key",
    );
  }
  if (runtimeId !== "claude-code" && authSource) {
    throw new CliUsageError("--auth-source is valid for Claude Code only");
  }
}

function assertRuntimeSelection(selection: {
  runtimeId: SelectedRuntimeId;
  provider?: string;
  model?: string;
  authSource?: string;
}): void {
  const { runtimeId, provider, model, authSource } = selection;
  if (Boolean(provider) !== Boolean(model)) {
    throw new CliUsageError("--provider and --model must be specified together for real runtimes");
  }
  if (runtimeId === "codex" && (!provider || !model)) {
    throw new CliUsageError("Codex requires explicit --provider openai and --model selection");
  }
  if (runtimeId === "codex" && provider !== "openai") {
    throw new CliUsageError("Codex supports the openai provider only");
  }
  if (runtimeId === "claude-code" && provider !== "anthropic") {
    throw new CliUsageError("Claude Code supports the anthropic provider only");
  }
  assertClaudeAuthSelection(runtimeId, provider, model, authSource);
}

function parseRuntimeOptions(
  args: readonly string[],
  extraOptions: readonly string[] = [],
): {
  opts: Record<string, string | true>;
  runtimeId: SelectedRuntimeId;
  provider?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  authSource?: ClaudeAuthSource;
} {
  const opts = flags(args, [
    "--runtime",
    "--repo",
    "--state-dir",
    "--provider",
    "--model",
    "--reasoning-effort",
    "--auth-source",
    ...extraOptions,
  ]);
  const runtimeId = stringFlag(opts, "--runtime");
  if (runtimeId !== "pi" && runtimeId !== "codex" && runtimeId !== "claude-code") {
    throw new CliUsageError("Run requires --runtime pi, codex or claude-code");
  }
  const provider = stringFlag(opts, "--provider"),
    model = stringFlag(opts, "--model");
  const reasoningEffort = checkedReasoningEffort(stringFlag(opts, "--reasoning-effort"), runtimeId);
  const authSource = stringFlag(opts, "--auth-source");
  assertRuntimeSelection({ runtimeId, provider, model, authSource });
  return {
    opts,
    runtimeId,
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(authSource ? { authSource: authSource as ClaudeAuthSource } : {}),
  };
}

async function selectedRuntime(
  selection: ReturnType<typeof parseRuntimeOptions>,
): Promise<DurableRuntimeAdapter> {
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
  const selection = parseRuntimeOptions(args);
  const opts = selection.opts;
  const workflow = await loadTaskWithinRoot(process.cwd(), target);
  const runtime = await selectedRuntime(selection);
  const descriptor = await runtime.descriptor();
  const { repoRoot } = await resolveGitRepository(stringFlag(opts, "--repo") ?? process.cwd());
  const stateDir = resolve(stringFlag(opts, "--state-dir") ?? resolve(repoRoot, ".anastom"));
  const runId = randomUUID();
  const mutation = workflow.nodes.implement?.mutation;
  if (mutation !== "readonly" && mutation !== "isolated") {
    throw new Error("Task requires a filesystem mutation mode");
  }
  const services = await openLiveDurableServices(stateDir, io);
  try {
    const workspace = await services.workspaces.create(repoRoot, runId, mutation);
    if (workspace.mode === "memory") {
      throw new Error("Durable task execution requires a filesystem workspace");
    }
    await services.coordinator.createRun(workflow, { runId, workspace, descriptor });
    announceDurableRun(io, runId, stateDir);
    const state = await services.coordinator.resume(runId);
    return state.status === "succeeded" ? 0 : 1;
  } finally {
    services.store.close();
  }
}

async function openLiveDurableServices(stateDir: string, io: CliIo) {
  const renderer = new LiveRunRenderer(io.isTty ?? false);
  let projector: LiveRunProjector | undefined;
  return openDurableCliServices(stateDir, {
    observeCommittedEvents(events, state, committedWorkflow) {
      projector ??= new LiveRunProjector(committedWorkflow);
      for (const line of renderer.render(projector.project(state, events))) {
        io.stdout(line);
      }
    },
  });
}

async function runFeature(target: string, args: readonly string[], io: CliIo): Promise<number> {
  const selection = parseRuntimeOptions(args, ["--method"]);
  const method = stringFlag(selection.opts, "--method");
  if (method !== "sdlc/default") {
    throw new CliUsageError("Feature run requires --method sdlc/default");
  }
  const [prepared, runtime] = await Promise.all([
    prepareFeatureCommand({
      sourceRoot: process.cwd(),
      target,
      repository: stringFlag(selection.opts, "--repo") ?? process.cwd(),
    }),
    selectedRuntime(selection),
  ]);
  const descriptor = await runtime.descriptor();
  const { workflow, repositoryRoot: repoRoot, protectedPaths } = prepared;
  const stateDir = resolve(
    stringFlag(selection.opts, "--state-dir") ?? resolve(repoRoot, ".anastom"),
  );
  const runId = randomUUID();
  const services = await openLiveDurableServices(stateDir, io);
  try {
    const topology = await createFeatureWorkspaceTopology(
      services.workspaces,
      repoRoot,
      runId,
      protectedPaths,
    );
    await services.coordinator.createRun(workflow, {
      runId,
      workspace: topology.integration,
      descriptor,
    });
    announceDurableRun(io, runId, stateDir);
    const state = await services.coordinator.resume(runId);
    return state.status === "succeeded" ? 0 : 1;
  } finally {
    services.store.close();
  }
}

function announceDurableRun(io: CliIo, runId: string, stateDir: string): void {
  if (!io.isTty) {
    return;
  }
  io.stdout(`Run ID: ${terminalSafeText(runId)}\nState directory: ${terminalSafeText(stateDir)}`);
}

async function durableInspect(
  command: string,
  target: string,
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  try {
    assertRunId(target);
  } catch (error) {
    throw new CliUsageError("Invalid run ID", { cause: error });
  }
  const opts = flags(args, command === "inspect" ? ["--state-dir", "--json"] : ["--state-dir"]);
  const supplied = stringFlag(opts, "--state-dir");
  const stateDir = supplied
    ? resolve(supplied)
    : resolve((await resolveGitRepository(process.cwd())).repoRoot, ".anastom");
  const path = resolve(stateDir, "anastom.sqlite");
  if (!existsSync(path)) {
    throw new CliUsageError(
      "No durable run store at " + path + "; use --state-dir to select a run store",
    );
  }
  const persistence = await openDurableRunStore(stateDir);
  try {
    const inspection = await inspectDurableRun(persistence, target, command === "inspect");
    if (!inspection) {
      throw new CliUsageError("Run " + target + " was not found");
    }
    const output = opts["--json"]
      ? JSON.stringify(inspection, null, 2)
      : renderDurableRunInspection(inspection);
    io.stdout(output);
    return 0;
  } finally {
    persistence.close();
  }
}

const operationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function durableCommandOptions(
  target: string,
  args: readonly string[],
): Promise<{ stateDir: string; operationId: string }> {
  try {
    assertRunId(target);
  } catch (error) {
    throw new CliUsageError("Invalid run ID", { cause: error });
  }
  const opts = flags(args, ["--state-dir", "--operation-id"]);
  const operationId = stringFlag(opts, "--operation-id") ?? randomUUID();
  if (!operationUuid.test(operationId)) {
    throw new CliUsageError("--operation-id must be a UUIDv4");
  }
  const supplied = stringFlag(opts, "--state-dir");
  return {
    stateDir: supplied
      ? resolve(supplied)
      : resolve((await resolveGitRepository(process.cwd())).repoRoot, ".anastom"),
    operationId,
  };
}

function requireDurableDatabase(stateDir: string): void {
  const path = resolve(stateDir, "anastom.sqlite");
  if (!existsSync(path)) {
    throw new CliUsageError(
      "No durable run store at " + path + "; use --state-dir to select a run store",
    );
  }
}

function controlReached(action: "pause" | "cancel", state: RunState): boolean {
  return action === "pause" ? state.status === "paused" : state.status === "cancelled";
}

function cannotAcceptControl(action: "pause" | "cancel", state: RunState): string | undefined {
  if (controlReached(action, state)) {
    return undefined;
  }
  return state.status === "succeeded" || state.status === "failed" || state.status === "blocked"
    ? `run-${state.status}`
    : undefined;
}

async function controlDurableRun(
  action: "pause" | "cancel",
  target: string,
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { stateDir, operationId } = await durableCommandOptions(target, args);
  requireDurableDatabase(stateDir);
  io.stdout(`Operation: ${operationId}`);
  const services = await openDurableCliServices(stateDir);
  try {
    const before = await inspectDurableRun(services.store, target, false);
    if (!before) {
      throw new CliUsageError(`Run ${target} was not found`);
    }
    if (controlReached(action, before.state)) {
      io.stdout(renderDurableRunInspection(before));
      return 0;
    }
    const blocked = cannotAcceptControl(action, before.state);
    if (blocked) {
      io.stdout(`Control blocked: ${blocked}`);
      return 1;
    }
    const receipt = await services.coordinator.submitControl(target, action, operationId);
    io.stdout(
      `Control accepted: action=${action} operation=${operationId} replayed=${receipt.replayed}`,
    );
    try {
      await services.coordinator.resume(target, operationId);
    } catch (error) {
      if (error instanceof RunOwnershipBlockedError) {
        io.stdout(`Control pending: ${error.reason}`);
        return 1;
      }
      throw error;
    }
    const after = await inspectDurableRun(services.store, target, false);
    if (!after) {
      throw new Error("Controlled run disappeared from durable storage");
    }
    io.stdout(renderDurableRunInspection(after));
    return controlReached(action, after.state) ? 0 : 1;
  } finally {
    services.store.close();
  }
}

async function resumeDurableRun(
  target: string,
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { stateDir, operationId } = await durableCommandOptions(target, args);
  requireDurableDatabase(stateDir);
  io.stdout(`Operation: ${operationId}`);
  const services = await openDurableCliServices(stateDir);
  try {
    if (!(await inspectDurableRun(services.store, target, false))) {
      throw new CliUsageError(`Run ${target} was not found`);
    }
    try {
      await services.coordinator.resume(target, operationId);
    } catch (error) {
      if (error instanceof RunOwnershipBlockedError) {
        io.stdout(`Resume blocked: ${error.reason}`);
        return 1;
      }
      throw error;
    }
    const after = await inspectDurableRun(services.store, target, false);
    if (!after) {
      throw new Error("Resumed run disappeared from durable storage");
    }
    io.stdout(renderDurableRunInspection(after));
    return after.state.status === "succeeded" ? 0 : 1;
  } finally {
    services.store.close();
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
    isTty: process.stdout.isTTY === true,
  };
  const persistence = options.persistence ?? processLocalPersistence;
  const processTerminal = new ProcessTerminalHost();
  const terminal =
    options.terminal ??
    (options.io === undefined && processTerminal.interactive() ? processTerminal : undefined);
  try {
    return await executeCliCommand(args, io, persistence, terminal);
  } catch (error) {
    return reportCliError(error, io);
  }
}

async function executeCliCommand(
  args: readonly string[],
  io: CliIo,
  persistence: RunPersistence,
  terminal: TerminalHost | undefined,
): Promise<number> {
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
    if (extname(target).toLowerCase() !== ".md") {
      return runFakeWorkflow(target, rest, { io, persistence });
    }
    return rest.includes("--method") ? runFeature(target, rest, io) : runTask(target, rest, io);
  }
  if (command === "inspect" && rest.length === 0) {
    return inspectProcessLocalOrDurable(target, io, persistence);
  }
  if (command === "status" || command === "inspect") {
    return durableInspect(command, target, rest, io);
  }
  if (command === "attach") {
    return attachDurableRun(target, rest, io, terminal);
  }
  if (command === "pause" || command === "cancel") {
    return controlDurableRun(command, target, rest, io);
  }
  if (command === "resume") {
    return resumeDurableRun(target, rest, io);
  }
  io.stderr(usage());
  return 2;
}

async function attachDurableRun(
  target: string,
  args: readonly string[],
  io: CliIo,
  terminal: TerminalHost | undefined,
): Promise<number> {
  try {
    assertRunId(target);
  } catch (error) {
    throw new CliUsageError("Invalid run ID", { cause: error });
  }
  const opts = flags(args, ["--state-dir", "--snapshot"]);
  const supplied = stringFlag(opts, "--state-dir");
  const stateDir = supplied
    ? resolve(supplied)
    : resolve((await resolveGitRepository(process.cwd())).repoRoot, ".anastom");
  requireDurableDatabase(stateDir);
  const store = await openDurableRunStore(stateDir);
  try {
    const initial = await inspectDurableRun(store, target, true);
    if (!initial) {
      throw new CliUsageError(`Run ${target} was not found`);
    }
    if (opts["--snapshot"]) {
      io.stdout(renderTerminalSnapshot(projectTerminalRunView(initial)));
      return 0;
    }
    if (!terminal) {
      return followDurableRun(store, target, io, initial);
    }
    await runTerminalSession({
      host: terminal,
      operations: {
        load: () => inspectDurableRun(store, target, true),
        async submit(action, operationId) {
          const receipt = await store.submitControl({
            runId: target,
            action,
            operationId,
          });
          try {
            await launchResumeProcess(target, stateDir, operationId);
            return receipt;
          } catch (error) {
            return {
              ...receipt,
              coordinatorLaunchError: error instanceof Error ? error.message : String(error),
            };
          }
        },
        launchResume: (operationId) => launchResumeProcess(target, stateDir, operationId),
      },
      createOperationId: randomUUID,
    });
    return 0;
  } finally {
    store.close();
  }
}

async function followDurableRun(
  store: Awaited<ReturnType<typeof openDurableRunStore>>,
  runId: string,
  io: CliIo,
  initial: NonNullable<Awaited<ReturnType<typeof inspectDurableRun>>>,
): Promise<number> {
  const renderer = new LiveRunRenderer(false);
  let inspection = initial;
  while (true) {
    for (const line of renderer.render(inspection.liveEvents ?? [])) {
      io.stdout(line);
    }
    if (inspection.state.status !== "running") {
      return 0;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const next = await inspectDurableRun(store, runId, true);
    if (!next) {
      throw new Error("Attached run disappeared from durable storage");
    }
    inspection = next;
  }
}

async function launchResumeProcess(
  runId: string,
  stateDir: string,
  operationId: string,
): Promise<void> {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot locate the current Anastom CLI entry point");
  }
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      entry,
      "resume",
      runId,
      "--state-dir",
      stateDir,
      "--operation-id",
      operationId,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    child.once("spawn", resolveLaunch);
    child.once("error", rejectLaunch);
  });
  child.unref();
}

async function inspectProcessLocalOrDurable(
  target: string,
  io: CliIo,
  persistence: RunPersistence,
): Promise<number> {
  const run = await persistence.load(target);
  if (run === null) {
    return durableInspect("inspect", target, [], io);
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

function reportCliError(error: unknown, io: CliIo): number {
  const invalidStore =
    error instanceof RunStoreError && ["not-found", "corrupt-store"].includes(error.code);
  if (error instanceof CliUsageError || error instanceof RunNotFoundError || invalidStore) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (error instanceof RuntimePreflightError) {
    io.stderr(error.category + ": " + error.message);
    return 1;
  }
  io.stderr(error instanceof Error ? error.message : String(error));
  return 1;
}

async function runFakeWorkflow(
  target: string,
  args: readonly string[],
  options: { io: CliIo; persistence: RunPersistence },
): Promise<number> {
  const scenarioFlag = args.indexOf("--fake-scenario");
  const scenarioPath = scenarioFlag === -1 ? undefined : args[scenarioFlag + 1];
  if (scenarioPath === undefined || args.length !== 2 || scenarioFlag !== 0) {
    throw new CliUsageError("run requires exactly one --fake-scenario <file> option");
  }
  const workflow = await loadWorkflowWithinRoot(process.cwd(), target);
  const runtime = new FakeRuntimeAdapter(await loadFakeScenario(scenarioPath));
  const engine = new WorkflowEngine({ runtime, persistence: options.persistence });
  const state = await engine.start(workflow);
  options.io.stdout(renderRunStatus(state, workflow));
  return state.status === "succeeded" ? 0 : 1;
}
