import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadWorkflow, type WorkflowDefinition } from "@anastom/core";
import {
  InMemoryDurableRunStore,
  RunStoreError,
  createRunSnapshot,
  type CreateOwnedRun,
  type DurableRunStore,
  type LocalProcessIdentity,
  type RunEvent,
  type RunLeaseToken,
} from "@anastom/engine";

import { SqliteDurableRunStore, createSqliteDurableRunStoreForTesting } from "./durable-store.js";

const roots: string[] = [];
const executeFile = promisify(execFile);
const contenderPath = new URL("./testing/durable-store-contender.ts", import.meta.url);
const ownerOneId = "00000000-0000-4000-8000-000000000001";
const ownerTwoId = "00000000-0000-4000-8000-000000000002";
const ownerOne: LocalProcessIdentity = {
  version: "anastom.dev/local-process/v1alpha1",
  hostIdentityDigest: `sha256:${"1".repeat(64)}`,
  bootIdentityDigest: `sha256:${"2".repeat(64)}`,
  pid: 101,
  startToken: "owner-one-start",
};
const ownerTwo: LocalProcessIdentity = {
  version: "anastom.dev/local-process/v1alpha1",
  hostIdentityDigest: `sha256:${"1".repeat(64)}`,
  bootIdentityDigest: `sha256:${"2".repeat(64)}`,
  pid: 202,
  startToken: "owner-two-start",
};

let workflow: WorkflowDefinition;

beforeAll(async () => {
  workflow = await loadWorkflow("examples/workflows/demo-feature.yaml");
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function initialEvents(runId = "durable"): RunEvent[] {
  return [
    {
      type: "RunCreated",
      runId,
      sequence: 1,
      workflowInstanceId: `${runId}:root`,
      workflowId: workflow.metadata.id,
      workflowVersion: workflow.metadata.version,
      nodeIds: [...workflow.nodeOrder],
      inputs: {},
    },
    {
      type: "NodeReady",
      runId,
      sequence: 2,
      nodeId: "analyze",
      reason: "dependencies-satisfied",
    },
  ];
}

function creation(runId = "durable"): CreateOwnedRun {
  const events = initialEvents(runId);
  return {
    runId,
    workflow,
    initialEvents: events,
    ownerId: ownerOneId,
    owner: ownerOne,
    operationId: "create-operation",
    snapshot: createRunSnapshot(workflow, events),
  };
}

function expectCode(code: RunStoreError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}

async function contend(action: "acquire" | "commit", path: string, value: string) {
  const { stdout } = await executeFile(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), contenderPath.pathname, action, path, value],
    { maxBuffer: 64 * 1024 },
  );
  return JSON.parse(stdout) as {
    outcome: "acquired" | "committed" | "store-error";
    code?: RunStoreError["code"];
    token?: RunLeaseToken;
    receipt?: { replayed: boolean };
  };
}

interface StoreFixture {
  store: DurableRunStore;
  advance(milliseconds: number): void;
  close(): void;
}

const factories: Array<{ name: string; create(): StoreFixture }> = [
  {
    name: "memory",
    create: () => {
      let now = 1_000;
      return {
        store: new InMemoryDurableRunStore(() => now),
        advance: (milliseconds) => {
          now += milliseconds;
        },
        close: () => {},
      };
    },
  },
  {
    name: "SQLite",
    create: () => {
      let now = 1_000;
      const store = createSqliteDurableRunStoreForTesting(":memory:", () => now);
      return {
        store,
        advance: (milliseconds) => {
          now += milliseconds;
        },
        close: () => store.close(),
      };
    },
  },
];

describe.each(factories)("$name durable run store", (factory) => {
  it("creates ownership, immutable history, integrity identity, and snapshot provenance", async () => {
    const fixture = factory.create();
    try {
      const receipt = await fixture.store.createOwned(creation());
      expect(receipt).toMatchObject({
        lease: { runId: "durable", ownerId: ownerOneId, generation: 1 },
        mutation: { firstSequence: 1, lastSequence: 2, replayed: false },
      });
      const execution = await fixture.store.load("durable", "execution");
      expect(execution).toMatchObject({
        state: { runId: "durable", sequence: 2, status: "running" },
        snapshotSource: "snapshot-tail",
        snapshotSequence: 2,
      });
      expect("events" in execution!).toBe(false);
      const inspection = await fixture.store.load("durable", "complete-history");
      expect(inspection?.events).toEqual(initialEvents());
      expect(await fixture.store.load("missing", "execution")).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("fences retries before idempotency lookup and rejects changed operation payloads", async () => {
    const fixture = factory.create();
    try {
      const owned = await fixture.store.createOwned(creation());
      const events: RunEvent[] = [
        {
          type: "ControlRequestObserved",
          runId: "durable",
          sequence: 3,
          operationId: "external-control",
          action: "pause",
          recordedAtMs: 1,
        },
      ];
      const mutation = {
        lease: owned.lease,
        operationId: "append-operation",
        expectedSequence: 2,
        events,
        snapshot: createRunSnapshot(workflow, [...initialEvents(), ...events]),
      };
      expect(await fixture.store.commit(mutation)).toMatchObject({ replayed: false });
      expect(await fixture.store.commit(mutation)).toMatchObject({ replayed: true });
      await expect(fixture.store.commit({ ...mutation, snapshot: undefined })).rejects.toSatisfy(
        expectCode("idempotency-conflict"),
      );
      fixture.advance(15_000);
      await expect(fixture.store.commit(mutation)).rejects.toSatisfy(expectCode("lease-expired"));
    } finally {
      fixture.close();
    }
  });

  it("requires an exact expired observation for takeover and monotonically advances fences", async () => {
    const fixture = factory.create();
    try {
      const owned = await fixture.store.createOwned(creation());
      const observed = await fixture.store.inspectLease("durable");
      fixture.advance(15_000);
      await expect(
        fixture.store.takeoverExpired({
          runId: "durable",
          ownerId: ownerTwoId,
          owner: ownerTwo,
          observedLease: observed!,
          ownerAbsence: { state: "absent", observedAtMs: 15_999 },
        }),
      ).rejects.toSatisfy(expectCode("ownership-conflict"));
      const takeover = await fixture.store.takeoverExpired({
        runId: "durable",
        ownerId: ownerTwoId,
        owner: ownerTwo,
        observedLease: observed!,
        ownerAbsence: { state: "absent", observedAtMs: 16_000 },
      });
      expect(takeover.generation).toBe(owned.lease.generation + 1);
      await expect(
        fixture.store.takeoverExpired({
          runId: "durable",
          ownerId: ownerOneId,
          owner: ownerOne,
          observedLease: observed!,
          ownerAbsence: { state: "absent", observedAtMs: 16_000 },
        }),
      ).rejects.toSatisfy(expectCode("ownership-conflict"));
      await expect(fixture.store.renew(owned.lease)).rejects.toSatisfy(
        expectCode("ownership-conflict"),
      );
    } finally {
      fixture.close();
    }
  });

  it("acquires only released ownership and keeps generation monotonic", async () => {
    const fixture = factory.create();
    try {
      const owned = await fixture.store.createOwned(creation());
      await expect(
        fixture.store.acquireReleased({
          runId: "durable",
          ownerId: ownerTwoId,
          owner: ownerTwo,
        }),
      ).rejects.toSatisfy(expectCode("ownership-conflict"));
      await fixture.store.release(owned.lease);
      await fixture.store.release(owned.lease);
      const acquired = await fixture.store.acquireReleased({
        runId: "durable",
        ownerId: ownerTwoId,
        owner: ownerTwo,
      });
      expect(acquired.generation).toBe(2);
      await expect(fixture.store.release(owned.lease)).rejects.toSatisfy(
        expectCode("ownership-conflict"),
      );
    } finally {
      fixture.close();
    }
  });

  it("deduplicates controls and acknowledges only their exact immutable observation", async () => {
    const fixture = factory.create();
    try {
      const owned = await fixture.store.createOwned(creation());
      const control = await fixture.store.submitControl({
        runId: "durable",
        operationId: "pause-operation",
        action: "pause",
      });
      expect(control.replayed).toBe(false);
      expect(
        await fixture.store.submitControl({
          runId: "durable",
          operationId: "pause-operation",
          action: "pause",
        }),
      ).toMatchObject({ replayed: true, recordedAtMs: control.recordedAtMs });
      await expect(
        fixture.store.submitControl({
          runId: "durable",
          operationId: "pause-operation",
          action: "cancel",
        }),
      ).rejects.toSatisfy(expectCode("control-conflict"));
      expect(await fixture.store.pendingControls("durable")).toEqual([
        {
          runId: "durable",
          operationId: "pause-operation",
          action: "pause",
          recordedAtMs: control.recordedAtMs,
        },
      ]);
      const event: RunEvent = {
        type: "ControlRequestObserved",
        runId: "durable",
        sequence: 3,
        operationId: control.operationId,
        action: control.action,
        recordedAtMs: control.recordedAtMs,
      };
      await fixture.store.commit({
        lease: owned.lease,
        operationId: "observe-control",
        expectedSequence: 2,
        events: [event],
        handlesControlOperationId: control.operationId,
      });
      expect(await fixture.store.pendingControls("durable")).toEqual([]);
      expect(await fixture.store.load("durable", "execution")).toMatchObject({
        state: { sequence: 3 },
        snapshotSource: "snapshot-tail",
        snapshotSequence: 2,
      });
    } finally {
      fixture.close();
    }
  });
});

describe("SQLite durable corruption and contention handling", () => {
  async function databasePath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "anastom-durable-store-"));
    roots.push(root);
    return join(root, "runs.sqlite");
  }

  it("assigns production lease timestamps internally from SQLite", async () => {
    const path = await databasePath();
    const before = Date.now();
    const store = new SqliteDurableRunStore(path);
    await store.createOwned(creation("database-clock"));
    const lease = await store.inspectLease("database-clock");
    const after = Date.now();
    expect(lease?.acquiredAtMs).toBeGreaterThanOrEqual(before - 1);
    expect(lease?.acquiredAtMs).toBeLessThanOrEqual(after + 1);
    expect(lease?.expiresAtMs).toBe(lease!.acquiredAtMs + 15_000);
    store.close();
  });

  it("rejects a durable run whose ownership record is missing", async () => {
    const path = await databasePath();
    const store = new SqliteDurableRunStore(path);
    const owned = await store.createOwned(creation("missing-ownership"));
    await store.release(owned.lease);
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM run_leases WHERE run_id='missing-ownership'");
    raw.close();

    await expect(
      store.acquireReleased({
        runId: "missing-ownership",
        ownerId: ownerTwoId,
        owner: ownerTwo,
      }),
    ).rejects.toSatisfy(expectCode("corrupt-store"));
    store.close();
  });

  it("serializes cross-process lease contenders and replays one physical mutation", async () => {
    const path = await databasePath();
    const store = new SqliteDurableRunStore(path);
    const owned = await store.createOwned(creation("multiprocess"));
    await store.release(owned.lease);
    store.close();

    const acquisitionResults = await Promise.all([
      contend("acquire", path, "00000000-0000-4000-8000-000000000011"),
      contend("acquire", path, "00000000-0000-4000-8000-000000000012"),
    ]);
    const acquired = acquisitionResults.filter((result) => result.outcome === "acquired");
    expect(acquired).toHaveLength(1);
    expect(
      acquisitionResults.filter((result) => result.code === "ownership-conflict"),
    ).toHaveLength(1);
    const token = acquired[0]!.token!;

    const mutationResults = await Promise.all([
      contend("commit", path, JSON.stringify(token)),
      contend("commit", path, JSON.stringify(token)),
    ]);
    expect(mutationResults.map((result) => result.outcome)).toEqual(["committed", "committed"]);
    expect(mutationResults.map((result) => result.receipt?.replayed).sort()).toEqual([false, true]);

    const raw = new DatabaseSync(path);
    expect(
      raw
        .prepare("SELECT count(*) AS count FROM events WHERE run_id='multiprocess' AND sequence=3")
        .get()?.count,
    ).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT count(*) AS count FROM run_mutations WHERE run_id='multiprocess' AND operation_id='shared-mutation'",
        )
        .get()?.count,
    ).toBe(1);
    raw.close();
  });

  it("ignores damaged snapshots but fails closed on damaged authoritative history", async () => {
    const path = await databasePath();
    const store = createSqliteDurableRunStoreForTesting(path, () => 1_000);
    await store.createOwned(creation("damage"));
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE run_snapshots SET state_json='{' WHERE run_id='damage'");
    raw.close();
    const snapshotFallback = createSqliteDurableRunStoreForTesting(path, () => 1_001);
    expect(await snapshotFallback.load("damage", "execution")).toMatchObject({
      snapshotSource: "full-replay",
      state: { sequence: 2 },
    });
    snapshotFallback.close();
    const authoritative = createSqliteDurableRunStoreForTesting(path, () => 1_002);
    const damaged = new DatabaseSync(path);
    damaged.exec(
      "DROP TRIGGER immutable_events_update; UPDATE events SET event_json='{}' WHERE run_id='damage' AND sequence=2",
    );
    damaged.close();
    await expect(authoritative.load("damage", "execution")).rejects.toSatisfy(
      expectCode("corrupt-store"),
    );
    authoritative.close();
  });

  it("enforces immutable mutation, integrity, event, and one-way control evidence", async () => {
    const path = await databasePath();
    const store = createSqliteDurableRunStoreForTesting(path, () => 1_000);
    const owned = await store.createOwned(creation("triggers"));
    const control = await store.submitControl({
      runId: "triggers",
      operationId: "pause-operation",
      action: "pause",
    });
    const event: RunEvent = {
      type: "ControlRequestObserved",
      runId: "triggers",
      sequence: 3,
      operationId: control.operationId,
      action: control.action,
      recordedAtMs: control.recordedAtMs,
    };
    await store.commit({
      lease: owned.lease,
      operationId: "observe-control",
      expectedSequence: 2,
      events: [event],
      handlesControlOperationId: control.operationId,
    });
    store.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE run_mutations SET generation=99")).toThrow("immutable");
    expect(() => raw.exec("DELETE FROM event_integrity")).toThrow("immutable");
    expect(() => raw.exec("DELETE FROM events")).toThrow("append-only");
    expect(() => raw.exec("UPDATE control_requests SET acknowledged_sequence=2")).toThrow(
      "Invalid control acknowledgement",
    );
    raw.close();
  });

  it("reports SQLite lock contention as a typed busy failure", async () => {
    const path = await databasePath();
    const store = createSqliteDurableRunStoreForTesting(path, () => 1_000, 0);
    await store.createOwned(creation("locked"));
    const locker = new DatabaseSync(path);
    try {
      locker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      await expect(
        store.submitControl({
          runId: "locked",
          operationId: "while-locked",
          action: "pause",
        }),
      ).rejects.toSatisfy(expectCode("busy"));
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
      store.close();
    }
  });
});
