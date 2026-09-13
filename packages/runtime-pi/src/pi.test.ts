import { describe, it, expect, vi } from "vitest";
import { workerReportSchema } from "@anastom/core";
import type { ExecutionRequest, RuntimeEvent } from "@anastom/runtime-contract";
import { PiRuntimeAdapter, renderPiPrompt, type PiSession } from "./index.js";
import { observablePiEvent } from "./observable.js";

const report = { summary: "implemented", changedFiles: ["server.mjs"], notes: [] };
function request(attempt = 1): ExecutionRequest {
  return { runId: "pi-test", workflowInstanceId: "pi-test:root", nodeId: "implement", nodeKind: "agent", attempt,
    workspace: { id: "pi-test", mode: "isolated", repoRoot: "/fixture", path: "/fixture/worktree", branch: "anastom/pi-test", baseCommit: "base" },
    context: { inputs: {}, dependencyOutputs: {}, task: { id: "test/pi", version: "0.1.0", objective: "implement endpoint", acceptanceCriteria: ["health responds"] } },
    budget: { maxAttempts: 2, maxDurationMs: 1000 }, requiredOutputSchema: workerReportSchema, toolPolicy: { allowMutations: true },
  };
}
function session(message: unknown = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: JSON.stringify(report) }] }) {
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const unsub = vi.fn();
  const value: PiSession = {
    identity: { provider: "fixture-provider", model: "fixture-model" },
    prompt: vi.fn(async () => { listener?.({ type: "log", message: "Pi tool finished: edit" }); }),
    subscribe: vi.fn((observe: (event: RuntimeEvent) => void) => { listener = observe; return unsub; }),
    finalMessage: () => message, abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
  return { value, unsub };
}
async function events(adapter: PiRuntimeAdapter, handle: { id: string }) { const result: RuntimeEvent[] = []; for await (const event of adapter.events(handle)) result.push(event); return result; }
describe("Pi SDK boundary without model calls", () => {
  it("makes a new ephemeral session per attempt, emits public metadata, and disposes each one", async () => {
    const sessions = [session(), session()];
    let calls = 0;
    const factory = vi.fn(async () => sessions[calls++]!.value);
    const adapter = new PiRuntimeAdapter({ factory });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const handle = await adapter.start(request(attempt));
      const observed = await events(adapter, handle);
      expect(observed).toEqual([{ type: "started" }, { type: "metadata", provider: "fixture-provider", model: "fixture-model" }, { type: "log", message: "Pi tool finished: edit" }, { type: "completed", status: "succeeded" }]);
      expect(await adapter.collect(handle)).toEqual({ status: "succeeded", output: report });
      expect(sessions[attempt - 1]!.value.prompt).toHaveBeenCalledWith(renderPiPrompt(request(attempt)));
      expect(sessions[attempt - 1]!.value.dispose).toHaveBeenCalledOnce();
      expect(sessions[attempt - 1]!.unsub).toHaveBeenCalledOnce();
      expect(JSON.stringify(observed)).not.toContain("private reasoning");
    }
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it.each(["not JSON", "```json\n{}\n```", '{"summary":"missing required fields"}'])("rejects malformed final output: %s", async (text) => {
    const sdk = session({ content: [{ type: "text", text }], stopReason: "stop" });
    const adapter = new PiRuntimeAdapter({ factory: async () => sdk.value });
    const handle = await adapter.start(request()); await events(adapter, handle);
    expect(await adapter.collect(handle)).toMatchObject({ status: "failed", failure: { category: "schema-violation" } });
    expect(sdk.value.dispose).toHaveBeenCalledOnce();
  });
  it("sanitizes provider failures and never maps private reasoning or tool bodies", async () => {
    const sdk = session({ content: [], stopReason: "error", errorMessage: "secret credential" });
    const adapter = new PiRuntimeAdapter({ factory: async () => sdk.value });
    const result = await adapter.collect(await adapter.start(request()));
    expect(result).toMatchObject({ status: "failed", failure: { category: "model-provider" } });
    expect(JSON.stringify(result)).not.toContain("secret");
    const raw = { type: "message_update", content: "private reasoning" };
    expect(observablePiEvent(raw)).toBeNull();
    const tool = { type: "tool_execution_end", toolName: "bash", isError: true, result: "private command output" };
    expect(observablePiEvent(tool)).toEqual({ type: "log", message: "Pi tool finished: bash (failed)" });
  });
  it("aborts once across concurrent cancellation and closes the stream", async () => {
    const sdk = session();
    let finish!: () => void;
    const active = new Promise<void>((done) => { finish = done; });
    sdk.value.prompt = vi.fn(() => active);
    sdk.value.abort = vi.fn(async () => { finish(); });
    const adapter = new PiRuntimeAdapter({ factory: async () => sdk.value });
    const handle = await adapter.start(request());
    await Promise.resolve(); await Promise.resolve();
    await Promise.all([adapter.cancel(handle), adapter.cancel(handle)]);
    expect(sdk.value.abort).toHaveBeenCalledOnce();
    expect(await adapter.collect(handle)).toMatchObject({ status: "cancelled" });
    expect((await events(adapter, handle)).at(-1)).toEqual({ type: "completed", status: "cancelled" });
    expect(sdk.value.dispose).toHaveBeenCalledOnce();
  });
  it("honors cancellation during initialization and does not prompt", async () => {
    const sdk = session(); let initialized!: (value: PiSession) => void;
    const adapter = new PiRuntimeAdapter({ factory: async (_request, signal) => { expect(signal.aborted).toBe(false); return new Promise((done) => { initialized = done; }); } });
    const handle = await adapter.start(request()); const cancelled = adapter.cancel(handle);
    initialized(sdk.value); await cancelled;
    expect(sdk.value.prompt).not.toHaveBeenCalled(); expect(sdk.value.abort).toHaveBeenCalledOnce(); expect(sdk.value.dispose).toHaveBeenCalledOnce();
  });
  it("exposes cancellation failure to the control plane and disposes after the session ends", async () => {
    const sdk = session(); let finish!: () => void;
    sdk.value.prompt = () => new Promise((done) => { finish = done; });
    sdk.value.abort = vi.fn(async () => { throw new Error("abort refused"); });
    const adapter = new PiRuntimeAdapter({ factory: async () => sdk.value });
    const handle = await adapter.start(request()); await Promise.resolve(); await Promise.resolve();
    await expect(adapter.cancel(handle)).rejects.toThrow("abort refused");
    finish(); expect(await adapter.collect(handle)).toMatchObject({ status: "cancelled" });
    expect(sdk.value.dispose).toHaveBeenCalledOnce();
  });
  it("finishes even when cleanup throws, and rejects nonagent or memory execution", async () => {
    const sdk = session(); sdk.value.dispose = () => { throw new Error("private SDK details"); };
    const adapter = new PiRuntimeAdapter({ factory: async () => sdk.value });
    const handle = await adapter.start(request());
    expect((await events(adapter, handle)).at(-1)?.type).toBe("completed");
    await expect(adapter.start({ ...request(), nodeKind: "command" })).rejects.toThrow("agent");
    await expect(adapter.start({ ...request(), workspace: { id: "memory", mode: "memory" } })).rejects.toThrow("filesystem");
  });
});
