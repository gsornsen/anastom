import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalCommandExecutor } from "@anastom/engine";
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

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
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
  await writeFile(
    join(root, "record.json"),
    JSON.stringify({ ...record, coordinator: await requiredIdentity(process.pid, "Coordinator") }),
    { mode: 0o600 },
  );
}

async function nativePids(root: string): Promise<WorkerRecord | null> {
  const entry = (await readdir(root)).find((name) => /^entry-\d+\.json$/.test(name));
  const child = await readJson<string | number>(join(root, "child-pid"));
  if (!entry || child === null) {
    return null;
  }
  return { leaderPid: Number(entry.slice(6, -5)), descendantPid: Number(child) };
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
    await writeFile(join(root, "pi-child-pid"), String(descendantPid), { mode: 0o600 });
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
  const workerRecordPath = join(root, "worker.json");
  const execution = new LocalCommandExecutor().execute(
    {
      argv: [process.execPath, testingProgram("m3-attempt-worker.mjs"), root, "hold"],
      cwd: ".",
      maxDurationMs: 30_000,
      maxOutputBytes: 4_096,
    },
    { id: "m3-command", mode: "readonly", path: root, repoRoot: root, baseCommit: "fixture" },
  );
  void execution;
  await waitForCondition(
    "command process readiness",
    async () => (await readJson<WorkerRecord>(workerRecordPath)) !== null,
  );
  const pids = await readJson<WorkerRecord>(workerRecordPath);
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
  await writeFile(
    join(root, "supervisor-owner.json"),
    JSON.stringify(await requiredIdentity(process.pid, "Supervisor owner")),
    { mode: 0o600 },
  );
  const supervisor = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      testingProgram("m3-attempt-supervisor.ts"),
      root,
      testingProgram("m3-attempt-worker.mjs"),
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  await waitForCondition(
    "supervisor readiness",
    async () =>
      (await readJson<Omit<RuntimeRecord, "owner" | "coordinator" | "fixtureRoot">>(
        join(root, "supervisor-ready.json"),
      )) !== null,
  );
  const ready = await readJson<{
    supervisor: ProcessIdentity;
    execution: ProcessIdentity;
    descendant: ProcessIdentity;
  }>(join(root, "supervisor-ready.json"));
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

const [ownerValue, root] = process.argv.slice(2);
if (!root || !["pi", "codex", "claude-code", "command", "supervised"].includes(ownerValue ?? "")) {
  throw new Error("Usage: m3-runtime-coordinator.ts <owner> <record-directory>");
}
const owner = ownerValue as Owner;
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
