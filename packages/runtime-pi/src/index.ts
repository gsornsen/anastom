import { randomUUID } from "node:crypto";
import { canonicalJson, validateJsonValue, type JsonValue } from "@anastom/core";
import type {
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  DurableRuntimeAdapter,
  RuntimeDescriptorCodec,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeUsage,
} from "@anastom/runtime-contract";
import { assertRuntimeEvent, RuntimePreflightError } from "@anastom/runtime-contract";
import { observablePiEvent } from "./observable.js";
import { PiUsageAccumulator } from "./usage.js";
import {
  assertPiSelection,
  parsePiRuntimeDescriptor,
  type PiRuntimeDescriptor,
} from "./descriptor.js";

/**
 * The minimal Pi session facade used by the adapter; injectable to test lifecycle without model calls.
 */
export interface PiSession {
  /** Execute the explicit prompt in this attempt's fresh session. */
  prompt: (text: string) => Promise<void>;
  /** Subscribe to normalized public observations; return an unsubscribe function. */
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  /** Read the final SDK message for normalization and output validation. */
  finalMessage: () => unknown;
  /** Read final attempt usage when available; SDK defaults do not establish provider-reported zero. */
  finalUsage?: () => RuntimeUsage;
  /** Public provider/model identity, excluding credentials. */
  identity: { provider: string; model: string };
  /** Request execution termination and propagate failure to the adapter. */
  abort: () => Promise<void>;
  /** Release session-owned resources after execution settles. */
  dispose: () => void;
}
/**
 * Create a fresh session using explicit context and cancellation, returning public provider/model identity.
 */
export type PiSessionFactory = (
  request: ExecutionRequest,
  signal: AbortSignal,
) => Promise<PiSession>;
/**
 * Optional explicit provider/model and test session factory; credentials remain in normal Pi auth.
 */
export interface PiAdapterOptions {
  factory?: PiSessionFactory;
  provider?: string;
  model?: string;
}

/**
 * Present the explicit context and report contract to Pi, keeping independent verification owned by the engine.
 */
export function renderPiPrompt(request: ExecutionRequest): string {
  return [
    "Perform the bounded task described by this immutable context envelope.",
    "Operate only in the assigned workspace. Respect the mutation mode.",
    "The control plane will run the authoritative verification command after you finish.",
    "Return ONLY one JSON object matching requiredOutputSchema; do not use Markdown fences.",
    canonicalJson(request.context),
  ].join("\n\n");
}
function finalResult(message: unknown, request: ExecutionRequest): ExecutionResult {
  if (!message || typeof message !== "object") {
    return {
      status: "failed",
      failure: { category: "model-provider", message: "Pi returned no assistant response" },
    };
  }
  const fields = message as Record<string, unknown>;
  if (fields.stopReason === "error") {
    return {
      status: "failed",
      failure: {
        category: "model-provider",
        message: "Pi model request failed; check provider authentication and configuration",
      },
    };
  }
  if (fields.stopReason === "aborted") {
    return { status: "cancelled", reason: "Pi session was aborted" };
  }
  try {
    if (!Array.isArray(fields.content)) {
      throw new Error("Missing response content");
    }
    const text = fields.content
      .filter(
        (part: unknown) =>
          part && typeof part === "object" && "type" in part && part.type === "text",
      )
      .map((part: unknown) => (part as { text: string }).text)
      .join("")
      .trim();
    const output = JSON.parse(text) as JsonValue;
    const validation = validateJsonValue(request.requiredOutputSchema, output);
    if (!validation.valid) {
      throw new Error("Invalid structured response");
    }
    return { status: "succeeded", output };
  } catch {
    return {
      status: "failed",
      failure: {
        category: "schema-violation",
        message: "Pi final response must be JSON matching the required output schema",
      },
    };
  }
}

async function createSession(
  request: ExecutionRequest,
  signal: AbortSignal,
  options: PiAdapterOptions,
): Promise<PiSession> {
  if (request.workspace.mode === "memory") {
    throw new Error("Pi requires a filesystem workspace");
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = sdk.getAgentDir();
  const fileSettings = sdk.SettingsManager.create(request.workspace.path, agentDir, {
    projectTrusted: false,
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    ...fileSettings.getGlobalSettings(),
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  const systemPrompt =
    "You are a bounded software implementer. Follow the explicit context envelope, use the assigned workspace, and return the required JSON report.";
  const loader = new sdk.DefaultResourceLoader({
    cwd: request.workspace.path,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({ signal, allowModelNetwork: false });
  const model =
    options.provider && options.model
      ? modelRuntime.getModel(options.provider, options.model)
      : undefined;
  if (options.provider && !model) {
    throw new Error("Configured Pi model was not found");
  }
  signal.throwIfAborted();
  const { session } = await sdk.createAgentSession({
    cwd: request.workspace.path,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(request.workspace.path),
    tools: request.toolPolicy.allowMutations
      ? ["read", "write", "edit", "bash"]
      : ["read", "grep", "find", "ls"],
    ...(model ? { model } : {}),
  });
  if (signal.aborted) {
    await session.abort();
    session.dispose();
    signal.throwIfAborted();
  }
  if (!session.model) {
    session.dispose();
    throw new Error("No configured Pi model is available");
  }
  const identity = { provider: session.model.provider, model: session.model.id };
  const usage = new PiUsageAccumulator();
  return {
    identity,
    prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
    subscribe: (listener) =>
      session.subscribe((event) => {
        if (event.type === "message_end") {
          usage.observe(event.message);
        }
        const observable = observablePiEvent(event);
        if (observable) {
          listener(observable);
        }
      }),
    finalMessage: () => session.messages.findLast((message) => message.role === "assistant"),
    finalUsage: () => usage.final(),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

async function resolvePiSelection(options: PiAdapterOptions): Promise<{
  provider: string;
  model: string;
}> {
  if (options.provider && options.model) {
    assertPiSelection(options.provider, options.model);
    return { provider: options.provider, model: options.model };
  }
  if (options.factory) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Injected Pi sessions require an explicit provider and model for durability",
    );
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  const cwd = process.cwd();
  const agentDir = sdk.getAgentDir();
  const fileSettings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const settingsManager = sdk.SettingsManager.inMemory({
    ...fileSettings.getGlobalSettings(),
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  const systemPrompt = "Resolve the configured Pi model without executing a request.";
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
  const { session } = await sdk.createAgentSession({
    cwd,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    tools: ["read"],
  });
  try {
    if (!session.model) {
      throw new RuntimePreflightError("runtime-unavailable", "No configured Pi model is available");
    }
    const selection = { provider: session.model.provider, model: session.model.id };
    assertPiSelection(selection.provider, selection.model);
    return selection;
  } finally {
    session.dispose();
  }
}
interface Pending {
  controller: AbortController;
  session?: PiSession;
  queue: RuntimeEvent[];
  finished: boolean;
  wake?: () => void;
  result: Promise<ExecutionResult>;
  abort?: Promise<void>;
  cancellation?: Promise<void>;
  droppedLogs: number;
}
/**
 * Run each agent attempt in a fresh ephemeral Pi session and expose only normalized public events.
 */
export class PiRuntimeAdapter implements DurableRuntimeAdapter {
  readonly id = "pi";
  private readonly executions = new Map<string, Pending>();
  /**
   * Bind explicit model selection and an optional injectable session factory; never accepts credentials.
   */
  constructor(private readonly options: PiAdapterOptions = {}) {
    if (Boolean(options.provider) !== Boolean(options.model)) {
      throw new RuntimePreflightError(
        "policy-violation",
        "Pi provider and model must be selected together",
      );
    }
    if (options.provider && options.model) {
      assertPiSelection(options.provider, options.model);
    }
  }
  /** Resolve an ambient Pi default once and return a complete durable public selection. */
  async descriptor(): Promise<PiRuntimeDescriptor> {
    let selection: { provider: string; model: string };
    try {
      selection = await resolvePiSelection(this.options);
    } catch (error) {
      if (error instanceof RuntimePreflightError) {
        throw error;
      }
      throw new RuntimePreflightError(
        "runtime-unavailable",
        "Pi configured model selection could not be resolved",
      );
    }
    return parsePiRuntimeDescriptor({
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "pi",
      configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1",
      configuration: selection,
    });
  }
  /**
   * Describe supported Pi features without exposing its private session implementation.
   */
  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      cancellation: true,
      resumableSession: false,
      nativeSubagents: false,
      mcp: false,
      lsp: false,
      debugger: false,
      browser: false,
      structuredOutput: "prompted",
      usageReporting: "partial",
      sandboxing: [],
      workspaceModes: ["readonly", "isolated"],
    };
  }
  /**
   * Start one fresh ephemeral session and register its bounded public event stream.
   * @remarks Handle IDs use node:crypto.randomUUID(): cryptographic UUIDv4 with 122 random bits, suitable for identity, not access control.
   */
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (request.nodeKind !== "agent" || request.workspace.mode === "memory") {
      throw new Error("Pi executes filesystem agent attempts only");
    }
    const id = randomUUID();
    const pending: Pending = {
      controller: new AbortController(),
      queue: [],
      finished: false,
      droppedLogs: 0,
      result: Promise.resolve({ status: "cancelled", reason: "Not started" }),
    };
    this.executions.set(id, pending);
    pending.result = this.run(pending, structuredClone(request));
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
        throw new Error("Pi exceeded its required observation bound");
      }
    }
    pending.queue.push(structuredClone(event));
    pending.wake?.();
    pending.wake = undefined;
  }
  private async run(pending: Pending, request: ExecutionRequest): Promise<ExecutionResult> {
    let unsubscribe: (() => void) | undefined;
    let result: ExecutionResult;
    try {
      pending.session = await (
        this.options.factory ?? ((req, signal) => createSession(req, signal, this.options))
      )(request, pending.controller.signal);
      if (pending.controller.signal.aborted) {
        await this.abortSession(pending);
        result = { status: "cancelled", reason: "Pi cancelled before prompting" };
      } else {
        this.push(pending, { type: "started" });
        this.push(pending, {
          type: "metadata",
          ...pending.session.identity,
          source: "configured",
          runtimeVersion: "0.85.1",
        });
        unsubscribe = pending.session.subscribe((event) => {
          if (event.type === "log") {
            this.push(pending, event);
          }
        });
        await pending.session.prompt(renderPiPrompt(request));
        result = pending.controller.signal.aborted
          ? { status: "cancelled", reason: "Pi cancelled by control plane" }
          : finalResult(pending.session.finalMessage(), request);
      }
    } catch {
      result = pending.controller.signal.aborted
        ? { status: "cancelled", reason: "Pi initialization or execution aborted" }
        : {
            status: "failed",
            failure: {
              category: "model-provider",
              message:
                "Pi initialization or execution failed; check provider authentication and model configuration",
            },
          };
    } finally {
      let cleanupConfirmed = true;
      try {
        unsubscribe?.();
      } catch {
        cleanupConfirmed = false;
      }
      try {
        pending.session?.dispose();
      } catch {
        cleanupConfirmed = false;
      }
      if (!cleanupConfirmed) {
        result = {
          status: "failed",
          failure: {
            category: "runtime-unavailable",
            message: "Pi session cleanup could not be confirmed; retry is unsafe",
          },
        };
      }
    }
    try {
      if (pending.session?.finalUsage) {
        this.push(pending, pending.session.finalUsage());
      }
    } catch {
      result = {
        status: "failed",
        failure: {
          category: "runtime-unavailable",
          message: "Pi returned invalid public usage evidence",
        },
      };
    }
    if (pending.droppedLogs) {
      pending.queue.push({
        type: "log",
        message: "Pi public logs dropped under queue pressure",
        droppedLogs: pending.droppedLogs,
      });
    }
    pending.queue.push({ type: "completed", status: result.status });
    pending.finished = true;
    pending.wake?.();
    return result;
  }
  /**
   * Stream normalized public events until the registered execution settles.
   */
  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const pending = this.require(handle);
    while (!pending.finished || pending.queue.length) {
      const event = pending.queue.shift();
      if (event) {
        yield event;
      } else {
        await new Promise<void>((wake) => {
          pending.wake = wake;
        });
      }
    }
  }
  /**
   * Await the normalized result for a registered execution handle.
   */
  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return structuredClone(await this.require(handle).result);
  }
  /**
   * Request cancellation once across concurrent callers and propagate abort failure to the engine.
   */
  async cancel(handle: ExecutionHandle): Promise<void> {
    const pending = this.require(handle);
    if (pending.finished) {
      return;
    }
    await (pending.cancellation ??= this.cancelPending(pending));
  }
  private async cancelPending(pending: Pending): Promise<void> {
    pending.controller.abort();
    if (pending.session) {
      await this.abortSession(pending);
    }
    await pending.result;
  }
  private abortSession(pending: Pending): Promise<void> {
    return (pending.abort ??= pending.session?.abort() ?? Promise.resolve());
  }
  private require(handle: ExecutionHandle): Pending {
    const pending = this.executions.get(handle.id);
    if (!pending) {
      throw new Error("Unknown Pi handle");
    }
    return pending;
  }
}

export { parsePiRuntimeDescriptor } from "./descriptor.js";
export type { PiRuntimeDescriptor } from "./descriptor.js";

/** Exact codec used by the M3 composition root to reconstruct Pi without ambient defaults. */
export const piRuntimeDescriptorCodec: RuntimeDescriptorCodec<PiRuntimeDescriptor> = {
  runtimeId: "pi",
  parse: parsePiRuntimeDescriptor,
  create: async (descriptor) => {
    const parsed = parsePiRuntimeDescriptor(descriptor);
    return new PiRuntimeAdapter({
      provider: parsed.configuration.provider,
      model: parsed.configuration.model,
    });
  },
};
