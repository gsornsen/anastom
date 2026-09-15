import { describe, expect, it, afterEach, vi } from "vitest";
import { loadTask, type WorkflowDefinition } from "@anastom/core";
import type { ExecutionHandle, ExecutionRequest, ExecutionResult } from "@anastom/runtime-contract";
import { RuntimePreflightError } from "@anastom/runtime-contract";
import { FakeRuntimeAdapter } from "@anastom/runtime-fake";
import {
  WorkflowEngine,
  InMemoryRunPersistence,
  buildContext,
  materializeEvents,
} from "./index.js";
import { healthEndpointTaskPath } from "./testing/fixture.js";

const report = {
  summary: "Implemented the requested health endpoint and preserved existing routes.",
  changedFiles: ["server.mjs"],
  notes: [],
};
class RecordingRuntime extends FakeRuntimeAdapter {
  requests: ExecutionRequest[] = [];
  override async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    this.requests.push(request);
    return super.start(request);
  }
}
function fake(
  runtime = new RecordingRuntime({
    nodes: { implement: [{ output: report }], verify: [{ output: {} }] },
  }),
) {
  return {
    runtime,
    engine: new WorkflowEngine({
      runtime,
      persistence: new InMemoryRunPersistence(),
      cancellationGraceMs: 10,
    }),
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("fresh explicit context", () => {
  it("has stable canonical bytes, copies inputs, freezes nested data, and excludes previous attempts", async () => {
    const workflow = await loadTask(healthEndpointTaskPath);
    const runtime = new RecordingRuntime({
      nodes: { implement: [{ output: { wrong: true } }, { output: report }] },
    });
    const { engine } = fake(runtime);
    const mutable = structuredClone(workflow);
    mutable.nodes.implement!.attemptBudget.maxAttempts = 2;
    const initial = await engine.createRun(mutable, { runId: "fresh" });
    const workspace = { id: "fresh", mode: "memory" as const };
    const first = buildContext({
      workflow: mutable,
      state: initial,
      nodeId: "implement",
      attempt: 1,
      workspace,
    });
    expect(
      buildContext({
        workflow: mutable,
        state: structuredClone(initial),
        nodeId: "implement",
        attempt: 1,
        workspace,
      }),
    ).toEqual(first);
    expect(Object.isFrozen(first.envelope.task?.acceptanceCriteria)).toBe(true);
    expect(() => {
      (first.envelope.task!.acceptanceCriteria as string[]).push("hidden state");
    }).toThrow();
    await engine.tick("fresh");
    await engine.tick("fresh");
    expect(runtime.requests).toHaveLength(2);
    const [one, two] = runtime.requests;
    expect(two!.context).not.toBe(one!.context);
    expect(two!.context.attempt).toBe(2);
    expect(two!.context.dependencyOutputs).toEqual({});
    expect(two!.context.artifacts).toEqual([]);
    expect(two!.context).not.toHaveProperty("transcript");
    expect(Object.isFrozen(two!.workspace)).toBe(true);
    expect(Object.isFrozen(two!.budget)).toBe(true);
    expect(Object.isFrozen(two!.requiredOutputSchema)).toBe(true);
    expect(JSON.stringify(two!.context)).not.toContain("wrong");
  });
  it("dispatches only agents to the runtime and persists context before starting it", async () => {
    const workflow = await loadTask(healthEndpointTaskPath);
    const persistence = new InMemoryRunPersistence();
    const runtime = new RecordingRuntime({ nodes: { implement: [{ output: report }] } });
    const start = runtime.start.bind(runtime);
    vi.spyOn(runtime, "start").mockImplementation(async (request) => {
      expect((await persistence.load(request.runId))?.events.at(-1)?.type).toBe("ArtifactProduced");
      return start(request);
    });
    const output = {
      passed: true,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 4,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    const commandExecutor = {
      execute: vi.fn(async () => ({
        output,
        stdout: Buffer.from("pass"),
        stderr: Buffer.alloc(0),
      })),
    };
    const engine = new WorkflowEngine({
      runtime,
      persistence,
      executionMode: "worker",
      commandExecutor,
      artifacts: {
        write: async (value) => ({
          id: value.nodeId + "-" + value.type,
          type: value.type,
          mediaType: value.mediaType,
          uri: "/fixture/artifact",
          digest: "sha256:" + "a".repeat(64),
          producer: { runId: value.runId, nodeId: value.nodeId, attempt: value.attempt },
        }),
      },
    });
    const state = await engine.start(workflow, {
      runId: "dispatch",
      workspace: {
        id: "dispatch",
        mode: "isolated",
        repoRoot: "/fixture",
        path: "/fixture/worktree",
        baseCommit: "base",
        branch: "anastom/dispatch",
      },
    });
    expect(state.status).toBe("succeeded");
    expect(runtime.requests.map((request) => request.nodeKind)).toEqual(["agent"]);
    expect(commandExecutor.execute).toHaveBeenCalledOnce();
    expect(state.nodes.verify?.command).toEqual(output);
    expect(state.artifacts?.map((artifact) => artifact.type)).toEqual([
      "context",
      "logs",
      "worker-report",
      "context",
      "stdout",
      "stderr",
      "command-result",
    ]);
  });
  it("fails unsupported worker nodes before durable creation", async () => {
    const workflow = await loadTask(healthEndpointTaskPath);
    const invalid = structuredClone(workflow);
    invalid.nodes.verify!.kind = "gate";
    const engine = new WorkflowEngine({
      runtime: new FakeRuntimeAdapter({ nodes: {} }),
      persistence: new InMemoryRunPersistence(),
      executionMode: "worker",
      artifacts: { write: () => Promise.reject(new Error("Must not write")) },
    });
    await expect(
      engine.createRun(invalid, {
        workspace: {
          id: "x",
          mode: "readonly",
          path: "/fixture",
          repoRoot: "/fixture",
          baseCommit: "base",
        },
      }),
    ).rejects.toThrow();
  });
  it("stops retry after an adapter stream error because termination is uncertain", async () => {
    const runtime = new RecordingRuntime({ nodes: { implement: [{ output: report }] } });
    vi.spyOn(runtime, "events").mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("stream disconnected")),
      }),
    }));
    const cancel = vi.spyOn(runtime, "cancel");
    const { engine } = fake(runtime);
    await engine.createRun(await timedWorkflow(), { runId: "stream-error" });
    const state = await engine.tick("stream-error");
    expect(state.status).toBe("failed");
    expect(state.nodes.implement?.attempts).toHaveLength(1);
    expect(state.nodes.implement?.failure?.category).toBe("runtime-unavailable");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("persists a typed adapter policy rejection and does not retry it", async () => {
    const runtime = new RecordingRuntime({ nodes: { implement: [{ output: report }] } });
    const start = vi
      .spyOn(runtime, "start")
      .mockRejectedValue(
        new RuntimePreflightError("policy-violation", "Bounded worker policy was rejected"),
      );
    const { engine } = fake(runtime);
    await engine.createRun(await timedWorkflow(), { runId: "policy-rejection" });
    const state = await engine.tick("policy-rejection");
    expect(state.status).toBe("failed");
    expect(state.nodes.implement?.attempts).toHaveLength(1);
    expect(state.nodes.implement?.failure).toEqual({
      category: "policy-violation",
      message: "Bounded worker policy was rejected",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(
      (await engine.events("policy-rejection")).some(
        (event) => event.type === "AttemptFailed" && event.failure.category === "policy-violation",
      ),
    ).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class SlowRuntime extends RecordingRuntime {
  readonly collected = deferred<void>();
  readonly late = deferred<ExecutionResult>();
  readonly started = deferred<void>();
  cancelCount = 0;
  cancellation: "succeeded" | "failed" | "hang" = "succeeded";
  delayedStart = false;
  override async start(request: ExecutionRequest) {
    this.started.resolve();
    if (this.delayedStart) {
      await this.late.promise;
    }
    return super.start(request);
  }
  override async collect(): Promise<ExecutionResult> {
    this.collected.resolve();
    return this.late.promise;
  }
  override async cancel(): Promise<void> {
    this.cancelCount++;
    if (this.cancellation === "failed") {
      throw new Error("cannot cancel");
    }
    if (this.cancellation === "hang") {
      return new Promise(() => {});
    }
    this.late.resolve({ status: "succeeded", output: report });
  }
}
async function timedWorkflow(): Promise<WorkflowDefinition> {
  const workflow = structuredClone(await loadTask(healthEndpointTaskPath));
  workflow.nodes.implement!.attemptBudget = { maxAttempts: 2, maxDurationMs: 1000 };
  return workflow;
}
describe("attempt deadline ownership", () => {
  it("records a timeout, cancels once, retains late success as diagnostic, and consumes an attempt", async () => {
    vi.useFakeTimers();
    const runtime = new SlowRuntime({ nodes: { implement: [{ output: report }] } });
    const { engine } = fake(runtime);
    await engine.createRun(await timedWorkflow(), { runId: "timeout" });
    const running = engine.tick("timeout");
    await runtime.collected.promise;
    await vi.advanceTimersByTimeAsync(1000);
    const state = await running;
    expect(state.nodes.implement?.status).toBe("ready");
    expect(state.nodes.implement?.attempts[0]).toMatchObject({
      status: "failed",
      failure: { category: "budget-exhausted" },
      timeout: { cancellation: "succeeded", lateStatus: "succeeded" },
    });
    expect(runtime.cancelCount).toBe(1);
    const types = (await engine.events("timeout")).map((event) => event.type);
    expect(types.slice(-5)).toEqual([
      "AttemptTimeoutRequested",
      "AttemptCancellationCompleted",
      "LateResultObserved",
      "AttemptFailed",
      "NodeReady",
    ]);
    expect(state.nodes.implement?.output).toBeUndefined();
  });
  it.each(["failed", "hang"] as const)(
    "does not retry when cancellation is %s",
    async (cancellation) => {
      vi.useFakeTimers();
      const runtime = new SlowRuntime({ nodes: { implement: [{ output: report }] } });
      runtime.cancellation = cancellation;
      const { engine } = fake(runtime);
      await engine.createRun(await timedWorkflow(), { runId: "unsafe" });
      const running = engine.tick("unsafe");
      await runtime.collected.promise;
      await vi.advanceTimersByTimeAsync(1021);
      const state = await running;
      expect(state.status).toBe("failed");
      expect(runtime.cancelCount).toBe(1);
      expect(state.nodes.implement?.attempts).toHaveLength(1);
      const saved = await engine.events("unsafe");
      runtime.late.resolve({ status: "succeeded", output: report });
      await Promise.resolve();
      await Promise.resolve();
      expect(await engine.events("unsafe")).toEqual(saved);
    },
  );
  it("cancels a handle that arrives after a start timeout without resurrecting the run", async () => {
    vi.useFakeTimers();
    const runtime = new SlowRuntime({ nodes: { implement: [{ output: report }] } });
    runtime.delayedStart = true;
    const { engine } = fake(runtime);
    await engine.createRun(await timedWorkflow(), { runId: "start-timeout" });
    const running = engine.tick("start-timeout");
    await runtime.started.promise;
    await vi.advanceTimersByTimeAsync(1021);
    expect((await running).status).toBe("failed");
    runtime.late.resolve({ status: "succeeded", output: report });
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.cancelCount).toBe(1);
    expect((await engine.inspect("start-timeout"))?.status).toBe("failed");
  });
  it("accepts a result before the deadline and prevents contradictory timeout transitions", async () => {
    vi.useFakeTimers();
    const { engine } = fake();
    await engine.createRun(await timedWorkflow(), { runId: "first" });
    const state = await engine.tick("first");
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.nodes.implement?.status).toBe("succeeded");
    expect(
      (await engine.events("first")).some((event) => event.type === "AttemptTimeoutRequested"),
    ).toBe(false);
    expect(() =>
      materializeEvents(state, "first", [
        { type: "AttemptTimeoutRequested", nodeId: "implement", attempt: 1 },
      ]),
    ).toThrow();
  });
  it("preserves timeout as the terminal failure when diagnostic artifact writing fails", async () => {
    vi.useFakeTimers();
    const runtime = new SlowRuntime({ nodes: { implement: [{ output: report }] } });
    const engine = new WorkflowEngine({
      runtime,
      persistence: new InMemoryRunPersistence(),
      cancellationGraceMs: 10,
      artifacts: {
        write: async (value) => {
          if (value.type === "logs") {
            throw new Error("diagnostic write failed");
          }
          return {
            id: "context",
            type: "context",
            mediaType: "application/json",
            uri: "/fixture/context",
            digest: "sha256:" + "a".repeat(64),
            producer: { runId: value.runId, nodeId: value.nodeId, attempt: value.attempt },
          };
        },
      },
    });
    const workflow = await timedWorkflow();
    workflow.nodes.implement!.attemptBudget.maxAttempts = 1;
    await engine.createRun(workflow, { runId: "timeout-artifacts" });
    const running = engine.tick("timeout-artifacts");
    await runtime.collected.promise;
    await vi.advanceTimersByTimeAsync(1000);
    const state = await running;
    expect(state.status).toBe("failed");
    expect(state.nodes.implement?.failure?.category).toBe("budget-exhausted");
  });
});
