import { once } from "node:events";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@anastom/core";
import { ensurePrivatePathRoot, PrivatePathError } from "@anastom/path-policy";
import type { ExecutionPlanRef, LocalProcessIdentity } from "@anastom/engine";
import type { RuntimeEvent } from "@anastom/runtime-contract";
import { afterEach, describe, expect, it } from "vitest";

import { LocalExecutionHost, localProcessIdentity, observeLocalProcess } from "./index.js";
import {
  EXECUTION_PRIVATE_RECORD_MAX_BYTES,
  assertExecutionControlRecord,
  assertExecutionManifestRecord,
  readRecord,
  type ExecutionManifestRecord,
} from "./protocol.js";
import {
  inspectPrivateProcess,
  liveProcessGroup,
  matchesPrivateProcess,
  terminatePrivateProcessGroup,
  waitForCondition,
} from "./process.js";
import { fixturePrepare, fixtureRuntimeHost, type FixtureOwner } from "./testing/fixtures.js";

const owners: FixtureOwner[] = ["pi", "codex", "claude-code", "command"];
const roots = new Set<string>();

interface FixturePaths {
  root: string;
  stateDir: string;
  workspace: string;
}

interface FixtureProcesses {
  leader: number;
  descendant: number | null;
}

interface CoordinatorReady {
  coordinator: LocalProcessIdentity;
  execution: ExecutionPlanRef & { manifestDigest: string };
  sideEffectBeforeAuthorization: boolean;
}

async function fixturePaths(): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), "anastom-execution-host-"));
  roots.add(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  return {
    root,
    stateDir: join(root, "state"),
    workspace,
  };
}

function host(paths: FixturePaths, mode: "normal" | "start-gated" = "normal") {
  return new LocalExecutionHost({
    stateDir: paths.stateDir,
    runtimeHost: fixtureRuntimeHost(mode, mode === "start-gated" ? paths.root : undefined),
  });
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function waitForJson<T>(path: string, description: string): Promise<T> {
  let value: T | undefined;
  await waitForCondition(
    description,
    async () => {
      try {
        value = await readJson<T>(path);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    15_000,
  );
  if (value === undefined) {
    throw new Error(`${description} completed without a record`);
  }
  return value;
}

async function manifest(paths: FixturePaths, execution: ExecutionPlanRef) {
  const root = await ensurePrivatePathRoot(paths.stateDir);
  return readRecord(
    root,
    ["runs", execution.runId, "executions", execution.executionId, "manifest.json"],
    EXECUTION_PRIVATE_RECORD_MAX_BYTES,
    assertExecutionManifestRecord,
  );
}

/** Ignore only the expected identity race while polling an atomically replaced manifest. */
async function stableManifest(
  paths: FixturePaths,
  execution: ExecutionPlanRef,
): Promise<ExecutionManifestRecord | undefined> {
  try {
    return await manifest(paths, execution);
  } catch (error) {
    if (error instanceof PrivatePathError && error.reason === "changed") {
      return undefined;
    }
    throw error;
  }
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const values: RuntimeEvent[] = [];
  for await (const event of events) {
    values.push(event);
  }
  return values;
}

async function processesAbsent(value: FixtureProcesses): Promise<boolean> {
  const leader = await inspectPrivateProcess(value.leader);
  const descendant = value.descendant ? await inspectPrivateProcess(value.descendant) : null;
  return !leader && !descendant;
}

async function cleanupProcesses(value: FixtureProcesses | undefined): Promise<void> {
  if (!value) {
    return;
  }
  const leader = await inspectPrivateProcess(value.leader);
  if (leader) {
    await terminatePrivateProcessGroup(leader, 500).catch(() => false);
  }
  if (value.descendant) {
    const descendant = await inspectPrivateProcess(value.descendant);
    if (descendant) {
      try {
        process.kill(descendant.pid, "SIGKILL");
      } catch {
        // Best-effort test cleanup after an assertion failure.
      }
    }
  }
}

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      let value: FixtureProcesses | undefined;
      try {
        value = await readJson<FixtureProcesses>(join(root, "workspace", "processes.json"));
      } catch {
        // Some cases intentionally stop before a workload exists.
      }
      await cleanupProcesses(value);
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

describe("local execution host", () => {
  it.each(owners)(
    "relays bounded success and confirmed cleanup for %s",
    async (owner) => {
      const paths = await fixturePaths();
      const executionHost = host(paths);
      const input = fixturePrepare(paths.workspace, owner, "success", await localProcessIdentity());
      const persisted = await executionHost.prepare(input);
      expect(await missing(join(paths.workspace, "side-effect.json"))).toBe(true);
      const privateRoot = await ensurePrivatePathRoot(paths.stateDir);
      const control = await readRecord(
        privateRoot,
        ["runs", input.plan.runId, "executions", input.plan.executionId, "control.json"],
        EXECUTION_PRIVATE_RECORD_MAX_BYTES,
        assertExecutionControlRecord,
      );
      let privateResponse: unknown;
      try {
        privateResponse = await executionHost.request(control, "inspect");
      } catch (error) {
        const current = await manifest(paths, input.plan);
        privateResponse = {
          error: error instanceof Error ? error.message : String(error),
          supervisorLive: await matchesPrivateProcess(current.supervisor),
        };
      }
      expect(privateResponse).toMatchObject({ ok: true });
      expect(await executionHost.inspect(input.plan)).toEqual({
        state: "active",
        execution: input.plan,
      });

      const owned = await executionHost.authorize(persisted);
      const eventsWork = drain(owned.events());
      const [events, result] = await Promise.all([eventsWork, owned.collect()]);

      if (owner === "command") {
        expect(result).toMatchObject({ output: { passed: true } });
      } else {
        expect(result).toMatchObject({ status: "succeeded" });
      }
      expect(events[0]).toEqual({ type: "started" });
      expect(events.at(-1)).toEqual({ type: "completed", status: "succeeded" });
      expect(JSON.stringify({ persisted, events, result })).not.toContain("PRIVATE_SENTINEL");
      expect(await executionHost.inspect(input.plan)).toMatchObject({
        state: "absent",
        terminal: { outcome: "succeeded", cleanup: "confirmed" },
      });
    },
    30_000,
  );

  it("confirms process-group cleanup when runtime cancellation does not settle", async () => {
    const paths = await fixturePaths();
    const executionHost = host(paths);
    const input = fixturePrepare(
      paths.workspace,
      "pi",
      "unresponsive-cancel",
      await localProcessIdentity(),
    );
    const persisted = await executionHost.prepare(input);
    const owned = await executionHost.authorize(persisted);
    const observed = await waitForJson<FixtureProcesses>(
      join(paths.workspace, "processes.json"),
      "unresponsive runtime readiness",
    );

    const outcome = await owned.cancel();
    expect(outcome).toMatchObject({
      state: "absent",
      terminal: { outcome: "cancelled", cleanup: "confirmed" },
    });
    await waitForCondition(
      "forced runtime descendant cleanup",
      () => processesAbsent(observed),
      10_000,
    );
  }, 30_000);

  it.each(owners)(
    "cancels and confirms descendant cleanup for %s",
    async (owner) => {
      const paths = await fixturePaths();
      const executionHost = host(paths);
      const input = fixturePrepare(paths.workspace, owner, "hold", await localProcessIdentity());
      const persisted = await executionHost.prepare(input);
      expect(await missing(join(paths.workspace, "side-effect.json"))).toBe(true);
      const owned = await executionHost.authorize(persisted);
      const observed = await waitForJson<FixtureProcesses>(
        join(paths.workspace, "processes.json"),
        "fixture descendant readiness",
      );
      const outcome = await owned.cancel();
      expect(outcome).toMatchObject({
        state: "absent",
        terminal: { outcome: "cancelled", cleanup: "confirmed" },
      });
      await waitForCondition("fixture descendant cleanup", () => processesAbsent(observed), 10_000);
    },
    30_000,
  );

  it("reuses exact preparation and rejects wrong or tampered control authority", async () => {
    const paths = await fixturePaths();
    const executionHost = host(paths);
    const input = fixturePrepare(paths.workspace, "command", "hold", await localProcessIdentity());
    const persisted = await executionHost.prepare(input);
    expect(await executionHost.prepare(input)).toEqual(persisted);
    const root = await ensurePrivatePathRoot(paths.stateDir);
    const segments = ["runs", input.plan.runId, "executions", input.plan.executionId] as const;
    const control = await readRecord(
      root,
      [...segments, "control.json"],
      EXECUTION_PRIVATE_RECORD_MAX_BYTES,
      assertExecutionControlRecord,
    );
    const wrongCapability = `${control.capability.startsWith("a") ? "b" : "a"}${control.capability.slice(1)}`;
    await expect(
      executionHost.request({ ...control, capability: wrongCapability }, "inspect"),
    ).resolves.toMatchObject({ ok: false, category: "unauthorized" });
    await expect(
      executionHost.request({ ...control, generation: control.generation + 1 }, "inspect"),
    ).resolves.toMatchObject({ ok: false, category: "unauthorized" });

    const tampered = { ...control, endpoint: `${control.endpoint}.other` };
    await root.writeFileAtomic(
      [...segments, "control.json"],
      Buffer.from(canonicalJson(tampered)),
      {
        maxBytes: EXECUTION_PRIVATE_RECORD_MAX_BYTES,
      },
    );
    expect(await executionHost.inspect(input.plan)).toMatchObject({
      state: "unknown",
      reason: "identity-mismatch",
    });
    await root.writeFileAtomic([...segments, "control.json"], Buffer.from(canonicalJson(control)), {
      maxBytes: EXECUTION_PRIVATE_RECORD_MAX_BYTES,
    });
    expect(await executionHost.terminate(input.plan)).toMatchObject({
      state: "absent",
      terminal: { outcome: "cancelled", cleanup: "confirmed" },
    });
    expect(await missing(join(paths.workspace, "side-effect.json"))).toBe(true);
  }, 30_000);

  it("bounds retained public observations and accounts for evicted logs", async () => {
    const paths = await fixturePaths();
    const executionHost = host(paths);
    const input = fixturePrepare(paths.workspace, "pi", "pressure", await localProcessIdentity());
    const persisted = await executionHost.prepare(input);
    const owned = await executionHost.authorize(persisted);
    const privateRoot = await ensurePrivatePathRoot(paths.stateDir);
    const control = await readRecord(
      privateRoot,
      ["runs", input.plan.runId, "executions", input.plan.executionId, "control.json"],
      EXECUTION_PRIVATE_RECORD_MAX_BYTES,
      assertExecutionControlRecord,
    );
    await waitForCondition(
      "terminal pressure evidence",
      async () => {
        const response = await executionHost.request(control, "collect");
        return response.ok && response.terminalAvailable === true;
      },
      10_000,
    );
    const result = await owned.collect();
    const events = await drain(owned.events());
    expect(result).toMatchObject({ status: "succeeded" });
    expect(await owned.collect()).toEqual(result);
    expect(events.length).toBeLessThanOrEqual(256);
    expect(events[0]).toEqual({ type: "started" });
    expect(events.at(-1)).toEqual({ type: "completed", status: "succeeded" });
    expect(events.some((event) => event.type === "log" && event.droppedLogs)).toBe(true);
  }, 30_000);

  it.each(owners)(
    "cleans %s after coordinator SIGKILL",
    async (owner) => {
      const paths = await fixturePaths();
      const coordinator = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("testing/fixture-coordinator.ts", import.meta.url)),
          owner,
        ],
        { cwd: paths.root, detached: false, shell: false, stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = once(coordinator, "exit");
      coordinator.stdout.resume();
      let diagnostic = "";
      coordinator.stderr.on("data", (chunk: Buffer) => {
        diagnostic += chunk.toString("utf8");
      });
      let observed: FixtureProcesses | undefined;
      try {
        const ready = await waitForJson<CoordinatorReady>(
          join(paths.root, "coordinator-ready.json"),
          "fixture coordinator readiness",
        );
        expect(ready.sideEffectBeforeAuthorization).toBe(false);
        observed = await readJson<FixtureProcesses>(join(paths.workspace, "processes.json"));
        expect((await observeLocalProcess(ready.coordinator)).state).toBe("alive");
        process.kill(ready.coordinator.pid, "SIGKILL");
        await exited;

        const replacement = host(paths);
        let inspection = await replacement.inspect(ready.execution);
        await waitForCondition(
          "parent-death cleanup evidence",
          async () => {
            inspection = await replacement.inspect(ready.execution);
            return inspection.state === "absent";
          },
          15_000,
        );
        expect(inspection).toMatchObject({
          state: "absent",
          terminal: { outcome: "cancelled", cleanup: "confirmed" },
        });
        await waitForCondition(
          "parent-death descendant cleanup",
          () => processesAbsent(observed!),
          10_000,
        );
      } catch (error) {
        throw new Error(`Coordinator crash case failed${diagnostic ? `: ${diagnostic}` : ""}`, {
          cause: error,
        });
      } finally {
        if (coordinator.exitCode === null && coordinator.signalCode === null) {
          coordinator.kill("SIGKILL");
          await exited;
        }
        await cleanupProcesses(observed);
      }
    },
    40_000,
  );

  it("fails closed after active supervisor loss", async () => {
    const paths = await fixturePaths();
    const executionHost = host(paths);
    const input = fixturePrepare(paths.workspace, "command", "hold", await localProcessIdentity());
    const persisted = await executionHost.prepare(input);
    await executionHost.authorize(persisted);
    const observed = await waitForJson<FixtureProcesses>(
      join(paths.workspace, "processes.json"),
      "active command readiness",
    );
    const current = await manifest(paths, input.plan);
    expect(current.state).toBe("active");
    expect(await matchesPrivateProcess(current.supervisor)).toBe(true);
    process.kill(current.supervisor.pid, "SIGKILL");
    await waitForCondition(
      "lost supervisor absence",
      async () => !(await matchesPrivateProcess(current.supervisor)),
      10_000,
    );
    expect(await executionHost.inspect(input.plan)).toEqual({
      state: "unknown",
      execution: input.plan,
      reason: "supervisor-lost",
    });
    await cleanupProcesses(observed);
  }, 30_000);

  it("persists starting before workload side effects and fails closed if that supervisor dies", async () => {
    const paths = await fixturePaths();
    const executionHost = host(paths, "start-gated");
    const input = fixturePrepare(paths.workspace, "command", "hold", await localProcessIdentity());
    const persisted = await executionHost.prepare(input);
    const authorization = executionHost.authorize(persisted).catch(() => undefined);
    let starting: ExecutionManifestRecord | undefined;
    await waitForCondition(
      "persisted starting state",
      async () => {
        starting = await stableManifest(paths, input.plan);
        return starting?.state === "starting";
      },
      10_000,
    );
    const runtime = await waitForJson<{ pid: number }>(
      join(paths.root, "runtime-host.json"),
      "gated runtime-host readiness",
    );
    expect(await missing(join(paths.workspace, "side-effect.json"))).toBe(true);
    process.kill(starting!.supervisor.pid, "SIGKILL");
    await waitForCondition(
      "starting supervisor absence",
      async () => !(await matchesPrivateProcess(starting!.supervisor)),
      10_000,
    );
    await authorization;
    expect(await executionHost.inspect(input.plan)).toEqual({
      state: "unknown",
      execution: input.plan,
      reason: "supervisor-lost",
    });
    const runtimeIdentity = await inspectPrivateProcess(runtime.pid);
    if (runtimeIdentity) {
      await terminatePrivateProcessGroup(runtimeIdentity, 500);
      await waitForCondition(
        "gated runtime-host cleanup",
        async () => (await liveProcessGroup(runtimeIdentity.processGroupId)).length === 0,
        10_000,
      );
    }
  }, 30_000);
});
