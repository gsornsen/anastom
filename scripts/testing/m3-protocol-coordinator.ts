import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalExistingRoot } from "@anastom/path-policy";
import {
  M3_SUPERVISOR_VERSION,
  m3ProtocolDigest,
  readM3ExecutionControl,
  readM3ExecutionManifest,
  requestM3Supervisor,
  type M3AttemptPlan,
  type M3StartAuthority,
  type M3SupervisorOwner,
  type M3SupervisorScenario,
} from "../m3-supervisor-protocol.js";
import {
  inspectProcess,
  isLiveProcess,
  localBootIdentityDigest,
  waitForCondition,
} from "../m3-process-identity.js";
import { readM3Record, writeM3Record } from "./m3-records.js";

function testingProgram(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

function repositoryProgram(name: string): string {
  return fileURLToPath(new URL(`../../${name}`, import.meta.url));
}

const [ownerValue, scenarioValue] = process.argv.slice(2);
if (
  !["pi", "codex", "claude-code", "command"].includes(ownerValue ?? "") ||
  !["success", "hold", "start-gated"].includes(scenarioValue ?? "")
) {
  throw new Error("Usage: m3-protocol-coordinator.ts <owner> <success|hold|start-gated>");
}
const owner = ownerValue as M3SupervisorOwner;
const scenario = scenarioValue as M3SupervisorScenario;
const root = await canonicalExistingRoot(".");
const coordinator = await inspectProcess(process.pid);
if (!isLiveProcess(coordinator)) {
  throw new Error("Protocol coordinator identity is unavailable");
}
const plan: M3AttemptPlan = {
  version: M3_SUPERVISOR_VERSION,
  runId: `probe-${randomUUID()}`,
  executionId: randomUUID(),
  fence: 7,
  owner,
  scenario,
  coordinator,
  bootIdentityDigest: await localBootIdentityDigest(),
};
await writeM3Record(root, "attempt-plan.json", plan);

const supervisor = spawn(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("tsx/cli")),
    "--tsconfig",
    repositoryProgram("tsconfig.json"),
    testingProgram("m3-protocol-supervisor.ts"),
  ],
  { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"] },
);
let supervisorError = "";
supervisor.stderr.on("data", (chunk: Buffer) => {
  if (supervisorError.length < 65_536) {
    supervisorError += chunk.toString("utf8", 0, Math.max(0, 65_536 - supervisorError.length));
  }
});

try {
  await waitForCondition(
    "supervisor manifest",
    async () =>
      (await readM3Record(root, "execution-manifest.json")) !== null ||
      supervisor.exitCode !== null ||
      supervisor.signalCode !== null,
    10_000,
  );
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
    throw new Error(`Supervisor exited before its handshake: ${supervisorError.trim()}`);
  }
  const [manifest, control] = await Promise.all([
    readM3ExecutionManifest(root),
    readM3ExecutionControl(root),
  ]);
  if (
    manifest.state !== "awaiting-start" ||
    manifest.executionId !== plan.executionId ||
    manifest.fence !== plan.fence ||
    manifest.planDigest !== m3ProtocolDigest(plan) ||
    control.executionId !== plan.executionId
  ) {
    throw new Error("Supervisor handshake does not match the durable attempt plan");
  }
  const sideEffectBeforeAuthorization = (await readM3Record(root, "side-effect.json")) !== null;
  if (sideEffectBeforeAuthorization) {
    throw new Error("Supervisor started execution before durable authorization");
  }
  const authority: M3StartAuthority = {
    version: M3_SUPERVISOR_VERSION,
    executionId: plan.executionId,
    fence: plan.fence,
    planDigest: manifest.planDigest,
    capabilityDigest: manifest.capabilityDigest,
    supervisor: manifest.supervisor,
  };
  await writeM3Record(root, "start-authority.json", authority);
  const authorized = await requestM3Supervisor(root, {
    version: M3_SUPERVISOR_VERSION,
    operation: "authorize",
    executionId: plan.executionId,
    fence: plan.fence,
    capability: control.capability,
  });
  if (!authorized.ok) {
    throw new Error("Supervisor rejected durable start authorization");
  }
  await writeM3Record(root, "protocol-coordinator.json", {
    coordinator,
    executionId: plan.executionId,
    fence: plan.fence,
    owner,
    scenario,
    supervisor: manifest.supervisor,
    sideEffectBeforeAuthorization,
  });

  if (scenario === "success") {
    const collected = await requestM3Supervisor(root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "collect",
      executionId: plan.executionId,
      fence: plan.fence,
      capability: control.capability,
    });
    if (!collected.ok || !collected.terminal) {
      throw new Error("Supervisor did not return a terminal result");
    }
    await writeM3Record(root, "protocol-terminal.json", collected.terminal);
    const released = await requestM3Supervisor(root, {
      version: M3_SUPERVISOR_VERSION,
      operation: "release",
      executionId: plan.executionId,
      fence: plan.fence,
      capability: control.capability,
    });
    if (!released.ok) {
      throw new Error("Supervisor rejected terminal release");
    }
    await waitForCondition(
      "released supervisor launcher exit",
      async () => supervisor.exitCode !== null || supervisor.signalCode !== null,
      10_000,
    );
  } else {
    await new Promise<void>(() => {});
  }
} catch (error) {
  throw new Error(`M3 protocol coordinator failed: ${supervisorError.trim() || "no diagnostic"}`, {
    cause: error,
  });
}
