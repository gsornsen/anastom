import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import { canonicalJson, digestBytes } from "@anastom/core";
import {
  assertPersistedExecutionRef,
  assertPrepareExecution,
  type CommandExecution,
  type PrepareExecution,
} from "@anastom/engine";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
import type { ExecutionResult, RuntimeEvent } from "@anastom/runtime-contract";

import {
  EXECUTION_CONNECTION_TIMEOUT_MS,
  EXECUTION_LAUNCH_FRAME_MAX_BYTES,
  EXECUTION_PRIVATE_RECORD_MAX_BYTES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_READY_FRAME_MAX_BYTES,
  EXECUTION_SOCKET_FRAME_MAX_BYTES,
  EXECUTION_TERMINAL_MAX_BYTES,
  EXECUTION_TERMINATION_GRACE_MS,
  EXECUTION_TERMINATION_TIMEOUT_MS,
  FrameDecoder,
  assertExecutionPlanRecord,
  assertExecutionStartAuthority,
  assertRuntimeHostOutput,
  assertRuntimeHostReady,
  assertSupervisorRequest,
  commandExecutionToRecord,
  encodeFrame,
  executionCapabilityDigest,
  executionManifestDigest,
  matchesExecutionCapability,
  readEndedFrame,
  readInitialFrame,
  readRecord,
  writeRecordAtomic,
  writeRecordExclusive,
  type ExecutionControlRecord,
  type ExecutionManifestRecord,
  type ExecutionManifestState,
  type ExecutionTerminalRecord,
  type RuntimeHostOutput,
  type SupervisorRequest,
  type SupervisorResponse,
} from "./protocol.js";
import {
  inspectPrivateProcess,
  liveProcessGroup,
  observeLocalProcess,
  terminatePrivateProcessGroup,
  type PrivateProcessIdentity,
} from "./process.js";

interface RuntimeHostCommand {
  executable: string;
  args: string[];
}

interface SupervisorLaunch {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  prepare: PrepareExecution;
  runtimeHost: RuntimeHostCommand;
}

interface RetainedEvent {
  ordinal: number;
  event: RuntimeEvent;
}

const TRUNCATED_LOG_MESSAGE = "Execution logs were truncated by the supervisor";

const [statePath, runId, executionId, socketRootPath, socketDirectory, socketName] =
  process.argv.slice(2);
if (!statePath || !runId || !executionId || !socketRootPath || !socketDirectory || !socketName) {
  throw new Error("Execution supervisor requires fixed state and socket coordinates");
}

const stateRoot = await ensurePrivatePathRoot(statePath);
const socketRoot = await ensurePrivatePathRoot(socketRootPath);
const recordSegments = ["runs", runId, "executions", executionId] as const;
const record = (name: string) => [...recordSegments, name];
const endpoint = socketRoot.socketPath([socketDirectory, socketName], { maxBytes: 100 });
const rawLaunch = await readInitialFrame(process.stdin, EXECUTION_LAUNCH_FRAME_MAX_BYTES);
const launch = rawLaunch as SupervisorLaunch;
assertSupervisorLaunch(launch);
const planRecord = await readRecord(
  stateRoot,
  record("plan.json"),
  EXECUTION_PRIVATE_RECORD_MAX_BYTES,
  assertExecutionPlanRecord,
);
if (
  canonicalJson(planRecord.plan) !== canonicalJson(launch.prepare.plan) ||
  canonicalJson(planRecord.coordinator) !== canonicalJson(launch.prepare.coordinator)
) {
  throw new Error("Execution launch does not match its persisted plan identity");
}
const coordinator = await observeLocalProcess(planRecord.coordinator);
if (coordinator.state !== "alive") {
  throw new Error("Execution coordinator is not live on this host and boot");
}
const supervisor = await inspectPrivateProcess(process.pid);
if (!supervisor) {
  throw new Error("Execution supervisor identity is unavailable");
}
const capability = randomBytes(32).toString("base64url");
const control: ExecutionControlRecord = {
  version: EXECUTION_PROTOCOL_VERSION,
  executionId: planRecord.plan.executionId,
  generation: planRecord.plan.generation,
  capability,
  endpoint,
};
let manifest: ExecutionManifestRecord = {
  version: EXECUTION_PROTOCOL_VERSION,
  plan: planRecord.plan,
  capabilityDigest: executionCapabilityDigest(capability),
  controlDigest: digestBytes(canonicalJson(control)),
  supervisor,
  state: "awaiting-start",
};
let executionLeader: PrivateProcessIdentity | undefined;
let executionExited: Promise<[number | null, NodeJS.Signals | null]> | undefined;
let executionSettlement: Promise<ExecutionTerminalRecord> | undefined;
let terminal: ExecutionTerminalRecord | undefined;
let terminalPublication: Promise<ExecutionTerminalRecord> | undefined;
let starting: Promise<void> | undefined;
let stopping = false;
let ordinal = 0;
let droppedLogs = 0;
let terminationRequested = false;
let terminationCleanup: Promise<boolean> | undefined;
const events: RetainedEvent[] = [];
const sockets = new Set<Socket>();
const queuedSockets: Socket[] = [];
let activeSocket = false;
let resolveFinished!: () => void;
const finished = new Promise<void>((resolve) => {
  resolveFinished = resolve;
});

function assertSupervisorLaunch(value: SupervisorLaunch): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "prepare,runtimeHost,version" ||
    value.version !== EXECUTION_PROTOCOL_VERSION ||
    !value.runtimeHost ||
    typeof value.runtimeHost !== "object" ||
    Object.keys(value.runtimeHost).sort().join(",") !== "args,executable" ||
    typeof value.runtimeHost.executable !== "string" ||
    !value.runtimeHost.executable ||
    value.runtimeHost.executable.includes("\0") ||
    !Array.isArray(value.runtimeHost.args) ||
    value.runtimeHost.args.length > 32 ||
    value.runtimeHost.args.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    )
  ) {
    throw new TypeError("Invalid execution-supervisor launch frame");
  }
  assertPrepareExecution(value.prepare);
}

async function publishManifest(state: ExecutionManifestState): Promise<void> {
  manifest = { ...manifest, state };
  await writeRecordAtomic(
    stateRoot,
    record("manifest.json"),
    manifest,
    EXECUTION_PRIVATE_RECORD_MAX_BYTES,
  );
}

function appendEvent(event: RuntimeEvent): void {
  if (event.type === "completed") {
    flushDroppedLogs();
  }
  const retained = structuredClone(event);
  if (retained.type === "log" && droppedLogs > 0) {
    retained.droppedLogs = (retained.droppedLogs ?? 0) + droppedLogs;
    droppedLogs = 0;
  }
  events.push({ ordinal: ++ordinal, event: retained });
  trimEvents();
}

function trimEvents(): void {
  if (events.filter((value) => value.event.type !== "log").length > 16) {
    events.pop();
    throw new Error("Runtime emitted too many required non-log observations");
  }
  while (
    events.length > 256 ||
    Buffer.byteLength(canonicalJson(events.map((value) => value.event))) >
      EXECUTION_SOCKET_FRAME_MAX_BYTES / 2
  ) {
    const index = events.findIndex((value) => value.event.type === "log");
    if (index < 0) {
      events.pop();
      throw new Error("Non-log runtime observations exceeded the supervisor bound");
    }
    const [removed] = events.splice(index, 1);
    const removedCount = removed?.event.type === "log" ? (removed.event.droppedLogs ?? 0) + 1 : 1;
    const summary = events.find(
      (value) => value.event.type === "log" && value.event.message === TRUNCATED_LOG_MESSAGE,
    );
    if (summary?.event.type === "log") {
      summary.event.droppedLogs = (summary.event.droppedLogs ?? 0) + removedCount;
    } else {
      droppedLogs += removedCount;
    }
  }
}

function flushDroppedLogs(): void {
  if (droppedLogs < 1) {
    return;
  }
  events.push({
    ordinal: ++ordinal,
    event: {
      type: "log",
      message: TRUNCATED_LOG_MESSAGE,
      droppedLogs,
    },
  });
  droppedLogs = 0;
  trimEvents();
}

function failureResult(): ExecutionResult {
  return {
    status: "failed",
    failure: {
      category: "runtime-unavailable",
      message: "Execution host could not confirm worker cleanup",
    },
  };
}

function cancelledResult(): ExecutionResult {
  return {
    status: "cancelled",
    reason: "Execution cancelled by execution supervisor",
  };
}

function emptyCommandFailure(message: string): CommandExecution {
  return {
    output: {
      passed: false,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    failure: { category: "runtime-unavailable", message },
  };
}

async function executionGroupIsEmpty(): Promise<boolean> {
  if (terminationCleanup && (await terminationCleanup)) {
    return true;
  }
  return executionLeader
    ? (await liveProcessGroup(executionLeader.processGroupId)).length === 0
    : false;
}

function settlementFallback(expectedTermination: boolean): ExecutionTerminalRecord["result"] {
  if (planRecord.plan.kind === "runtime") {
    return {
      kind: "runtime",
      value: expectedTermination ? cancelledResult() : failureResult(),
    };
  }
  const message = expectedTermination
    ? "Command was terminated by the execution supervisor"
    : "Command host cleanup is unknown";
  return { kind: "command", value: commandExecutionToRecord(emptyCommandFailure(message)) };
}

function boundedTerminal(value: ExecutionTerminalRecord): ExecutionTerminalRecord {
  if (Buffer.byteLength(canonicalJson(value)) <= EXECUTION_TERMINAL_MAX_BYTES) {
    return value;
  }
  const compactEvents = value.events.filter((event) => event.type !== "log");
  const result =
    value.result.kind === "runtime"
      ? {
          kind: "runtime" as const,
          value: {
            status: "failed" as const,
            failure: {
              category: "schema-violation" as const,
              message: "Normalized execution result exceeded the terminal evidence limit",
            },
          },
        }
      : {
          kind: "command" as const,
          value: commandExecutionToRecord({
            ...emptyCommandFailure("Command result exceeded the terminal evidence limit"),
            output: {
              ...value.result.value.output,
              passed: false,
              stdoutTruncated: value.result.value.output.stdoutBytes > 0,
              stderrTruncated: value.result.value.output.stderrBytes > 0,
            },
            failure: {
              category: "schema-violation",
              message: "Command result exceeded the terminal evidence limit",
            },
          }),
        };
  const compact = { ...value, outcome: terminalOutcome(result), events: compactEvents, result };
  return Buffer.byteLength(canonicalJson(compact)) <= EXECUTION_TERMINAL_MAX_BYTES
    ? compact
    : { ...compact, events: [] };
}

async function publishTerminal(
  result: ExecutionTerminalRecord["result"],
  cleanup: ExecutionTerminalRecord["cleanup"],
): Promise<ExecutionTerminalRecord> {
  if (terminal) {
    return terminal;
  }
  return (terminalPublication ??= (async () => {
    flushDroppedLogs();
    const value = boundedTerminal({
      version: EXECUTION_PROTOCOL_VERSION,
      executionId: planRecord.plan.executionId,
      generation: planRecord.plan.generation,
      outcome: terminalOutcome(result),
      events: events.map((event) => structuredClone(event.event)),
      result,
      cleanup,
    });
    await writeRecordExclusive(
      stateRoot,
      record("terminal.json"),
      value,
      EXECUTION_TERMINAL_MAX_BYTES,
    );
    terminal = value;
    await publishManifest("terminal");
    return value;
  })());
}

function terminalOutcome(
  result: ExecutionTerminalRecord["result"],
): ExecutionTerminalRecord["outcome"] {
  if (terminationRequested) {
    return "cancelled";
  }
  if (result.kind === "command") {
    return result.value.output.passed ? "succeeded" : "failed";
  }
  return result.value.status;
}

async function readAuthority(): Promise<void> {
  const authority = await readRecord(
    stateRoot,
    record("start-authority.json"),
    EXECUTION_PRIVATE_RECORD_MAX_BYTES,
    assertExecutionStartAuthority,
  );
  assertPersistedExecutionRef(authority.execution, planRecord.plan);
  if (
    authority.execution.manifestDigest !== executionManifestDigest(manifest) ||
    authority.capabilityDigest !== manifest.capabilityDigest ||
    canonicalJson(authority.supervisor) !== canonicalJson(supervisor)
  ) {
    throw new Error("Start authority does not authenticate this supervisor");
  }
}

function childPipe(
  child: ChildProcess,
  descriptor: number,
): NodeJS.ReadableStream | NodeJS.WritableStream {
  const pipe = child.stdio[descriptor];
  if (!pipe || typeof pipe === "number") {
    throw new Error(`Runtime-host descriptor ${descriptor} is unavailable`);
  }
  return pipe;
}

async function startExecution(): Promise<void> {
  return (starting ??= (async () => {
    if (manifest.state === "active" || manifest.state === "terminal") {
      return;
    }
    if (manifest.state !== "awaiting-start") {
      throw new Error("Execution is not awaiting authorization");
    }
    await readAuthority();
    await publishManifest("starting");
    const child = spawn(launch.runtimeHost.executable, launch.runtimeHost.args, {
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    if (child.pid === undefined) {
      throw new Error("Runtime host did not expose a process identifier");
    }
    const leader = await inspectPrivateProcess(child.pid);
    if (!leader) {
      throw new Error("Runtime host identity is unavailable");
    }
    executionLeader = leader;
    executionExited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    const readyPipe = childPipe(child, 5) as Readable;
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        readEndedFrame(readyPipe, EXECUTION_READY_FRAME_MAX_BYTES),
        new Promise<never>((_resolve, reject) => {
          readinessTimer = setTimeout(
            () => reject(new Error("Runtime host readiness timed out")),
            EXECUTION_CONNECTION_TIMEOUT_MS,
          );
        }),
      ]);
      assertRuntimeHostReady(ready);
    } catch (error) {
      readyPipe.destroy();
      await terminatePrivateProcessGroup(leader, 1_000);
      await executionExited;
      const groupEmpty = (await liveProcessGroup(leader.processGroupId)).length === 0;
      const fallback =
        planRecord.plan.kind === "runtime"
          ? ({ kind: "runtime", value: failureResult() } as const)
          : ({
              kind: "command",
              value: commandExecutionToRecord(
                emptyCommandFailure("Command host failed before launch authorization"),
              ),
            } as const);
      await publishTerminal(fallback, groupEmpty ? "confirmed" : "unknown");
      throw new Error("Runtime host failed its pre-launch readiness handshake", { cause: error });
    } finally {
      if (readinessTimer) {
        clearTimeout(readinessTimer);
      }
    }
    if (stopping) {
      throw new Error("Execution supervisor is stopping");
    }
    await publishManifest("active");
    executionSettlement = settleExecution(childPipe(child, 4) as Readable, executionExited);
    const input = childPipe(child, 3) as Writable;
    input.end(encodeFrame(launch.prepare, EXECUTION_LAUNCH_FRAME_MAX_BYTES));
  })());
}

async function settleExecution(
  output: NodeJS.ReadableStream,
  exited: Promise<[number | null, NodeJS.Signals | null]>,
): Promise<ExecutionTerminalRecord> {
  const decoder = new FrameDecoder(EXECUTION_LAUNCH_FRAME_MAX_BYTES);
  let result: ExecutionTerminalRecord["result"] | undefined;
  let streamValid = true;
  try {
    for await (const chunk of output) {
      for (const raw of decoder.push(Buffer.from(chunk as Buffer))) {
        assertRuntimeHostOutput(raw);
        const value: RuntimeHostOutput = raw;
        if (value.type === "event") {
          appendEvent(value.event);
        } else if (result) {
          throw new Error("Runtime host emitted more than one terminal result");
        } else if (value.type === "runtime-result") {
          result = { kind: "runtime", value: value.result };
        } else {
          result = { kind: "command", value: value.result };
        }
      }
    }
    decoder.finish();
  } catch {
    streamValid = false;
  }
  const [exitCode] = await exited;
  if (!streamValid || exitCode !== 0) {
    result = undefined;
  }
  const groupEmpty = await executionGroupIsEmpty();
  const expectedTermination = terminationRequested && groupEmpty;
  const cleanup =
    expectedTermination || (streamValid && result && exitCode === 0 && groupEmpty)
      ? "confirmed"
      : "unknown";
  const fallback = settlementFallback(expectedTermination);
  return publishTerminal(result ?? fallback, cleanup);
}

async function terminateExecution(): Promise<ExecutionTerminalRecord> {
  terminationRequested = true;
  if (terminal) {
    return terminal;
  }
  if (manifest.state === "awaiting-start") {
    const result =
      planRecord.plan.kind === "runtime"
        ? ({
            kind: "runtime",
            value: { status: "cancelled", reason: "Execution cancelled before authorization" },
          } as const)
        : ({
            kind: "command",
            value: commandExecutionToRecord(
              emptyCommandFailure("Command cancelled before authorization"),
            ),
          } as const);
    return publishTerminal(result, "confirmed");
  }
  if (!executionLeader) {
    const fallback =
      planRecord.plan.kind === "runtime"
        ? ({ kind: "runtime", value: failureResult() } as const)
        : ({
            kind: "command",
            value: commandExecutionToRecord(emptyCommandFailure("Command cleanup is unknown")),
          } as const);
    return publishTerminal(fallback, "unknown");
  }
  terminationCleanup ??= terminatePrivateProcessGroup(
    executionLeader,
    EXECUTION_TERMINATION_GRACE_MS,
  );
  await terminationCleanup;
  if (executionSettlement) {
    return executionSettlement;
  }
  if (!executionExited) {
    const fallback =
      planRecord.plan.kind === "runtime"
        ? ({ kind: "runtime", value: failureResult() } as const)
        : ({
            kind: "command",
            value: commandExecutionToRecord(emptyCommandFailure("Command cleanup is unknown")),
          } as const);
    return publishTerminal(fallback, "unknown");
  }
  await executionExited;
  const groupEmpty = (await liveProcessGroup(executionLeader.processGroupId)).length === 0;
  const fallback =
    planRecord.plan.kind === "runtime"
      ? ({ kind: "runtime", value: failureResult() } as const)
      : ({
          kind: "command",
          value: commandExecutionToRecord(emptyCommandFailure("Command host was terminated")),
        } as const);
  return publishTerminal(fallback, groupEmpty ? "confirmed" : "unknown");
}

function authenticated(request: SupervisorRequest): boolean {
  return (
    request.executionId === planRecord.plan.executionId &&
    request.generation === planRecord.plan.generation &&
    matchesExecutionCapability(request.capability, capability)
  );
}

async function dispatch(request: SupervisorRequest): Promise<SupervisorResponse> {
  if (!authenticated(request)) {
    return { ok: false, category: "unauthorized", message: "Supervisor request rejected" };
  }
  if (request.operation === "authorize") {
    await startExecution();
  } else if (request.operation === "collect") {
    if (!executionSettlement) {
      return { ok: false, category: "invalid-state", message: "Execution is not active" };
    }
  } else if (request.operation === "terminate") {
    await terminateExecution();
  } else if (request.operation === "release" && !terminal) {
    return { ok: false, category: "invalid-state", message: "Execution is not terminal" };
  }
  if (request.operation === "events") {
    const cursor = request.cursor ?? 0;
    const retained = events.filter((value) => value.ordinal > cursor);
    return {
      ok: true,
      operation: request.operation,
      state: manifest.state,
      events: retained.map((value) => structuredClone(value.event)),
      nextCursor: retained.at(-1)?.ordinal ?? cursor,
      terminalAvailable: terminal !== undefined,
    };
  }
  return {
    ok: true,
    operation: request.operation,
    state: manifest.state,
    terminalAvailable: terminal !== undefined,
  };
}

function respond(socket: Socket, response: SupervisorResponse, after?: () => void): void {
  if (socket.destroyed) {
    after?.();
    return;
  }
  if (after) {
    socket.once("close", after);
  }
  socket.end(encodeFrame(response, EXECUTION_SOCKET_FRAME_MAX_BYTES));
}

async function handle(socket: Socket): Promise<void> {
  let request: SupervisorRequest;
  try {
    const value = await readEndedFrame(socket, EXECUTION_SOCKET_FRAME_MAX_BYTES);
    assertSupervisorRequest(value);
    request = value;
    socket.setTimeout(
      request.operation === "terminate"
        ? EXECUTION_TERMINATION_TIMEOUT_MS
        : EXECUTION_CONNECTION_TIMEOUT_MS,
    );
  } catch {
    respond(socket, {
      ok: false,
      category: "invalid-request",
      message: "Supervisor request was invalid",
    });
    return;
  }
  try {
    const response = await dispatch(request);
    const shouldRelease = request.operation === "release" && response.ok && !!terminal;
    respond(socket, response, shouldRelease ? () => void shutdown(false) : undefined);
  } catch {
    respond(socket, {
      ok: false,
      category: "internal",
      message: "Supervisor request could not be completed",
    });
  }
}

async function closeServer(): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(endpoint, { force: true });
}

async function shutdown(cleanExecution: boolean): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  if (cleanExecution && !terminal) {
    await terminateExecution().catch(() => undefined);
  }
  await closeServer();
  process.stdin.destroy();
  resolveFinished();
}

function serveNextSocket(): void {
  const socket = queuedSockets.shift();
  if (!socket) {
    activeSocket = false;
    return;
  }
  activeSocket = true;
  void handle(socket).finally(serveNextSocket);
}

const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
  if (activeSocket && queuedSockets.length >= 8) {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.setTimeout(EXECUTION_CONNECTION_TIMEOUT_MS, () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
  queuedSockets.push(socket);
  if (!activeSocket) {
    serveNextSocket();
  }
});
server.on("error", () => void shutdown(true));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen({ path: endpoint, backlog: 8 }, resolve);
});
await chmod(endpoint, 0o600);
await writeRecordExclusive(
  stateRoot,
  record("control.json"),
  control,
  EXECUTION_PRIVATE_RECORD_MAX_BYTES,
);
await publishManifest("awaiting-start");

const coordinatorClosed = () => {
  void (async () => {
    const observation = await observeLocalProcess(planRecord.coordinator);
    if (observation.state !== "alive") {
      await shutdown(true);
    }
  })();
};
process.stdin.once("end", coordinatorClosed);
process.stdin.once("close", coordinatorClosed);
process.stdin.on("data", () => void shutdown(true));

const watch = setInterval(() => {
  void (async () => {
    const observation = await observeLocalProcess(planRecord.coordinator);
    if (observation.state !== "alive") {
      await shutdown(true);
    }
  })();
}, 250);

await finished;
clearInterval(watch);
