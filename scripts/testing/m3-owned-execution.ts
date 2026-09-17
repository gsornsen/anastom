import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@anastom/core";
import { PiRuntimeAdapter, type PiSession, type PiSessionFactory } from "@anastom/runtime-pi";
import { CodexRuntimeAdapter } from "@anastom/runtime-codex";
import { ClaudeCodeRuntimeAdapter } from "@anastom/runtime-claude-code";
import {
  assertRuntimeEvent,
  type ExecutionHandle,
  type ExecutionResult,
  type RuntimeAdapter,
  type RuntimeEvent,
} from "@anastom/runtime-contract";
import {
  conformanceReport,
  conformanceRequest,
} from "../../packages/runtime-contract/src/testing/conformance.js";
import { syntheticCodex } from "../../packages/runtime-codex/src/testing/fixture.js";
import { syntheticClaudeCode } from "../../packages/runtime-claude-code/src/testing/fixture.js";
import {
  inspectProcess,
  isLiveProcess,
  matchesLiveProcess,
  terminateObservedGroup,
  terminateObservedProcess,
  waitForCondition,
  type ProcessIdentity,
} from "../m3-process-identity.js";
import type { M3SupervisorOwner, M3SupervisorScenario } from "../m3-supervisor-protocol.js";
import { readM3Record, writeM3Record } from "./m3-records.js";

interface WorkerRecord {
  leaderPid: number;
  descendantPid: number;
}

interface ExecutionProbe {
  leader: ProcessIdentity;
  descendant: ProcessIdentity;
}

/** Active model-free execution owned by the supervisor process. */
export interface M3OwnedExecution {
  events: RuntimeEvent[];
  result: Promise<ExecutionResult>;
  cancel: () => Promise<void>;
}

function testingProgram(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

async function requiredIdentity(pid: number, label: string): Promise<ProcessIdentity> {
  const identity = await inspectProcess(pid);
  if (!isLiveProcess(identity)) {
    throw new Error(`${label} identity is not live`);
  }
  return identity;
}

async function nativePids(root: string): Promise<WorkerRecord | null> {
  const entry = (await readdir(root)).find((name) => /^entry-\d+\.json$/.test(name));
  if (!entry) {
    return null;
  }
  try {
    const child = await readFile(join(root, "child-pid"), "utf8");
    if (!/^[1-9]\d*$/.test(child)) {
      return null;
    }
    return { leaderPid: Number(entry.slice(6, -5)), descendantPid: Number(child) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function recordProbe(root: string, pids: WorkerRecord): Promise<void> {
  await writeM3Record(root, "execution-probe.json", {
    leader: await requiredIdentity(pids.leaderPid, "Execution leader"),
    descendant: await requiredIdentity(pids.descendantPid, "Execution descendant"),
  } satisfies ExecutionProbe);
}

async function drainRuntimeEvents(
  adapter: RuntimeAdapter,
  handle: ExecutionHandle,
  events: RuntimeEvent[],
  started: () => void,
): Promise<void> {
  for await (const event of adapter.events(handle)) {
    assertRuntimeEvent(event);
    if (events.length >= 256) {
      throw new Error("Owned runtime exceeded the supervisor event bound");
    }
    events.push(structuredClone(event));
    if (event.type === "started") {
      started();
    }
  }
}

async function runtimeExecution(options: {
  adapter: RuntimeAdapter;
  workspace: string;
  ready?: () => Promise<void>;
  dispose: () => Promise<void>;
}): Promise<M3OwnedExecution> {
  const handle = await options.adapter.start(conformanceRequest(options.workspace));
  const events: RuntimeEvent[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const drained = drainRuntimeEvents(options.adapter, handle, events, markStarted);
  const result = (async () => {
    try {
      const terminal = await options.adapter.collect(handle);
      await drained;
      return terminal;
    } finally {
      await options.dispose();
    }
  })();
  try {
    await Promise.all([started, options.ready?.() ?? Promise.resolve()]);
  } catch (error) {
    await options.adapter.cancel(handle).catch(() => {});
    await result.catch(() => {});
    throw error;
  }
  return {
    events,
    result,
    cancel: async () => {
      await options.adapter.cancel(handle);
      await result;
    },
  };
}

async function piExecution(
  root: string,
  scenario: M3SupervisorScenario,
): Promise<M3OwnedExecution> {
  let releasePrompt: (() => void) | undefined;
  let descendant: ProcessIdentity | undefined;
  const factory: PiSessionFactory = async () => {
    if (scenario === "hold") {
      const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      if (child.pid === undefined) {
        throw new Error("Pi fixture descendant has no PID");
      }
      descendant = await requiredIdentity(child.pid, "Pi descendant");
      await writeM3Record(root, "execution-probe.json", {
        leader: await requiredIdentity(process.pid, "Pi host"),
        descendant,
      } satisfies ExecutionProbe);
    }
    const inFlight = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const session: PiSession = {
      identity: { provider: "fixture", model: "fixture" },
      subscribe: () => () => {},
      prompt: async () => {
        if (scenario === "hold") {
          await inFlight;
        }
      },
      finalMessage: () => ({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(conformanceReport) }],
      }),
      abort: async () => {
        if (descendant && (await matchesLiveProcess(descendant))) {
          await terminateObservedProcess(descendant);
        }
        releasePrompt?.();
      },
      dispose: () => {},
    };
    return session;
  };
  return runtimeExecution({
    adapter: new PiRuntimeAdapter({ factory }),
    workspace: root,
    ready:
      scenario === "hold"
        ? async () => {
            await waitForCondition(
              "Pi execution probe",
              async () => (await readM3Record(root, "execution-probe.json")) !== null,
            );
          }
        : undefined,
    dispose: async () => {},
  });
}

async function codexExecution(
  root: string,
  scenario: M3SupervisorScenario,
): Promise<M3OwnedExecution> {
  const fixture = await syntheticCodex(scenario === "hold" ? "term-resistant" : "success");
  const adapter = new CodexRuntimeAdapter({
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    executable: fixture.executable,
    authDirectory: fixture.authDirectory,
  });
  return runtimeExecution({
    adapter,
    workspace: fixture.workspace,
    ready:
      scenario === "hold"
        ? async () => {
            let pids: WorkerRecord | null = null;
            await waitForCondition("Codex execution probe", async () => {
              pids = await nativePids(fixture.root);
              return pids !== null;
            });
            if (pids === null) {
              throw new Error("Codex execution probe is missing after readiness");
            }
            await recordProbe(root, pids);
          }
        : undefined,
    dispose: fixture.dispose,
  });
}

async function claudeCodeExecution(
  root: string,
  scenario: M3SupervisorScenario,
): Promise<M3OwnedExecution> {
  const fixture = await syntheticClaudeCode(scenario === "hold" ? "term-resistant" : "success");
  const adapter = new ClaudeCodeRuntimeAdapter({
    provider: "anthropic",
    model: "claude-opus-4-8",
    authSource: "subscription",
    testing: { executable: fixture.executable, environment: { PATH: process.env.PATH } },
  });
  return runtimeExecution({
    adapter,
    workspace: fixture.root,
    ready:
      scenario === "hold"
        ? async () => {
            let pids: WorkerRecord | null = null;
            await waitForCondition("Claude Code execution probe", async () => {
              pids = await nativePids(fixture.root);
              return pids !== null;
            });
            if (pids === null) {
              throw new Error("Claude Code execution probe is missing after readiness");
            }
            await recordProbe(root, pids);
          }
        : undefined,
    dispose: fixture.dispose,
  });
}

function collectOutput(child: ChildProcess): Promise<Buffer> {
  if (!child.stdout) {
    throw new Error("Command fixture stdout is unavailable");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= 4_096) {
      chunks.push(Buffer.from(chunk));
    }
  });
  return once(child, "close").then(() => {
    if (size > 4_096) {
      throw new Error("Command fixture exceeded its output bound");
    }
    return Buffer.concat(chunks);
  });
}

async function commandExecution(
  root: string,
  scenario: M3SupervisorScenario,
): Promise<M3OwnedExecution> {
  const child = spawn(
    process.execPath,
    [testingProgram("m3-protocol-command.mjs"), scenario === "hold" ? "hold" : "success"],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.pid === undefined) {
    throw new Error("Command fixture has no PID");
  }
  const events: RuntimeEvent[] = [{ type: "started" }];
  let cancelled = false;
  if (scenario === "hold") {
    let worker: WorkerRecord | null = null;
    await waitForCondition("command execution probe", async () => {
      worker = await readM3Record<WorkerRecord>(root, "worker.json");
      return worker !== null;
    });
    if (worker === null) {
      throw new Error("Command execution probe is missing after readiness");
    }
    await recordProbe(root, worker);
  }
  const output = collectOutput(child);
  const result = output.then((bytes): ExecutionResult => {
    const terminal: ExecutionResult = cancelled
      ? { status: "cancelled", reason: "Command cancelled by supervisor" }
      : { status: "succeeded", output: JSON.parse(bytes.toString("utf8")) as JsonValue };
    events.push({ type: "completed", status: terminal.status });
    return terminal;
  });
  const leader =
    scenario === "hold" ? await requiredIdentity(child.pid, "Command leader") : undefined;
  return {
    events,
    result,
    cancel: async () => {
      if (!cancelled) {
        cancelled = true;
        if (leader && (await matchesLiveProcess(leader))) {
          await terminateObservedGroup(leader);
        }
      }
      await result;
    },
  };
}

/** Start one current owner behind the shared supervisor boundary without a provider call. */
export async function startM3OwnedExecution(
  root: string,
  owner: M3SupervisorOwner,
  scenario: M3SupervisorScenario,
): Promise<M3OwnedExecution> {
  await writeM3Record(root, "side-effect.json", { owner, scenario });
  if (owner === "pi") {
    return piExecution(root, scenario);
  }
  if (owner === "codex") {
    return codexExecution(root, scenario);
  }
  if (owner === "claude-code") {
    return claudeCodeExecution(root, scenario);
  }
  return commandExecution(root, scenario);
}
