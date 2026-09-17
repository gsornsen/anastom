import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalCommandExecutor } from "@anastom/engine";
import { canonicalExistingRoot } from "@anastom/path-policy";
import { PiRuntimeAdapter, type PiSessionFactory } from "@anastom/runtime-pi";
import { CodexRuntimeAdapter } from "@anastom/runtime-codex";
import { ClaudeCodeRuntimeAdapter } from "@anastom/runtime-claude-code";
import { conformanceRequest } from "../../packages/runtime-contract/src/testing/conformance.js";
import { syntheticCodex } from "../../packages/runtime-codex/src/testing/fixture.js";
import { syntheticClaudeCode } from "../../packages/runtime-claude-code/src/testing/fixture.js";
import {
  inspectProcess,
  isLiveProcess,
  waitForCondition,
  type ProcessIdentity,
} from "../m3-process-identity.js";
import { readM3Record, writeM3Record } from "./m3-records.js";

type Owner = "pi" | "codex" | "claude-code" | "command" | "supervised";

interface RuntimeRecord {
  owner: Owner;
  coordinator: ProcessIdentity;
  execution: ProcessIdentity;
  descendant: ProcessIdentity;
  fixtureRoot: string;
  handleId?: string;
  supervisor?: ProcessIdentity;
}

interface WorkerRecord {
  leaderPid: number;
  descendantPid: number;
}

function testingProgram(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

function repositoryProgram(name: string): string {
  return fileURLToPath(new URL(`../../${name}`, import.meta.url));
}

async function requiredIdentity(pid: number, name: string): Promise<ProcessIdentity> {
  const identity = await inspectProcess(pid);
  if (!isLiveProcess(identity)) {
    throw new Error(`${name} process identity is not live`);
  }
  return identity;
}

async function writeRecord(
  root: string,
  record: Omit<RuntimeRecord, "coordinator">,
): Promise<void> {
  await writeM3Record(root, "record.json", {
    ...record,
    coordinator: await requiredIdentity(process.pid, "Coordinator"),
  });
}

async function nativePids(root: string): Promise<WorkerRecord | null> {
  const entry = (await readdir(root)).find((name) => /^entry-\d+\.json$/.test(name));
  let child: number | null = null;
  try {
    const value = await readFile(join(root, "child-pid"), "utf8");
    if (/^[1-9]\d*$/.test(value)) {
      child = Number(value);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  if (!entry || child === null) {
    return null;
  }
  return { leaderPid: Number(entry.slice(6, -5)), descendantPid: child };
}

async function codex(root: string): Promise<void> {
  const fixture = await syntheticCodex("term-resistant");
  const runtime = new CodexRuntimeAdapter({
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    executable: fixture.executable,
    authDirectory: fixture.authDirectory,
  });
  const handle = await runtime.start(conformanceRequest(fixture.workspace));
  await waitForCondition(
    "Codex process-double readiness",
    async () => (await nativePids(fixture.root)) !== null,
  );
  const pids = await nativePids(fixture.root);
  if (pids === null) {
    throw new Error("Codex process-double identities are missing");
  }
  await writeRecord(root, {
    owner: "codex",
    execution: await requiredIdentity(pids.leaderPid, "Codex"),
    descendant: await requiredIdentity(pids.descendantPid, "Codex descendant"),
    fixtureRoot: fixture.root,
    handleId: handle.id,
  });
}

async function claudeCode(root: string): Promise<void> {
  const fixture = await syntheticClaudeCode("term-resistant");
  const runtime = new ClaudeCodeRuntimeAdapter({
    provider: "anthropic",
    model: "claude-opus-4-8",
    authSource: "subscription",
    testing: { executable: fixture.executable, environment: { PATH: process.env.PATH } },
  });
  const handle = await runtime.start(conformanceRequest(fixture.root));
  await waitForCondition(
    "Claude Code process-double readiness",
    async () => (await nativePids(fixture.root)) !== null,
  );
  const pids = await nativePids(fixture.root);
  if (pids === null) {
    throw new Error("Claude Code process-double identities are missing");
  }
  await writeRecord(root, {
    owner: "claude-code",
    execution: await requiredIdentity(pids.leaderPid, "Claude Code"),
    descendant: await requiredIdentity(pids.descendantPid, "Claude Code descendant"),
    fixtureRoot: fixture.root,
    handleId: handle.id,
  });
}

async function pi(root: string): Promise<void> {
  let descendantPid: number | undefined;
  const factory: PiSessionFactory = async () => {
    const descendant = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    descendantPid = descendant.pid;
    return {
      identity: { provider: "fixture", model: "fixture" },
      subscribe: () => () => {},
      prompt: () => new Promise<void>(() => {}),
      finalMessage: () => undefined,
      abort: async () => {},
      dispose: () => {},
    };
  };
  const runtime = new PiRuntimeAdapter({ factory });
  const handle = await runtime.start(conformanceRequest(root));
  await waitForCondition("Pi descendant readiness", async () => descendantPid !== undefined);
  await writeRecord(root, {
    owner: "pi",
    execution: await requiredIdentity(process.pid, "Pi in-process execution"),
    descendant: await requiredIdentity(descendantPid as number, "Pi descendant"),
    fixtureRoot: root,
    handleId: handle.id,
  });
}

async function command(root: string): Promise<void> {
  const execution = new LocalCommandExecutor().execute(
    {
      argv: [process.execPath, testingProgram("m3-attempt-worker.mjs"), "hold"],
      cwd: ".",
      maxDurationMs: 30_000,
      maxOutputBytes: 4_096,
    },
    { id: "m3-command", mode: "readonly", path: root, repoRoot: root, baseCommit: "fixture" },
  );
  void execution;
  await waitForCondition(
    "command process readiness",
    async () => (await readM3Record<WorkerRecord>(root, "worker.json")) !== null,
  );
  const pids = await readM3Record<WorkerRecord>(root, "worker.json");
  if (pids === null) {
    throw new Error("Command process identities are missing");
  }
  await writeRecord(root, {
    owner: "command",
    execution: await requiredIdentity(pids.leaderPid, "Command"),
    descendant: await requiredIdentity(pids.descendantPid, "Command descendant"),
    fixtureRoot: root,
  });
}

async function supervised(root: string): Promise<ChildProcessWithoutNullStreams> {
  await writeM3Record(
    root,
    "supervisor-owner.json",
    await requiredIdentity(process.pid, "Supervisor owner"),
  );
  const supervisor = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      "--tsconfig",
      repositoryProgram("tsconfig.json"),
      testingProgram("m3-attempt-supervisor.ts"),
    ],
    { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  await waitForCondition(
    "supervisor readiness",
    async () =>
      (await readM3Record<Omit<RuntimeRecord, "owner" | "coordinator" | "fixtureRoot">>(
        root,
        "supervisor-ready.json",
      )) !== null,
  );
  const ready = await readM3Record<{
    supervisor: ProcessIdentity;
    execution: ProcessIdentity;
    descendant: ProcessIdentity;
  }>(root, "supervisor-ready.json");
  if (ready === null) {
    throw new Error("Supervisor identities are missing");
  }
  await writeRecord(root, {
    owner: "supervised",
    execution: ready.execution,
    descendant: ready.descendant,
    supervisor: ready.supervisor,
    fixtureRoot: root,
  });
  return supervisor;
}

const [ownerValue] = process.argv.slice(2);
if (!["pi", "codex", "claude-code", "command", "supervised"].includes(ownerValue ?? "")) {
  throw new Error("Usage: m3-runtime-coordinator.ts <owner>");
}
const owner = ownerValue as Owner;
const root = await canonicalExistingRoot(".");
let supervisedProcess: ChildProcessWithoutNullStreams | undefined;
if (owner === "pi") {
  await pi(root);
} else if (owner === "codex") {
  await codex(root);
} else if (owner === "claude-code") {
  await claudeCode(root);
} else if (owner === "command") {
  await command(root);
} else {
  supervisedProcess = await supervised(root);
}
void supervisedProcess;
await new Promise<void>(() => {});
