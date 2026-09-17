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
import {
  claudeProcessEnvironment,
  inspectClaudeAuthentication,
  type ClaudeAuthSource,
} from "./auth.js";
import { resolveClaudeCodeExecutable, CLAUDE_CODE_VERSION } from "./executable.js";
import { ClaudeJsonlDecoder } from "./jsonl.js";
import { ClaudeNativeTurn } from "./native.js";
import { inspectClaudeManagedPolicy } from "./policy.js";
import { terminateOwnedGroup } from "./process.js";
import { createClaudeCodeProfile, validateClaudeSelection } from "./profile.js";
import {
  parseClaudeCodeRuntimeDescriptor,
  type ClaudeCodeRuntimeDescriptor,
} from "./descriptor.js";

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

/** Explicit first-party model and billing-source selection; no CLI authentication flow is offered. */
export interface ClaudeCodeAdapterOptions {
  provider: string;
  model: string;
  authSource: ClaudeAuthSource;
  /** Deterministic test-only process double; production rejects executable injection. */
  testing?: { executable: string; environment?: NodeJS.ProcessEnv };
}

function classifyFailure(error: unknown): ExecutionResult {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof RuntimePreflightError) {
    return { status: "failed", failure: { category: error.category, message: error.message } };
  }
  if (message.includes("JSONL") || message.includes("native")) {
    return {
      status: "failed",
      failure: {
        category: "schema-violation",
        message: "Claude Code emitted malformed, oversized or conflicting native evidence",
      },
    };
  }
  return {
    status: "failed",
    failure: {
      category: "runtime-unavailable",
      message: "Claude Code execution or process cleanup could not be confirmed",
    },
  };
}

/** One fresh unmodified native CLI process group per attempt; only public evidence escapes. */
export class ClaudeCodeRuntimeAdapter implements DurableRuntimeAdapter {
  readonly id = "claude-code";
  private readonly executions = new Map<string, Pending>();

  /** Bind source explicitly; reject process injection outside deterministic tests. */
  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    validateClaudeSelection(options.provider, options.model, options.authSource);
    if (options.testing && process.env.NODE_ENV !== "test") {
      throw new RuntimePreflightError(
        "policy-violation",
        "Claude Code executable injection is test-only",
      );
    }
  }

  /** Return the exact public selection required to rebuild this adapter after restart. */
  async descriptor(): Promise<ClaudeCodeRuntimeDescriptor> {
    return parseClaudeCodeRuntimeDescriptor({
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "claude-code",
      configurationVersion: "anastom.dev/runtime-claude-code-config/v1alpha1",
      configuration: {
        provider: "anthropic",
        model: this.options.model,
        authSource: this.options.authSource,
      },
    });
  }

  private async preflight(): Promise<{ executable: string; environment: NodeJS.ProcessEnv }> {
    validateClaudeSelection(this.options.provider, this.options.model, this.options.authSource);
    if (this.options.testing) {
      return {
        executable: this.options.testing.executable,
        environment: this.options.testing.environment ?? { PATH: "/usr/bin:/bin" },
      };
    }
    const executable = await resolveClaudeCodeExecutable();
    const environment = claudeProcessEnvironment(this.options.authSource);
    await inspectClaudeManagedPolicy();
    await inspectClaudeAuthentication(executable, this.options.authSource, environment);
    return { executable, environment };
  }

  /** Verify exact native bytes, conservative policy absence, and explicit auth source model-free. */
  async capabilities(): Promise<RuntimeCapabilities> {
    await this.preflight();
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
      sandboxing: ["restricted-working-directory"],
      workspaceModes: ["readonly", "isolated"],
    };
  }

  /** Snapshot the request and recheck all model-free gates before creating execution state. */
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const snapshot = structuredClone(request);
    const profile = createClaudeCodeProfile(snapshot, this.options.authSource, this.options.model);
    const { executable, environment } = await this.preflight();
    const id = randomUUID();
    const pending: Pending = {
      queue: [],
      finished: false,
      cancelled: false,
      droppedLogs: 0,
      result: Promise.resolve({
        status: "failed",
        failure: {
          category: "runtime-unavailable",
          message: "Claude Code did not start",
        },
      }),
    };
    this.executions.set(id, pending);
    pending.result = this.run(pending, profile, snapshot, { executable, environment });
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
        throw new Error("Claude Code exceeded its required observation bound");
      }
    }
    pending.queue.push(structuredClone(event));
    pending.wake?.();
    pending.wake = undefined;
  }

  private async run(
    pending: Pending,
    profile: ReturnType<typeof createClaudeCodeProfile>,
    request: ExecutionRequest,
    nativeProcess: { executable: string; environment: NodeJS.ProcessEnv },
  ): Promise<ExecutionResult> {
    const native = new ClaudeNativeTurn(this.options.model, profile.allowedTools);
    const decoder = new ClaudeJsonlDecoder();
    let result: ExecutionResult;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    try {
      if (request.workspace.mode === "memory") {
        throw new RuntimePreflightError(
          "policy-violation",
          "Claude Code requires a filesystem workspace",
        );
      }
      const child = spawn(nativeProcess.executable, profile.args, {
        cwd: request.workspace.path,
        env: nativeProcess.environment,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pending.child = child;
      const exited = new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
      });
      pending.leaderExit = exited;
      this.push(pending, { type: "started" });
      this.push(pending, {
        type: "metadata",
        provider: "anthropic",
        model: this.options.model,
        source: "configured",
        runtimeVersion: CLAUDE_CODE_VERSION,
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
      });
      child.stdin.on("error", () => {});
      child.stdin.end(profile.prompt);
      for await (const chunk of child.stdout) {
        stdoutBytes += (chunk as Buffer).length;
        if (stdoutBytes > 16_777_216) {
          throw new Error("Claude Code native JSONL attempt exceeds total byte limit");
        }
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
        ? { status: "cancelled", reason: "Claude Code cancelled by control plane" }
        : native.result(request, exitCode);
      if (!pending.cancelled && native.completed && !native.nativeFailed) {
        this.push(pending, native.finalUsage());
      }
      if (stderrBytes > 65_536) {
        this.push(pending, {
          type: "log",
          message: "Claude Code private diagnostics exceeded capture limit",
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
            message: "Claude Code process termination was not confirmed; retry is unsafe",
          },
        };
      } else if (pending.cancelled) {
        result = { status: "cancelled", reason: "Claude Code cancelled by control plane" };
      } else {
        result = classifyFailure(error);
      }
    }
    if (pending.droppedLogs) {
      pending.queue.push({
        type: "log",
        message: "Claude Code public logs dropped under pressure",
        droppedLogs: pending.droppedLogs,
      });
    }
    pending.queue.push({ type: "completed", status: result.status });
    pending.finished = true;
    pending.wake?.();
    pending.wake = undefined;
    return structuredClone(result);
  }

  /** Drain sanitized public events for this attempt. */
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

  /** Collect only after native exit and confirmed group cleanup. */
  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return structuredClone(await this.require(handle).result);
  }

  /** Coalesce cancellation; reject uncertain cleanup. */
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
      throw new Error("Unknown Claude Code execution handle");
    }
    return pending;
  }
}

export { validateClaudeSelection, createClaudeCodeProfile } from "./profile.js";
export { CLAUDE_CODE_VERSION, resolveClaudeCodeExecutable } from "./executable.js";
export type { ClaudeAuthSource } from "./auth.js";
export { parseClaudeCodeRuntimeDescriptor } from "./descriptor.js";
export type { ClaudeCodeRuntimeDescriptor } from "./descriptor.js";

/** Exact codec used to reconstruct Claude Code without persisting credentials or private settings. */
export const claudeCodeRuntimeDescriptorCodec: RuntimeDescriptorCodec<ClaudeCodeRuntimeDescriptor> =
  {
    runtimeId: "claude-code",
    parse: parseClaudeCodeRuntimeDescriptor,
    create: async (descriptor) => {
      const parsed = parseClaudeCodeRuntimeDescriptor(descriptor);
      return new ClaudeCodeRuntimeAdapter({
        provider: parsed.configuration.provider,
        model: parsed.configuration.model,
        authSource: parsed.configuration.authSource,
      });
    },
  };
