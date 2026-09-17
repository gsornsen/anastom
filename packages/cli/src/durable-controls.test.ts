import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { loadTaskWithinRoot } from "@anastom/core";
import { localProcessIdentity } from "@anastom/execution-host";
import { piRuntimeDescriptorCodec } from "@anastom/runtime-pi";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEndpointRepository,
  healthEndpointTaskPath,
  removeEndpointRepository,
} from "../../engine/src/testing/fixture.js";
import { openDurableCliServices, type DurableRunInspection } from "./durable.js";
import { runCli } from "./index.js";
import { durableRuntimeRegistry } from "./runtime-registry.js";

const pauseOperation = "11111111-1111-4111-8111-111111111111";
const cancelOperation = "22222222-2222-4222-8222-222222222222";
const repeatedCancelOperation = "33333333-3333-4333-8333-333333333333";
const descriptor = piRuntimeDescriptorCodec.parse({
  version: "anastom.dev/runtime-descriptor/v1alpha1",
  runtimeId: "pi",
  configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1",
  configuration: { provider: "anthropic", model: "claude-opus-4-8" },
});

const repositories: string[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await removeEndpointRepository(repository);
  }
});

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
}

async function repository(): Promise<string> {
  const root = await createEndpointRepository();
  repositories.push(root);
  return root;
}

async function seedDurableRun(root: string, runId: string): Promise<string> {
  const workflow = await loadTaskWithinRoot(process.cwd(), healthEndpointTaskPath);
  const stateDir = join(root, ".anastom");
  const services = await openDurableCliServices(stateDir);
  try {
    const workspace = await services.workspaces.create(root, runId, "isolated");
    if (workspace.mode === "memory") {
      throw new Error("Fixture workspace was unexpectedly in memory");
    }
    await services.coordinator.createRun(workflow, { runId, workspace, descriptor });
  } finally {
    services.store.close();
  }
  return stateDir;
}

describe("durable CLI controls and inspection", () => {
  it("registers only exact recoverable runtime descriptors", () => {
    expect(durableRuntimeRegistry.parse(descriptor)).toEqual(descriptor);
    expect(() =>
      durableRuntimeRegistry.parse({
        version: "anastom.dev/runtime-descriptor/v1alpha1",
        runtimeId: "fake",
        configurationVersion: "fixture",
        configuration: {},
      }),
    ).toThrow("Unsupported durable runtime");
  });

  it("pauses and cancels a released run while reporting operational state", async () => {
    const root = await repository();
    const runId = "durable-control";
    const stateDir = await seedDurableRun(root, runId);
    const paused = capture();
    expect(
      await runCli(["pause", runId, "--state-dir", stateDir, "--operation-id", pauseOperation], {
        io: paused.io,
      }),
    ).toBe(0);
    expect(paused.stdout[0]).toBe(`Operation: ${pauseOperation}`);
    expect(paused.stdout.join("\n")).toContain("Control accepted: action=pause");
    expect(paused.stdout.join("\n")).toContain("[paused]");

    const status = capture();
    expect(await runCli(["status", runId, "--state-dir", stateDir], { io: status.io })).toBe(0);
    expect(status.stdout[0]).toContain("Ownership: released");
    expect(status.stdout[0]).toContain("Snapshot: snapshot-tail");
    expect(status.stdout[0]).toContain("Pending controls: 0");
    expect(status.stdout[0]).not.toContain("Events:");

    const cancelled = capture();
    expect(
      await runCli(["cancel", runId, "--state-dir", stateDir, "--operation-id", cancelOperation], {
        io: cancelled.io,
      }),
    ).toBe(0);
    expect(cancelled.stdout.join("\n")).toContain("[cancelled]");

    const alreadyCancelled = capture();
    expect(
      await runCli(
        ["cancel", runId, "--state-dir", stateDir, "--operation-id", repeatedCancelOperation],
        { io: alreadyCancelled.io },
      ),
    ).toBe(0);
    expect(alreadyCancelled.stdout.join("\n")).not.toContain("Control accepted");

    const inspected = capture();
    expect(
      await runCli(["inspect", runId, "--state-dir", stateDir, "--json"], {
        io: inspected.io,
      }),
    ).toBe(0);
    const view = JSON.parse(inspected.stdout[0]!) as DurableRunInspection;
    expect(view.state.status).toBe("cancelled");
    expect(view.ownership.ownerState).toBe("released");
    expect(view.pendingControls).toEqual([]);
    expect(view.snapshot.source).toBe("snapshot-tail");
    expect(view.events?.length).toBeGreaterThan(0);
  });

  it("reports a live owner without acquiring or releasing its lease", async () => {
    const root = await repository();
    const runId = "durable-live-owner";
    const stateDir = await seedDurableRun(root, runId);
    const services = await openDurableCliServices(stateDir);
    const lease = await services.store.acquireReleased({
      runId,
      ownerId: randomUUID(),
      owner: await localProcessIdentity(),
    });
    try {
      const output = capture();
      expect(await runCli(["status", runId, "--state-dir", stateDir], { io: output.io })).toBe(0);
      expect(output.stdout[0]).toContain(`Ownership: live generation=${lease.generation}`);
      expect(await services.store.inspectLease(runId)).toMatchObject({
        ownerId: lease.ownerId,
        generation: lease.generation,
        released: false,
      });
    } finally {
      await services.store.release(lease);
      services.store.close();
    }
  });

  it("rejects invalid operation identifiers before changing a run", async () => {
    const root = await repository();
    const runId = "durable-invalid-operation";
    const stateDir = await seedDurableRun(root, runId);
    const output = capture();
    expect(
      await runCli(["pause", runId, "--state-dir", stateDir, "--operation-id", "not-a-uuid"], {
        io: output.io,
      }),
    ).toBe(2);
    expect(output.stderr).toEqual(["--operation-id must be a UUIDv4"]);

    const status = capture();
    expect(await runCli(["status", runId, "--state-dir", stateDir], { io: status.io })).toBe(0);
    expect(status.stdout[0]).toContain("[running]");
    expect(status.stdout[0]).toContain("Pending controls: 0");
  });

  it("rejects a symlinked durable state root before opening SQLite", async () => {
    const root = await repository();
    const runId = "durable-symlinked-state";
    const stateDir = await seedDurableRun(root, runId);
    const alias = join(root, ".anastom-alias");
    await symlink(stateDir, alias);

    const output = capture();
    expect(await runCli(["status", runId, "--state-dir", alias], { io: output.io })).toBe(1);
    expect(output.stderr).toEqual(["Private state root must be an ordinary directory"]);
  });
});
