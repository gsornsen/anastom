import { randomUUID } from "node:crypto";
import { canonicalJson, validateJsonValue, type JsonValue } from "@anastom/core";
import type { ExecutionHandle, ExecutionRequest, ExecutionResult, RuntimeAdapter, RuntimeCapabilities, RuntimeEvent } from "@anastom/runtime-contract";
import { observablePiEvent } from "./observable.js";

export interface PiSession {
  prompt: (text: string) => Promise<void>;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  finalMessage: () => unknown;
  identity: { provider: string; model: string };
  abort: () => Promise<void>;
  dispose: () => void;
}
export type PiSessionFactory = (request: ExecutionRequest, signal: AbortSignal) => Promise<PiSession>;
export interface PiAdapterOptions { factory?: PiSessionFactory; provider?: string; model?: string }

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
  if (!message || typeof message !== "object") return { status: "failed", failure: { category: "model-provider", message: "Pi returned no assistant response" } };
  const fields = message as Record<string, unknown>;
  if (fields.stopReason === "error") return { status: "failed", failure: { category: "model-provider", message: "Pi model request failed; check provider authentication and configuration" } };
  if (fields.stopReason === "aborted") return { status: "cancelled", reason: "Pi session was aborted" };
  try {
    if (!Array.isArray(fields.content)) throw new Error("Missing response content");
    const text = fields.content.filter((part: unknown) => part && typeof part === "object" && "type" in part && part.type === "text")
      .map((part: unknown) => (part as { text: string }).text).join("").trim();
    const output = JSON.parse(text) as JsonValue;
    const validation = validateJsonValue(request.requiredOutputSchema, output);
    if (!validation.valid) throw new Error("Invalid structured response");
    return { status: "succeeded", output };
  } catch {
    return { status: "failed", failure: { category: "schema-violation", message: "Pi final response must be JSON matching the required output schema" } };
  }
}

async function createSession(request: ExecutionRequest, signal: AbortSignal, options: PiAdapterOptions): Promise<PiSession> {
  if (request.workspace.mode === "memory") throw new Error("Pi requires a filesystem workspace");
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = sdk.getAgentDir();
  const fileSettings = sdk.SettingsManager.create(request.workspace.path, agentDir, { projectTrusted: false });
  const settingsManager = sdk.SettingsManager.inMemory({
    ...fileSettings.getGlobalSettings(),
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    packages: [], extensions: [], skills: [], prompts: [], themes: [],
  });
  const systemPrompt = "You are a bounded software implementer. Follow the explicit context envelope, use the assigned workspace, and return the required JSON report.";
  const loader = new sdk.DefaultResourceLoader({
    cwd: request.workspace.path, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt, appendSystemPrompt: [],
    systemPromptOverride: () => systemPrompt, appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({ signal, allowModelNetwork: false });
  const model = options.provider && options.model ? modelRuntime.getModel(options.provider, options.model) : undefined;
  if (options.provider && !model) throw new Error("Configured Pi model was not found");
  signal.throwIfAborted();
  const { session } = await sdk.createAgentSession({
    cwd: request.workspace.path, modelRuntime, settingsManager, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(request.workspace.path),
    tools: request.toolPolicy.allowMutations ? ["read", "write", "edit", "bash"] : ["read", "grep", "find", "ls"],
    ...(model ? { model } : {}),
  });
  if (signal.aborted) { await session.abort(); session.dispose(); signal.throwIfAborted(); }
  if (!session.model) { session.dispose(); throw new Error("No configured Pi model is available"); }
  const identity = { provider: session.model.provider, model: session.model.id };
  return {
    identity,
    prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
    subscribe: (listener) => session.subscribe((event) => {
      const observable = observablePiEvent(event);
      if (observable) listener(observable);
    }),
    finalMessage: () => session.messages.findLast((message) => message.role === "assistant"),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}
interface Pending {
  controller: AbortController; session?: PiSession; queue: RuntimeEvent[]; finished: boolean;
  wake?: () => void; result: Promise<ExecutionResult>; abort?: Promise<void>;
}
export class PiRuntimeAdapter implements RuntimeAdapter {
  readonly id = "pi";
  private readonly executions = new Map<string, Pending>();
  constructor(private readonly options: PiAdapterOptions = {}) {}
  async capabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, cancellation: true, resumableSession: false, nativeSubagents: false, mcp: false, lsp: false, debugger: false, browser: false, structuredOutput: "prompted", usageReporting: "none", sandboxing: [] };
  }
  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (request.nodeKind !== "agent" || request.workspace.mode === "memory") throw new Error("Pi executes filesystem agent attempts only");
    const id = randomUUID();
    const pending: Pending = { controller: new AbortController(), queue: [], finished: false, result: Promise.resolve({ status: "cancelled", reason: "Not started" }) };
    this.executions.set(id, pending);
    pending.result = this.run(pending, request);
    return { id };
  }
  private push(pending: Pending, event: RuntimeEvent): void {
    if (pending.queue.length >= 256) pending.queue.shift();
    pending.queue.push(event); pending.wake?.(); pending.wake = undefined;
  }
  private async run(pending: Pending, request: ExecutionRequest): Promise<ExecutionResult> {
    let unsubscribe: (() => void) | undefined;
    let result: ExecutionResult;
    try {
      pending.session = await (this.options.factory ?? ((req, signal) => createSession(req, signal, this.options)))(request, pending.controller.signal);
      if (pending.controller.signal.aborted) {
        await this.abortSession(pending);
        result = { status: "cancelled", reason: "Pi cancelled before prompting" };
      } else {
        this.push(pending, { type: "started" });
        this.push(pending, { type: "metadata", ...pending.session.identity });
        unsubscribe = pending.session.subscribe((event) => this.push(pending, event));
        await pending.session.prompt(renderPiPrompt(request));
        result = pending.controller.signal.aborted ? { status: "cancelled", reason: "Pi cancelled by control plane" } : finalResult(pending.session.finalMessage(), request);
      }
    } catch {
      result = pending.controller.signal.aborted ? { status: "cancelled", reason: "Pi initialization or execution aborted" } : { status: "failed", failure: { category: "model-provider", message: "Pi initialization or execution failed; check provider authentication and model configuration" } };
    } finally {
      try { unsubscribe?.(); } catch { /* Disposal must not strand an event stream. */ }
      try { pending.session?.dispose(); } catch { /* Never expose private SDK state in cleanup errors. */ }
    }
    this.push(pending, { type: "completed", status: result.status });
    pending.finished = true; pending.wake?.();
    return result;
  }
  async *events(handle: ExecutionHandle): AsyncIterable<RuntimeEvent> {
    const pending = this.require(handle);
    while (!pending.finished || pending.queue.length) {
      const event = pending.queue.shift();
      if (event) yield event;
      else await new Promise<void>((wake) => { pending.wake = wake; });
    }
  }
  async collect(handle: ExecutionHandle): Promise<ExecutionResult> { return structuredClone(await this.require(handle).result); }
  async cancel(handle: ExecutionHandle): Promise<void> {
    const pending = this.require(handle);
    pending.controller.abort();
    if (pending.session) await this.abortSession(pending);
    await pending.result;
  }
  private abortSession(pending: Pending): Promise<void> { return pending.abort ??= pending.session?.abort() ?? Promise.resolve(); }
  private require(handle: ExecutionHandle): Pending {
    const pending = this.executions.get(handle.id); if (!pending) throw new Error("Unknown Pi handle"); return pending;
  }
}
