import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  DurableRuntimeAdapter,
  RuntimeDescriptorCodec,
  RuntimeCapabilities,
  RuntimeEvent,
} from "@anastom/runtime-contract";
import { assertRuntimeEvent, RuntimePreflightError } from "@anastom/runtime-contract";
import { JsonlDecoder } from "./jsonl.js";
import { NativeTurn } from "./native.js";
import { inspectCodexPolicy } from "./policy.js";
import { terminateOwnedGroup } from "./process.js";
import {
  createCodexProfile,
  resolveAuthFile,
  resolveCodexExecutable,
  validateSelection,
  type CodexProfile,
  type CodexReasoningEffort,
  CODEX_VERSION,
} from "./profile.js";
import { parseCodexRuntimeDescriptor, type CodexRuntimeDescriptor } from "./descriptor.js";

interface Pending {
  queue: RuntimeEvent[];
  wake?: () => void;
  finished: boolean;
  result: Promise<ExecutionResult>;
  child?: ChildProcessWithoutNullStreams;
  leaderExit?: Promise<number | null>;
  cancellation?: Promise<void>;
  cancelled: boolean;
  droppedLogs: number;
}

/** Normalized Codex worker configuration; provider/model are selected outside authored Tasks. */
export interface CodexAdapterOptions {
  provider: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
  /** Test-only native transport injection; routine CI never calls a provider. */
  executable?: string;
  /** Test-only normal auth directory; credentials are never read by the adapter. */
  authDirectory?: string;
}

function classifyFailure(error: unknown): ExecutionResult {
  if (error instanceof RuntimePreflightError) {
    return { status: "failed", failure: { category: error.category, message: error.message } };
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("frame") || message.includes("JSONL")) {
    return {
      status: "failed",
      failure: {
        category: "schema-violation",
        message: "Codex emitted malformed or oversized native JSONL evidence",
      },
    };
  }
  return {
    status: "failed",
    failure: {
      category: "runtime-unavailable",
      message: "Codex execution or cleanup could not be confirmed",
    },
  };
}

/** One fresh owned POSIX Codex process group per agent attempt, with sanitized public observations. */
export class CodexRuntimeAdapter implements DurableRuntimeAdapter {
  readonly id = "codex";
  private readonly executions = new Map<string, Pending>();

  /** Bind explicit OpenAI model selection; normal Codex authentication stays outside the adapter. */
  constructor(private readonly options: CodexAdapterOptions) {
    validateSelection(options.provider, options.model, options.reasoningEffort);
  }

  /** Return the exact public selection required to rebuild this adapter after restart. */
  async descriptor(): Promise<CodexRuntimeDescriptor> {
    const descriptor: CodexRuntimeDescriptor = {
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "codex",
      configurationVersion: "anastom.dev/runtime-codex-config/v1alpha1",
      configuration: {
        provider: "openai",
        model: this.options.model,
        ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
        authSource: "file-store",
      },
    };
    return parseCodexRuntimeDescriptor(descriptor);
  }

  /** Probe exact project installation and supported auth-store form without starting a model session. */
  async capabilities(): Promise<RuntimeCapabilities> {
    validateSelection(this.options.provider, this.options.model, this.options.reasoningEffort);
    await Promise.all([
      this.options.executable ? Promise.resolve(this.options.executable) : resolveCodexExecutable(),
      resolveAuthFile(this.options.authDirectory),
    ]);
    return {
      streaming: true,
      cancellation: true,
      resumableSession: false,
      nativeSubagents: false,
      mcp: false,
      lsp: false,
      debugger: false,
      browser: false,
      structuredOutput: "native",
      usageReporting: "partial",
      sandboxing: ["read-only", "workspace-write"],
      workspaceModes: ["readonly", "isolated"],
    };
  }

  /** Capture the immutable request, then create only adapter-owned temporary files and process state. */
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (request.nodeKind !== "agent" || request.workspace.mode === "memory") {
      throw new Error("Codex executes filesystem agent attempts only");
    }
    const snapshot = structuredClone(request);
    if (snapshot.workspace.mode === "memory") {
      throw new Error("Codex requires a filesystem agent request");
    }
    const executable = this.options.executable ?? (await resolveCodexExecutable());
    const authFile = await resolveAuthFile(this.options.authDirectory);
    const profile = await createCodexProfile({
      request: snapshot,
      authFile,
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
    });
    try {
      await inspectCodexPolicy({
        executable,
        profile,
        workspace: snapshot.workspace.path,
      });
    } catch (error) {
      await profile.dispose();
      throw error;
    }
    const id = randomUUID();
    const pending: Pending = {
      queue: [],
      finished: false,
      cancelled: false,
      droppedLogs: 0,
      result: Promise.resolve({
        status: "failed",
        failure: { category: "runtime-unavailable", message: "Codex did not start" },
      }),
    };
    this.executions.set(id, pending);
    pending.result = this.run(pending, profile, snapshot, executable);
    return { id };
  }

  private push(pending: Pending, event: RuntimeEvent): void {
    if (pending.finished) {
      return;
    }
    assertRuntimeEvent(event);
    if (pending.queue.length >= 254) {
      const index = pending.queue.findIndex((queued) => queued.type === "log");
      if (index >= 0) {
        pending.queue.splice(index, 1);
        pending.droppedLogs++;
      } else if (event.type === "log") {
        pending.droppedLogs++;
        return;
      } else {
        throw new Error("Codex exceeded its required observation bound");
      }
    }
    pending.queue.push(structuredClone(event));
    pending.wake?.();
    pending.wake = undefined;
  }

  private async run(
    pending: Pending,
    profile: CodexProfile,
    request: ExecutionRequest,
    executable: string,
  ): Promise<ExecutionResult> {
    const native = new NativeTurn();
    const decoder = new JsonlDecoder();
    let result: ExecutionResult;
    let stderrBytes = 0;
    let stderrTruncated = false;
    try {
      const child = spawn(executable, profile.args, {
        cwd: request.workspace.mode === "memory" ? undefined : request.workspace.path,
        env: profile.env,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pending.child = child;
      this.push(pending, { type: "started" });
      this.push(pending, {
        type: "metadata",
        provider: "openai",
        model: this.options.model,
        source: "configured",
        runtimeVersion: CODEX_VERSION,
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrTruncated ||= stderrBytes > 65_536;
      });
      child.stdin.on("error", () => {});
      child.stdin.end(profile.prompt);
      const exited = new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => done(code));
      });
      pending.leaderExit = exited;
      for await (const chunk of child.stdout) {
        if (pending.cancelled) {
          continue;
        }
        for (const frame of decoder.push(chunk as Buffer)) {
          native.observe(frame);
          for (const observation of native.observations.splice(0)) {
            this.push(pending, observation);
          }
        }
      }
      decoder.finish();
      const exitCode = await exited;
      await terminateOwnedGroup(child, exited);
      result = pending.cancelled
        ? { status: "cancelled", reason: "Codex cancelled by control plane" }
        : native.result(request, exitCode);
      if (!pending.cancelled && native.completed) {
        this.push(pending, native.finalUsage());
      }
      if (stderrTruncated) {
        this.push(pending, {
          type: "log",
          message: "Codex native diagnostics exceeded private capture limit",
        });
      }
    } catch (error) {
      let cleanupConfirmed = !pending.child;
      if (pending.child) {
        try {
          await terminateOwnedGroup(pending.child, pending.leaderExit);
          cleanupConfirmed = true;
        } catch {
          cleanupConfirmed = false;
        }
      }
      if (!cleanupConfirmed) {
        result = {
          status: "failed",
          failure: {
            category: "runtime-unavailable",
            message: "Codex process termination was not confirmed; retry is unsafe",
          },
        };
      } else if (pending.cancelled) {
        result = { status: "cancelled", reason: "Codex cancelled by control plane" };
      } else {
        result = classifyFailure(error);
      }
    } finally {
      try {
        await profile.dispose();
      } catch {
        result = {
          status: "failed",
          failure: {
            category: "runtime-unavailable",
            message: "Codex attempt files could not be cleaned up; retry is unsafe",
          },
        };
      }
    }
    if (pending.droppedLogs) {
      pending.queue.push({
        type: "log",
        message: "Codex public logs dropped under queue pressure",
        droppedLogs: pending.droppedLogs,
      });
    }
    pending.queue.push({ type: "completed", status: result.status });
    pending.finished = true;
    pending.wake?.();
    pending.wake = undefined;
    return structuredClone(result);
  }

  /** Drain the finite sanitized stream; unknown handle identity fails deterministically. */
  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const pending = this.require(handle);
    while (!pending.finished || pending.queue.length) {
      const event = pending.queue.shift();
      if (event) {
        yield structuredClone(event);
      } else {
        await new Promise<void>((wake) => {
          pending.wake = wake;
        });
      }
    }
  }

  /** Return a defensive terminal copy only after native exit and owned group cleanup. */
  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return structuredClone(await this.require(handle).result);
  }

  /** Coalesce concurrent cancellation and reject when owned group termination is uncertain. */
  async cancel(handle: ExecutionHandle): Promise<void> {
    const pending = this.require(handle);
    if (pending.finished) {
      return;
    }
    await (pending.cancellation ??= this.cancelPending(pending));
  }

  private async cancelPending(pending: Pending): Promise<void> {
    pending.cancelled = true;
    if (!pending.child) {
      await pending.result;
      return;
    }
    await terminateOwnedGroup(pending.child, pending.leaderExit);
    await pending.result;
  }

  private require(handle: ExecutionHandle): Pending {
    const pending = this.executions.get(handle.id);
    if (!pending) {
      throw new Error("Unknown Codex handle");
    }
    return pending;
  }
}

export { renderCodexPrompt, validateSelection, CODEX_VERSION } from "./profile.js";
export { parseCodexRuntimeDescriptor } from "./descriptor.js";
export type { CodexRuntimeDescriptor } from "./descriptor.js";

/** Exact codec used to reconstruct Codex without persisting credentials or private settings. */
export const codexRuntimeDescriptorCodec: RuntimeDescriptorCodec<CodexRuntimeDescriptor> = {
  runtimeId: "codex",
  parse: parseCodexRuntimeDescriptor,
  create: async (descriptor) => {
    const parsed = parseCodexRuntimeDescriptor(descriptor);
    return new CodexRuntimeAdapter({
      provider: parsed.configuration.provider,
      model: parsed.configuration.model,
      reasoningEffort: parsed.configuration.reasoningEffort,
    });
  },
};
