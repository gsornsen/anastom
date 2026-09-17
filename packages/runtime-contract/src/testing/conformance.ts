import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { workerReportSchema, canonicalJson } from "@anastom/core";
import { probeRuntime, assertRuntimeCapabilities, assertRuntimeEvent } from "../index.js";
import type { ExecutionRequest, RuntimeAdapter, RuntimeEvent } from "../index.js";

export const conformanceReport = {
  summary: "Implemented the requested endpoint while preserving the existing behavior.",
  changedFiles: ["server.mjs"],
  notes: [],
};

export type ConformanceCase =
  "success" | "invalid" | "missing" | "failure" | "pressure" | "cancellable";
export interface ConformanceHarness {
  adapter: RuntimeAdapter;
  requests?: ExecutionRequest[];
  /** Count actual process/session creation, including for a rejected capability probe. */
  started?: () => number;
  /** Inspect synthetic received context/schema and per-attempt resource identity. */
  captured?: () => Promise<
    Array<{ prompt: string; requiredOutputSchema: unknown; resourceId: string }>
  >;
  /** All resources must be released before a terminal result is exposed. */
  finalized?: () => number;
  dispose: () => Promise<void>;
}
export interface ConformanceDriver {
  real: boolean;
  create: (scenario: ConformanceCase) => Promise<ConformanceHarness>;
}

export function conformanceRequest(root: string, attempt = 1): ExecutionRequest {
  return {
    runId: "contract-fixture",
    workflowInstanceId: "contract-fixture:root",
    nodeId: "work",
    nodeKind: "agent",
    attempt,
    workspace: {
      id: "fixture",
      mode: "isolated",
      repoRoot: root,
      path: root,
      baseCommit: "baseline",
      branch: "fixture",
    },
    context: {
      inputs: {},
      dependencyOutputs: {},
      task: {
        id: "fixture",
        version: "0.1.0",
        objective: "Implement the bounded endpoint",
        acceptanceCriteria: ["endpoint passes independent checks"],
      },
    },
    budget: { maxAttempts: 2, maxDurationMs: 5000 },
    requiredOutputSchema: structuredClone(workerReportSchema),
    toolPolicy: { allowMutations: true },
  };
}

export async function drainEvents(
  adapter: RuntimeAdapter,
  handle: { id: string },
): Promise<RuntimeEvent[]> {
  const observed: RuntimeEvent[] = [];
  for await (const event of adapter.events(handle)) {
    assertRuntimeEvent(event);
    observed.push(event);
  }
  return observed;
}

/** The same behavior suite runs against process-backed doubles and the in-memory fake profile. */
export function runtimeConformance(name: string, driver: ConformanceDriver): void {
  describe(name + " shared agent conformance", () => {
    let root: string;
    let harness: ConformanceHarness | undefined;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "anastom-contract-"));
    });
    afterEach(async () => {
      await harness?.dispose();
      await rm(root, { recursive: true, force: true });
    });
    it("validates one filesystem capability decision without executing an attempt", async () => {
      harness = await driver.create("success");
      const snapshot = await harness.adapter.capabilities();
      assertRuntimeCapabilities(snapshot);
      expect(snapshot.workspaceModes).toContain("isolated");
      const decision = await probeRuntime(harness.adapter, "readonly");
      expect(decision.requirements).toEqual({
        workspaceMode: "readonly",
        cancellation: true,
        structuredOutput: "validated",
      });
      expect(harness.requests ?? []).toEqual([]);
      expect(harness.started?.() ?? 0).toBe(0);
      const unsupported = { ...snapshot, workspaceModes: ["readonly" as const] };
      const originalCapabilities = harness.adapter.capabilities.bind(harness.adapter);
      harness.adapter.capabilities = async () => unsupported;
      await expect(probeRuntime(harness.adapter, "isolated")).rejects.toMatchObject({
        category: "policy-violation",
      });
      harness.adapter.capabilities = originalCapabilities;
      decision.capabilities.cancellation = false;
      expect((await harness.adapter.capabilities()).cancellation).toBe(true);
    });
    it("returns ordered finite observations, defensive results and an immutable terminal outcome", async () => {
      harness = await driver.create("success");
      const handle = await harness.adapter.start(conformanceRequest(root));
      const observed = await drainEvents(harness.adapter, handle);
      const result = await harness.adapter.collect(handle);
      expect(observed[0]).toEqual({ type: "started" });
      expect(observed.filter((event) => event.type === "completed")).toEqual([
        { type: "completed", status: result.status },
      ]);
      expect(observed.at(-1)?.type).toBe("completed");
      expect(result).toEqual({ status: "succeeded", output: conformanceReport });
      if (result.status === "succeeded" && result.output && typeof result.output === "object") {
        Reflect.set(result.output, "summary", "caller mutation");
      }
      await Promise.all([harness.adapter.cancel(handle), harness.adapter.cancel(handle)]);
      expect(await harness.adapter.collect(handle)).toEqual({
        status: "succeeded",
        output: conformanceReport,
      });
      expect(JSON.stringify(observed)).not.toContain("PRIVATE_SENTINEL");
      if (driver.real) {
        const usage = observed.filter((event) => event.type === "usage");
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({ scope: "attempt", coverage: "partial" });
        expect(observed.some((event) => event.type === "metadata")).toBe(true);
      } else {
        expect(observed.some((event) => event.type === "usage")).toBe(false);
      }
      expect(harness.finalized?.() ?? 1).toBe(1);
    });
    it("owns request/context snapshots and creates independent resources for the second attempt", async () => {
      harness = await driver.create("success");
      const request = conformanceRequest(root);
      const original = canonicalJson(request);
      const starting = harness.adapter.start(request);
      request.context.task!.objective = "caller mutation";
      request.requiredOutputSchema.additionalProperties = true;
      const first = await starting;
      expect(await harness.adapter.collect(first)).toMatchObject({ status: "succeeded" });
      const second = await harness.adapter.start(conformanceRequest(root, 2));
      expect(second.id).not.toBe(first.id);
      expect(await harness.adapter.collect(second)).toMatchObject({ status: "succeeded" });
      if (harness.requests) {
        expect(canonicalJson(harness.requests[0]!)).toBe(original);
        expect(harness.requests).toHaveLength(2);
        expect(harness.requests[1]?.context.dependencyOutputs).toEqual({});
      }
      if (harness.captured) {
        const captured = await harness.captured();
        expect(captured).toHaveLength(2);
        expect(captured[0]?.prompt).toContain(canonicalJson(conformanceRequest(root).context));
        expect(captured[0]?.prompt).not.toContain("caller mutation");
        expect(captured[0]?.requiredOutputSchema).toEqual(
          conformanceRequest(root).requiredOutputSchema,
        );
        expect(captured[0]?.resourceId).not.toBe(captured[1]?.resourceId);
      }
      expect(harness.finalized?.() ?? 2).toBe(2);
    });
    it.each(["invalid", "missing", "failure"] as const)(
      "classifies %s output and closes the lifecycle",
      async (scenario) => {
        harness = await driver.create(scenario);
        const handle = await harness.adapter.start(conformanceRequest(root));
        const observed = await drainEvents(harness.adapter, handle);
        const result = await harness.adapter.collect(handle);
        if (!driver.real && scenario === "invalid") {
          // The in-memory fake returns scripted output; the engine owns schema validation.
          expect(result.status).toBe("succeeded");
        } else {
          expect(result.status).toBe("failed");
        }
        expect(observed.filter((event) => event.type === "completed")).toEqual([
          { type: "completed", status: result.status },
        ]);
        expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
      },
    );
    it("keeps required observations when logs exceed the real adapter queue bound", async () => {
      harness = await driver.create("pressure");
      const handle = await harness.adapter.start(conformanceRequest(root));
      expect((await harness.adapter.collect(handle)).status).toBe("succeeded");
      const observed = await drainEvents(harness.adapter, handle);
      expect(observed[0]?.type).toBe("started");
      expect(observed.at(-1)).toEqual({ type: "completed", status: "succeeded" });
      if (driver.real) {
        expect(observed.length).toBeLessThanOrEqual(256);
        expect(observed.some((event) => event.type === "log" && event.droppedLogs)).toBe(true);
        expect(observed.some((event) => event.type === "metadata")).toBe(true);
      }
    });
    it("rejects unknown handles deterministically", async () => {
      harness = await driver.create("success");
      const unknown = { id: "unregistered" };
      await expect(harness.adapter.collect(unknown)).rejects.toThrow(/Unknown/);
      await expect(harness.adapter.cancel(unknown)).rejects.toThrow(/Unknown/);
      await expect(drainEvents(harness.adapter, unknown)).rejects.toThrow(/Unknown/);
    });
    if (driver.real) {
      it("coalesces execution cancellation and closes the public stream after cleanup", async () => {
        harness = await driver.create("cancellable");
        const handle = await harness.adapter.start(conformanceRequest(root));
        const stream = harness.adapter.events(handle)[Symbol.asyncIterator]();
        const first = await stream.next();
        if (first.done) {
          throw new Error("Adapter did not start a cancellable execution");
        }
        expect(first.value).toEqual({ type: "started" });
        await vi.waitFor(() => expect(harness?.started?.()).toBe(1));
        await Promise.all([harness.adapter.cancel(handle), harness.adapter.cancel(handle)]);
        const observed: RuntimeEvent[] = [first.value];
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            break;
          }
          observed.push(next.value);
        }
        expect(await harness.adapter.collect(handle)).toMatchObject({ status: "cancelled" });
        expect(observed.at(-1)).toEqual({ type: "completed", status: "cancelled" });
        expect(observed.filter((event) => event.type === "completed")).toHaveLength(1);
        expect(harness.finalized?.()).toBe(1);
      });
      it("rejects memory and non-agent requests before execution", async () => {
        harness = await driver.create("success");
        const request = conformanceRequest(root);
        await expect(harness.adapter.start({ ...request, nodeKind: "command" })).rejects.toThrow(
          /agent/,
        );
        await expect(
          harness.adapter.start({ ...request, workspace: { id: "memory", mode: "memory" } }),
        ).rejects.toThrow(/filesystem/);
        expect(harness.requests ?? []).toEqual([]);
      });
    }
  });
}
