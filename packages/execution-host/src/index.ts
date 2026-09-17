import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

import { canonicalJson, digestBytes } from "@anastom/core";
import {
  assertExecutionPlanRef,
  assertPersistedExecutionRef,
  assertPrepareExecution,
  type CommandExecution,
  type ExecutionHost,
  type ExecutionObservation,
  type ExecutionObservationReason,
  type ExecutionPlanRef,
  type OwnedExecution,
  type PersistedExecutionRef,
  type PrepareExecution,
} from "@anastom/engine";
import { ensurePrivatePathRoot, type PrivatePathRoot } from "@anastom/path-policy";
import type { ExecutionResult, RuntimeEvent } from "@anastom/runtime-contract";

import {
  EXECUTION_CONNECTION_TIMEOUT_MS,
  EXECUTION_LAUNCH_FRAME_MAX_BYTES,
  EXECUTION_PRIVATE_RECORD_MAX_BYTES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SOCKET_FRAME_MAX_BYTES,
  EXECUTION_TERMINAL_MAX_BYTES,
  EXECUTION_TERMINATION_TIMEOUT_MS,
  assertExecutionControlRecord,
  assertExecutionManifestRecord,
  assertExecutionPlanRecord,
  assertExecutionTerminalRecord,
  assertSupervisorResponse,
  commandExecutionFromRecord,
  encodeFrame,
  executionCapabilityDigest,
  executionManifestDigest,
  readEndedFrame,
  readRecord,
  writeRecordExclusive,
  type ExecutionControlRecord,
  type ExecutionManifestRecord,
  type ExecutionPlanRecord,
  type ExecutionTerminalRecord,
  type SupervisorOperation,
  type SupervisorRequest,
  type SupervisorResponse,
} from "./protocol.js";
import {
  inspectPrivateProcess,
  localProcessIdentity,
  matchesPrivateProcess,
  waitForCondition,
} from "./process.js";

export { localProcessIdentity, observeLocalProcess } from "./process.js";
export { runExecutionRuntimeHost } from "./runtime-host.js";

/** Checked-in hidden runtime-host executable selected by the trusted CLI composition root. */
interface RuntimeHostCommand {
  executable: string;
  args: readonly string[];
}

/** Private state and hidden runtime-host command used by the local execution supervisor. */
export interface LocalExecutionHostOptions {
  stateDir: string;
  runtimeHost: RuntimeHostCommand;
}

interface PreparedRecords {
  root: PrivatePathRoot;
  segments: readonly string[];
  planRecord: ExecutionPlanRecord;
  control: ExecutionControlRecord;
  manifest: ExecutionManifestRecord;
}

interface SupervisorCoordinates {
  statePath: string;
  plan: ExecutionPlanRef;
  runtimeRoot: string;
  socketDirectory: string;
  socketName: string;
}

type InspectionRecords =
  | { state: "loaded"; control: ExecutionControlRecord; manifest: ExecutionManifestRecord }
  | { state: "absent" }
  | { state: "invalid" };

type SupervisorPresence =
  { state: "live" | "absent" } | { state: "unknown"; reason: ExecutionObservationReason };

function currentUid(): number {
  if (!process.getuid) {
    throw new Error("Local execution supervision requires POSIX user identity");
  }
  return process.getuid();
}

function compactDigest(value: string): string {
  return Buffer.from(digestBytes(value).slice(7, 39), "hex").toString("base64url");
}

function compactUuid(value: string): string {
  return Buffer.from(value.replaceAll("-", ""), "hex").toString("base64url");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function planMatches(left: ExecutionPlanRef, right: ExecutionPlanRef): boolean {
  const plan = (value: ExecutionPlanRef): ExecutionPlanRef => ({
    version: value.version,
    runId: value.runId,
    executionId: value.executionId,
    kind: value.kind,
    generation: value.generation,
    planDigest: value.planDigest,
  });
  return canonicalJson(plan(left)) === canonicalJson(plan(right));
}

/** Shared POSIX execution host with two-phase authorization and authenticated local IPC. */
export class LocalExecutionHost implements ExecutionHost {
  private readonly options: LocalExecutionHostOptions;
  private readonly supervisors = new Map<string, ChildProcessWithoutNullStreams>();

  /** Bind private state and the trusted composition-root runtime-host executable. */
  constructor(options: LocalExecutionHostOptions) {
    if (
      typeof options.stateDir !== "string" ||
      !options.stateDir ||
      typeof options.runtimeHost.executable !== "string" ||
      !options.runtimeHost.executable ||
      options.runtimeHost.executable.includes("\0") ||
      options.runtimeHost.args.length > 32 ||
      options.runtimeHost.args.some(
        (argument) => typeof argument !== "string" || argument.includes("\0"),
      )
    ) {
      throw new TypeError("Invalid local execution-host configuration");
    }
    this.options = {
      stateDir: options.stateDir,
      runtimeHost: {
        executable: options.runtimeHost.executable,
        args: [...options.runtimeHost.args],
      },
    };
  }

  /** Publish the plan and awaiting-start supervisor identity without launching the worker. */
  async prepare(input: PrepareExecution): Promise<PersistedExecutionRef> {
    assertPrepareExecution(input);
    const state = await ensurePrivatePathRoot(this.options.stateDir);
    const segments = ["runs", input.plan.runId, "executions", input.plan.executionId] as const;
    await state.ensureDirectory(segments);
    const planRecord: ExecutionPlanRecord = {
      version: EXECUTION_PROTOCOL_VERSION,
      plan: structuredClone(input.plan),
      coordinator: structuredClone(input.coordinator),
    };
    await writeRecordExclusive(
      state,
      [...segments, "plan.json"],
      planRecord,
      EXECUTION_PRIVATE_RECORD_MAX_BYTES,
    );
    const existingManifest = await this.readOptionalRecord(
      state,
      [...segments, "manifest.json"],
      assertExecutionManifestRecord,
    );
    const existingControl = await this.readOptionalRecord(
      state,
      [...segments, "control.json"],
      assertExecutionControlRecord,
    );
    if (existingManifest || existingControl) {
      if (!existingManifest || !existingControl) {
        throw new Error("Execution preparation records are incomplete");
      }
      const records = await this.readPreparedRecords(input.plan, state, segments);
      if (canonicalJson(records.planRecord.coordinator) !== canonicalJson(input.coordinator)) {
        throw new Error("Existing execution preparation belongs to another coordinator");
      }
      return {
        ...structuredClone(input.plan),
        manifestDigest: executionManifestDigest(records.manifest),
      };
    }
    const runtimeRoot = await ensurePrivatePathRoot(`/tmp/anastom-${currentUid()}`);
    const socketDirectory = compactDigest(state.path);
    const socketName = `${compactUuid(input.plan.executionId)}.sock`;
    await runtimeRoot.ensureDirectory([socketDirectory]);
    runtimeRoot.socketPath([socketDirectory, socketName], { maxBytes: 100 });

    const child = this.spawnSupervisor({
      statePath: state.path,
      plan: input.plan,
      runtimeRoot: runtimeRoot.path,
      socketDirectory,
      socketName,
    });
    this.supervisors.set(input.plan.executionId, child);
    child.stdin.on("error", () => {});
    try {
      const launch = encodeFrame(
        {
          version: EXECUTION_PROTOCOL_VERSION,
          prepare: structuredClone(input),
          runtimeHost: {
            executable: this.options.runtimeHost.executable,
            args: [...this.options.runtimeHost.args],
          },
        },
        EXECUTION_LAUNCH_FRAME_MAX_BYTES,
      );
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(launch, (error) => (error ? reject(error) : resolve()));
      });
      const records = await this.waitForPreparedRecords(state, segments, input.plan, child);
      return {
        ...structuredClone(input.plan),
        manifestDigest: executionManifestDigest(records.manifest),
      };
    } catch (error) {
      this.supervisors.delete(input.plan.executionId);
      child.stdin.destroy();
      child.kill("SIGTERM");
      throw new Error("Execution supervisor preparation failed", { cause: error });
    }
  }

  /** Authorize an already persisted reference and return its authenticated owner handle. */
  async authorize(execution: PersistedExecutionRef): Promise<OwnedExecution> {
    assertPersistedExecutionRef(execution);
    const records = await this.readPreparedRecords(execution);
    const authority = {
      version: EXECUTION_PROTOCOL_VERSION,
      execution: structuredClone(execution),
      capabilityDigest: records.manifest.capabilityDigest,
      supervisor: records.manifest.supervisor,
    };
    await writeRecordExclusive(
      records.root,
      [...records.segments, "start-authority.json"],
      authority,
      EXECUTION_PRIVATE_RECORD_MAX_BYTES,
    );
    const response = await this.request(records.control, "authorize");
    if (!response.ok) {
      throw new Error("Execution supervisor rejected start authorization");
    }
    return new LocalOwnedExecution(this, execution, records);
  }

  /** Inspect persisted identity and authenticated live state without launching a worker. */
  async inspect(execution: ExecutionPlanRef): Promise<ExecutionObservation> {
    assertExecutionPlanRef(execution);
    const state = await ensurePrivatePathRoot(this.options.stateDir);
    const segments = ["runs", execution.runId, "executions", execution.executionId] as const;
    const records = await this.readInspectionRecords(state, segments);
    if (records.state === "absent") {
      return { state: "absent", execution: structuredClone(execution) };
    }
    if (records.state === "invalid") {
      return { state: "unknown", execution: structuredClone(execution), reason: "invalid-record" };
    }
    const { control, manifest } = records;
    if (!this.inspectionRecordsMatch(execution, control, manifest)) {
      return {
        state: "unknown",
        execution: structuredClone(execution),
        reason: "identity-mismatch",
      };
    }
    const supervisor = await this.observeSupervisor(manifest);
    if (supervisor.state === "unknown") {
      return {
        state: "unknown",
        execution: structuredClone(execution),
        reason: supervisor.reason,
      };
    }
    if (supervisor.state === "absent") {
      if (manifest.state === "awaiting-start") {
        return { state: "absent", execution: structuredClone(execution) };
      }
      if (manifest.state === "terminal") {
        return this.terminalObservation(state, segments, execution);
      }
      return {
        state: "unknown",
        execution: structuredClone(execution),
        reason: "supervisor-lost",
      };
    }
    try {
      const response = await this.request(control, "inspect");
      if (!response.ok) {
        return {
          state: "unknown",
          execution: structuredClone(execution),
          reason: "supervisor-unreachable",
        };
      }
      return { state: "active", execution: structuredClone(execution) };
    } catch {
      return {
        state: "unknown",
        execution: structuredClone(execution),
        reason: "supervisor-unreachable",
      };
    }
  }

  /** Terminate an authenticated execution and return confirmed absence or a fail-closed reason. */
  async terminate(execution: ExecutionPlanRef): Promise<ExecutionObservation> {
    const observed = await this.inspect(execution);
    if (observed.state !== "active") {
      return observed;
    }
    let records: PreparedRecords;
    try {
      records = await this.readPreparedRecords(execution);
      const response = await this.request(records.control, "terminate");
      if (!response.ok) {
        return { state: "unknown", execution, reason: "cleanup-unconfirmed" };
      }
      await this.release(records);
      return this.terminalObservation(records.root, records.segments, execution);
    } catch {
      return { state: "unknown", execution, reason: "cleanup-unconfirmed" };
    }
  }

  /** Send one authenticated request to an exact supervisor endpoint. */
  async request(
    control: ExecutionControlRecord,
    operation: SupervisorOperation,
    cursor?: number,
  ): Promise<SupervisorResponse> {
    const request: SupervisorRequest = {
      version: EXECUTION_PROTOCOL_VERSION,
      operation,
      executionId: control.executionId,
      generation: control.generation,
      capability: control.capability,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const socket = createConnection(control.endpoint);
    const timeoutMs =
      operation === "terminate"
        ? EXECUTION_TERMINATION_TIMEOUT_MS
        : EXECUTION_CONNECTION_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        (async () => {
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          });
          const response = readEndedFrame(socket, EXECUTION_SOCKET_FRAME_MAX_BYTES);
          socket.end(encodeFrame(request, EXECUTION_SOCKET_FRAME_MAX_BYTES));
          return response;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Execution supervisor request timed out")),
            timeoutMs,
          );
        }),
      ]);
      assertSupervisorResponse(value);
      if (value.ok && value.operation !== operation) {
        throw new Error("Execution supervisor returned a mismatched operation");
      }
      return value;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
    }
  }

  /** Read validated private terminal evidence for an owned execution. */
  async terminal(records: PreparedRecords): Promise<ExecutionTerminalRecord> {
    return readRecord(
      records.root,
      [...records.segments, "terminal.json"],
      EXECUTION_TERMINAL_MAX_BYTES,
      assertExecutionTerminalRecord,
    );
  }

  /** Release a terminal supervisor and confirm its exact process is absent. */
  async release(records: PreparedRecords): Promise<void> {
    const response = await this.request(records.control, "release");
    if (!response.ok) {
      throw new Error("Execution supervisor rejected terminal release");
    }
    await waitForCondition(
      "execution supervisor release",
      async () => !(await matchesPrivateProcess(records.manifest.supervisor)),
      10_000,
    );
    this.supervisors.delete(records.manifest.plan.executionId);
  }

  private spawnSupervisor(coordinates: SupervisorCoordinates): ChildProcessWithoutNullStreams {
    const { statePath, plan, runtimeRoot, socketDirectory, socketName } = coordinates;
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("./supervisor.ts", import.meta.url)),
        statePath,
        plan.runId,
        plan.executionId,
        runtimeRoot,
        socketDirectory,
        socketName,
      ],
      { detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.resume();
    return child;
  }

  private async waitForPreparedRecords(
    root: PrivatePathRoot,
    segments: readonly string[],
    plan: ExecutionPlanRef,
    child: ChildProcessWithoutNullStreams,
  ): Promise<PreparedRecords> {
    let records: PreparedRecords | undefined;
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostic.length < 4_096) {
        diagnostic += chunk.toString("utf8", 0, Math.max(0, 4_096 - diagnostic.length));
      }
    });
    await waitForCondition(
      "execution supervisor preparation",
      async () => {
        try {
          records = await this.readPreparedRecords(plan, root, segments);
          return true;
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(
              `Execution supervisor exited before preparation${diagnostic ? `: ${diagnostic}` : ""}`,
              { cause: error },
            );
          }
          return false;
        }
      },
      10_000,
    );
    if (!records) {
      throw new Error("Execution supervisor preparation completed without records");
    }
    return records;
  }

  private async readPreparedRecords(
    execution: ExecutionPlanRef,
    knownRoot?: PrivatePathRoot,
    knownSegments?: readonly string[],
  ): Promise<PreparedRecords> {
    const root = knownRoot ?? (await ensurePrivatePathRoot(this.options.stateDir));
    const segments =
      knownSegments ?? (["runs", execution.runId, "executions", execution.executionId] as const);
    const [planRecord, control, manifest] = await Promise.all([
      readRecord(
        root,
        [...segments, "plan.json"],
        EXECUTION_PRIVATE_RECORD_MAX_BYTES,
        assertExecutionPlanRecord,
      ),
      readRecord(
        root,
        [...segments, "control.json"],
        EXECUTION_PRIVATE_RECORD_MAX_BYTES,
        assertExecutionControlRecord,
      ),
      readRecord(
        root,
        [...segments, "manifest.json"],
        EXECUTION_PRIVATE_RECORD_MAX_BYTES,
        assertExecutionManifestRecord,
      ),
    ]);
    if (
      !planMatches(planRecord.plan, execution) ||
      !planMatches(manifest.plan, execution) ||
      control.executionId !== execution.executionId ||
      control.generation !== execution.generation ||
      digestBytes(canonicalJson(control)) !== manifest.controlDigest ||
      executionCapabilityDigest(control.capability) !== manifest.capabilityDigest ||
      ("manifestDigest" in execution &&
        execution.manifestDigest !== executionManifestDigest(manifest))
    ) {
      throw new Error("Prepared execution records do not match their plan");
    }
    return { root, segments, planRecord, control, manifest };
  }

  private async readOptionalRecord<T>(
    root: PrivatePathRoot,
    segments: readonly string[],
    validate: (value: unknown) => asserts value is T,
  ): Promise<T | undefined> {
    try {
      return await readRecord(root, segments, EXECUTION_PRIVATE_RECORD_MAX_BYTES, validate);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async readInspectionRecords(
    root: PrivatePathRoot,
    segments: readonly string[],
  ): Promise<InspectionRecords> {
    try {
      const manifest = await this.readOptionalRecord(
        root,
        [...segments, "manifest.json"],
        assertExecutionManifestRecord,
      );
      const control = await this.readOptionalRecord(
        root,
        [...segments, "control.json"],
        assertExecutionControlRecord,
      );
      if (!manifest && !control) {
        return { state: "absent" };
      }
      return manifest && control ? { state: "loaded", manifest, control } : { state: "invalid" };
    } catch {
      return { state: "invalid" };
    }
  }

  private inspectionRecordsMatch(
    execution: ExecutionPlanRef,
    control: ExecutionControlRecord,
    manifest: ExecutionManifestRecord,
  ): boolean {
    return (
      planMatches(manifest.plan, execution) &&
      control.executionId === execution.executionId &&
      control.generation === execution.generation &&
      digestBytes(canonicalJson(control)) === manifest.controlDigest &&
      executionCapabilityDigest(control.capability) === manifest.capabilityDigest
    );
  }

  private async observeSupervisor(manifest: ExecutionManifestRecord): Promise<SupervisorPresence> {
    try {
      const local = await localProcessIdentity();
      if (manifest.supervisor.bootIdentityDigest !== local.bootIdentityDigest) {
        return { state: "unknown", reason: "boot-mismatch" };
      }
      if (manifest.supervisor.hostIdentityDigest !== local.hostIdentityDigest) {
        return { state: "unknown", reason: "identity-mismatch" };
      }
      if (await matchesPrivateProcess(manifest.supervisor)) {
        return { state: "live" };
      }
      const samePid = await inspectPrivateProcess(manifest.supervisor.pid);
      return samePid && samePid.startToken !== manifest.supervisor.startToken
        ? { state: "unknown", reason: "identity-mismatch" }
        : { state: "absent" };
    } catch {
      return { state: "unknown", reason: "supervisor-unreachable" };
    }
  }

  private async terminalObservation(
    root: PrivatePathRoot,
    segments: readonly string[],
    execution: ExecutionPlanRef,
  ): Promise<ExecutionObservation> {
    try {
      const terminal = await readRecord(
        root,
        [...segments, "terminal.json"],
        EXECUTION_TERMINAL_MAX_BYTES,
        assertExecutionTerminalRecord,
      );
      if (
        terminal.executionId !== execution.executionId ||
        terminal.generation !== execution.generation
      ) {
        return { state: "unknown", execution, reason: "identity-mismatch" };
      }
      if (terminal.cleanup !== "confirmed") {
        return { state: "unknown", execution, reason: "cleanup-unconfirmed" };
      }
      return {
        state: "absent",
        execution,
        terminal: {
          outcome: terminal.outcome,
          cleanup: "confirmed",
          terminalDigest: digestBytes(canonicalJson(terminal)),
        },
      };
    } catch {
      return { state: "unknown", execution, reason: "invalid-record" };
    }
  }
}

class LocalOwnedExecution implements OwnedExecution {
  readonly execution: PersistedExecutionRef;
  private eventsStarted = false;
  private eventsDone: Promise<void> = Promise.resolve();
  private finishEvents: (() => void) | undefined;
  private terminalRecord: ExecutionTerminalRecord | undefined;
  private released = false;
  private collection: Promise<ExecutionTerminalRecord> | undefined;

  constructor(
    private readonly host: LocalExecutionHost,
    execution: PersistedExecutionRef,
    private readonly records: PreparedRecords,
  ) {
    this.execution = structuredClone(execution);
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    if (this.terminalRecord) {
      for (const event of this.terminalRecord.events) {
        yield structuredClone(event);
      }
      return;
    }
    if (this.eventsStarted) {
      throw new Error("Owned execution events already have an active consumer");
    }
    this.eventsStarted = true;
    this.eventsDone = new Promise<void>((resolve) => {
      this.finishEvents = resolve;
    });
    let cursor = 0;
    try {
      while (true) {
        const response = await this.host.request(this.records.control, "events", cursor);
        if (!response.ok) {
          throw new Error("Execution supervisor rejected event polling");
        }
        for (const event of response.events ?? []) {
          yield structuredClone(event);
        }
        cursor = response.nextCursor ?? cursor;
        if (response.terminalAvailable) {
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      this.finishEvents?.();
    }
  }

  async collect(): Promise<ExecutionResult | CommandExecution> {
    const terminal = await (this.collection ??= this.collectTerminal());
    return this.resultFromTerminal(terminal);
  }

  async cancel(): Promise<ExecutionObservation> {
    return this.host.terminate(this.execution);
  }

  private async collectTerminal(): Promise<ExecutionTerminalRecord> {
    for (;;) {
      const response = await this.host.request(this.records.control, "collect");
      if (!response.ok) {
        throw new Error("Execution supervisor rejected result collection");
      }
      if (response.terminalAvailable) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const terminal = await this.host.terminal(this.records);
    if (terminal.cleanup !== "confirmed") {
      throw new Error("Execution cleanup is unconfirmed");
    }
    this.terminalRecord = terminal;
    if (this.eventsStarted) {
      await this.eventsDone;
    }
    if (!this.released) {
      await this.host.release(this.records);
      this.released = true;
    }
    return terminal;
  }

  private resultFromTerminal(
    terminal: ExecutionTerminalRecord,
  ): ExecutionResult | CommandExecution {
    return terminal.result.kind === "runtime"
      ? structuredClone(terminal.result.value)
      : commandExecutionFromRecord(terminal.result.value);
  }
}
