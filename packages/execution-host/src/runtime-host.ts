import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { isAbsolute } from "node:path";

import {
  verificationEnvironment,
  assertPrepareExecution,
  type CommandExecution,
  type PrepareExecution,
} from "@anastom/engine";
import { canonicalExistingRoot, resolveExistingChild } from "@anastom/path-policy";
import {
  assertExecutionResult,
  assertRuntimeEvent,
  type ExecutionHandle,
  type ExecutionResult,
  type RuntimeAdapter,
  type RuntimeDescriptor,
} from "@anastom/runtime-contract";

import {
  EXECUTION_LAUNCH_FRAME_MAX_BYTES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_READY_FRAME_MAX_BYTES,
  assertRuntimeHostOutput,
  commandExecutionToRecord,
  readEndedFrame,
  writeFrame,
  type RuntimeHostOutput,
} from "./protocol.js";

/** Composition-root callback that reconstructs one exact adapter from sanitized configuration. */
export type RuntimeResolver = (descriptor: RuntimeDescriptor) => Promise<RuntimeAdapter>;

interface Cancellation {
  request(): Promise<void>;
}

function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

async function executeCommand(
  input: Extract<PrepareExecution, { command: unknown }>,
  setCancellation: (cancellation: Cancellation) => void,
): Promise<CommandExecution> {
  const { command, workspace } = input;
  if (workspace.mode === "memory" || isAbsolute(command.cwd)) {
    throw new Error("Command execution requires a confined filesystem working directory");
  }
  const root = await canonicalExistingRoot(workspace.path);
  const cwd = await resolveExistingChild(root, command.cwd, "directory");
  const started = performance.now();
  const child = spawn(command.argv[0]!, [...command.argv.slice(1)], {
    cwd,
    env: verificationEnvironment(),
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutKept = 0;
  let stderrKept = 0;
  let cancelled = false;
  let timedOut = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    const kept = chunk.subarray(0, Math.max(0, command.maxOutputBytes - stdoutKept));
    stdoutKept += kept.length;
    if (kept.length > 0) {
      stdout.push(Buffer.from(kept));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    const kept = chunk.subarray(0, Math.max(0, command.maxOutputBytes - stderrKept));
    stderrKept += kept.length;
    if (kept.length > 0) {
      stderr.push(Buffer.from(kept));
    }
  });
  const cancel = async () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    signalChildGroup(child, "SIGTERM");
    grace = setTimeout(() => signalChildGroup(child, "SIGKILL"), 500);
  };
  setCancellation({ request: cancel });
  const timeout = setTimeout(() => {
    timedOut = true;
    void cancel();
  }, command.maxDurationMs);
  const { exitCode, signal, failedToStart } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    failedToStart: boolean;
  }>((resolve) => {
    let failedToStart = false;
    child.once("error", () => {
      failedToStart = true;
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, failedToStart }));
  });
  clearTimeout(timeout);
  if (grace) {
    clearTimeout(grace);
  }
  const passed = !cancelled && !timedOut && !failedToStart && exitCode === 0;
  let message = `Command exited with code ${exitCode}`;
  if (failedToStart) {
    message = "Command could not start";
  }
  if (cancelled) {
    message = "Command cancelled by execution supervisor";
  }
  if (timedOut) {
    message = "Command exceeded its duration limit";
  }
  return {
    output: {
      passed,
      exitCode,
      signal,
      durationMs: performance.now() - started,
      stdoutBytes,
      stderrBytes,
      stdoutTruncated: stdoutBytes > stdoutKept,
      stderrTruncated: stderrBytes > stderrKept,
    },
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    ...(passed
      ? {}
      : {
          failure: {
            category: timedOut ? ("budget-exhausted" as const) : ("tool" as const),
            message,
          },
        }),
  };
}

async function executeRuntime(
  input: Extract<PrepareExecution, { descriptor: unknown }>,
  resolveRuntime: RuntimeResolver,
  emit: (output: RuntimeHostOutput) => Promise<void>,
  setCancellation: (cancellation: Cancellation) => void,
): Promise<ExecutionResult> {
  const adapter = await resolveRuntime(structuredClone(input.descriptor));
  if (adapter.id !== input.descriptor.runtimeId) {
    throw new Error("Reconstructed runtime ID does not match its descriptor");
  }
  const handle: ExecutionHandle = await adapter.start(structuredClone(input.request));
  setCancellation({ request: () => adapter.cancel(handle) });
  const observations = (async () => {
    for await (const event of adapter.events(handle)) {
      assertRuntimeEvent(event);
      await emit({ type: "event", event: structuredClone(event) });
    }
  })();
  const result = await adapter.collect(handle);
  assertExecutionResult(result);
  await observations;
  return result;
}

/**
 * Run the hidden isolated execution process over inherited descriptors 3 (launch input) and 4
 * (normalized output). Native adapter streams never cross this protocol.
 */
export async function runExecutionRuntimeHost(resolveRuntime: RuntimeResolver): Promise<void> {
  const inputStream = createReadStream("", { fd: 3, autoClose: true });
  const outputStream = createWriteStream("", { fd: 4, autoClose: true });
  const readyStream = createWriteStream("", { fd: 5, autoClose: true });
  await writeFrame(
    readyStream,
    { version: EXECUTION_PROTOCOL_VERSION, type: "ready" },
    EXECUTION_READY_FRAME_MAX_BYTES,
  );
  readyStream.end();
  const raw = await readEndedFrame(inputStream, EXECUTION_LAUNCH_FRAME_MAX_BYTES);
  const input = raw as PrepareExecution;
  assertPrepareExecution(input);
  let cancellation: Cancellation | undefined;
  let cancellationWork: Promise<void> | undefined;
  let cancellationRequested = false;
  const setCancellation = (next: Cancellation) => {
    cancellation = next;
    if (cancellationRequested) {
      cancellationWork ??= next.request();
    }
  };
  const cancel = () => {
    cancellationRequested = true;
    if (cancellation) {
      cancellationWork ??= cancellation.request();
    }
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const emit = async (output: RuntimeHostOutput) => {
    assertRuntimeHostOutput(output);
    await writeFrame(outputStream, output, EXECUTION_LAUNCH_FRAME_MAX_BYTES);
  };
  try {
    if ("descriptor" in input) {
      const result = await executeRuntime(input, resolveRuntime, emit, setCancellation);
      await cancellationWork;
      await emit({ type: "runtime-result", result });
    } else {
      await emit({ type: "event", event: { type: "started" } });
      const result = await executeCommand(input, setCancellation);
      await cancellationWork;
      await emit({
        type: "event",
        event: { type: "completed", status: result.output.passed ? "succeeded" : "failed" },
      });
      await emit({ type: "command-result", result: commandExecutionToRecord(result) });
    }
  } finally {
    outputStream.end();
  }
}
