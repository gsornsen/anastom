import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalExistingRoot } from "@anastom/path-policy";
import type { ExecutionResult } from "@anastom/runtime-contract";
import {
  M3_SUPERVISOR_CONNECTION_TIMEOUT_MS,
  M3_SUPERVISOR_SOCKET,
  M3_SUPERVISOR_VERSION,
  assertM3AttemptPlan,
  assertM3StartAuthority,
  assertM3SupervisorRequest,
  encodeM3Frame,
  m3CapabilityDigest,
  m3ProtocolDigest,
  matchesM3Capability,
  protectM3SupervisorSocket,
  readM3Frame,
  type M3AttemptPlan,
  type M3ExecutionManifest,
  type M3ExecutionTerminal,
  type M3StartAuthority,
  type M3SupervisorRequest,
  type M3SupervisorResponse,
} from "../m3-supervisor-protocol.js";
import {
  inspectProcess,
  isLiveProcess,
  localBootIdentityDigest,
  matchesLiveProcess,
  waitForCondition,
} from "../m3-process-identity.js";
import { startM3OwnedExecution, type M3OwnedExecution } from "./m3-owned-execution.js";
import { readM3Record, writeM3Record } from "./m3-records.js";

const root = await canonicalExistingRoot(".");
const rawPlan = await readM3Record<unknown>(root, "attempt-plan.json");
assertM3AttemptPlan(rawPlan);
const plan: M3AttemptPlan = rawPlan;
if (
  plan.bootIdentityDigest !== (await localBootIdentityDigest()) ||
  !(await matchesLiveProcess(plan.coordinator))
) {
  throw new Error("M3 supervisor owner identity is unavailable");
}

const supervisor = await inspectProcess(process.pid);
if (!isLiveProcess(supervisor)) {
  throw new Error("M3 supervisor identity is unavailable");
}
const supervisorIdentity = supervisor;
const capability = randomBytes(32).toString("base64url");
const planDigest = m3ProtocolDigest(plan);
let manifest: M3ExecutionManifest = {
  version: M3_SUPERVISOR_VERSION,
  runId: plan.runId,
  executionId: plan.executionId,
  fence: plan.fence,
  owner: plan.owner,
  bootIdentityDigest: plan.bootIdentityDigest,
  planDigest,
  capabilityDigest: m3CapabilityDigest(capability),
  socketName: M3_SUPERVISOR_SOCKET,
  supervisor: supervisorIdentity,
  state: "awaiting-start",
};
let execution: M3OwnedExecution | undefined;
let start: Promise<M3OwnedExecution> | undefined;
let terminal: M3ExecutionTerminal | undefined;
let terminalWrite: Promise<M3ExecutionTerminal> | undefined;
let executionSettled: Promise<M3ExecutionTerminal> | undefined;
let shuttingDown = false;
let finish!: () => void;
const finished = new Promise<void>((resolve) => {
  finish = resolve;
});

async function publishManifest(state: M3ExecutionManifest["state"]): Promise<void> {
  manifest = { ...manifest, state };
  await writeM3Record(root, "execution-manifest.json", manifest);
}

function terminalFailure(): ExecutionResult {
  return {
    status: "failed",
    failure: {
      category: "runtime-unavailable",
      message: "Supervisor could not confirm execution cleanup",
    },
  };
}

function publishTerminal(
  result: ExecutionResult,
  cleanup: M3ExecutionTerminal["cleanup"],
): Promise<M3ExecutionTerminal> {
  return (terminalWrite ??= (async () => {
    const record: M3ExecutionTerminal = {
      version: M3_SUPERVISOR_VERSION,
      executionId: plan.executionId,
      fence: plan.fence,
      owner: plan.owner,
      events: structuredClone(execution?.events ?? []),
      result: structuredClone(result),
      cleanup,
    };
    encodeM3Frame(record);
    await writeM3Record(root, "execution-terminal.json", record);
    terminal = record;
    await publishManifest("terminal");
    return record;
  })());
}

async function readAuthority(): Promise<M3StartAuthority> {
  const value = await readM3Record<unknown>(root, "start-authority.json");
  assertM3StartAuthority(value);
  if (
    value.executionId !== plan.executionId ||
    value.fence !== plan.fence ||
    value.planDigest !== planDigest ||
    value.capabilityDigest !== manifest.capabilityDigest ||
    value.supervisor.pid !== supervisorIdentity.pid ||
    value.supervisor.processGroupId !== supervisorIdentity.processGroupId ||
    value.supervisor.startToken !== supervisorIdentity.startToken
  ) {
    throw new Error("M3 start authority does not match the supervisor manifest");
  }
  return value;
}

async function authorizeExecution(): Promise<M3OwnedExecution> {
  return (start ??= (async () => {
    if (manifest.state !== "awaiting-start") {
      if (!execution) {
        throw new Error("M3 execution state is inconsistent");
      }
      return execution;
    }
    await readAuthority();
    if ((await readM3Record(root, "side-effect.json")) !== null) {
      throw new Error("M3 execution side effect preceded authorization");
    }
    await publishManifest("starting");
    if (plan.scenario === "start-gated") {
      await waitForCondition(
        "M3 start-window release",
        async () => (await readM3Record(root, "start-release.json")) !== null,
        15_000,
      );
    }
    const owned = await startM3OwnedExecution(root, plan.owner, plan.scenario);
    execution = owned;
    await publishManifest("active");
    executionSettled = owned.result.then(
      (result) => publishTerminal(result, "confirmed"),
      () => publishTerminal(terminalFailure(), "unknown"),
    );
    return owned;
  })());
}

async function cancelExecution(): Promise<M3ExecutionTerminal> {
  if (manifest.state === "awaiting-start" || !execution) {
    throw new Error("M3 execution has not started");
  }
  if (terminal) {
    return terminal;
  }
  try {
    await execution.cancel();
  } catch {
    return publishTerminal(terminalFailure(), "unknown");
  }
  if (!executionSettled) {
    throw new Error("M3 execution settlement is unavailable");
  }
  return executionSettled;
}

function authenticate(request: M3SupervisorRequest): boolean {
  return (
    request.executionId === plan.executionId &&
    request.fence === plan.fence &&
    matchesM3Capability(request.capability, capability)
  );
}

async function dispatch(request: M3SupervisorRequest): Promise<M3SupervisorResponse> {
  if (!authenticate(request)) {
    return { ok: false, category: "unauthorized", message: "Supervisor request rejected" };
  }
  if (request.operation === "authorize") {
    await authorizeExecution();
    return { ok: true, operation: request.operation, state: manifest.state };
  }
  if (request.operation === "inspect") {
    return {
      ok: true,
      operation: request.operation,
      state: manifest.state,
      ...(terminal ? { terminal } : {}),
    };
  }
  if (request.operation === "collect") {
    if (!executionSettled) {
      return {
        ok: false,
        category: "invalid-state",
        message: "Execution has not started",
      };
    }
    const record = await executionSettled;
    return { ok: true, operation: request.operation, state: manifest.state, terminal: record };
  }
  if (request.operation === "cancel") {
    const record = await cancelExecution();
    return { ok: true, operation: request.operation, state: manifest.state, terminal: record };
  }
  if (manifest.state !== "terminal") {
    return { ok: false, category: "invalid-state", message: "Execution is not terminal" };
  }
  return { ok: true, operation: request.operation, state: manifest.state, terminal };
}

function send(socket: Socket, response: M3SupervisorResponse, after?: () => void): void {
  if (socket.destroyed) {
    after?.();
    return;
  }
  socket.end(encodeM3Frame(response), () => {
    socket.destroy();
    after?.();
  });
}

async function handle(socket: Socket): Promise<void> {
  let request: M3SupervisorRequest;
  try {
    const value = await readM3Frame(socket);
    assertM3SupervisorRequest(value);
    request = value;
  } catch {
    send(socket, {
      ok: false,
      category: "invalid-request",
      message: "Supervisor request was invalid",
    });
    return;
  }
  try {
    const response = await dispatch(request);
    send(
      socket,
      response,
      request.operation === "release" && response.ok ? () => void shutdown() : undefined,
    );
  } catch {
    send(socket, {
      ok: false,
      category: "internal",
      message: "Supervisor request could not be completed",
    });
  }
}

const sockets = new Set<Socket>();
const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
  sockets.add(socket);
  socket.setTimeout(M3_SUPERVISOR_CONNECTION_TIMEOUT_MS, () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
  void handle(socket);
});
server.on("error", () => {
  void shutdown();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(join(root, M3_SUPERVISOR_SOCKET), resolve);
});
await protectM3SupervisorSocket(root);
await writeM3Record(root, "execution-control.json", {
  version: M3_SUPERVISOR_VERSION,
  executionId: plan.executionId,
  capability,
});
await publishManifest("awaiting-start");

async function closeServer(): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await rm(join(root, M3_SUPERVISOR_SOCKET), { force: true });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (manifest.state === "starting" && start) {
    await start.catch(() => undefined);
  }
  if (execution && !terminal) {
    await cancelExecution();
  }
  await closeServer();
  process.stdin.pause();
  finish();
}

async function watchCoordinator(): Promise<void> {
  while (!shuttingDown) {
    if (!(await matchesLiveProcess(plan.coordinator))) {
      await shutdown();
      return;
    }
    await delay(25);
  }
}

process.stdin.resume();
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());
void watchCoordinator();
await finished;
