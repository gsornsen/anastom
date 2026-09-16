import { lstat, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digestBytes, loadWorkflow } from "@anastom/core";
import { WorkflowEngine } from "@anastom/engine";
import { FakeRuntimeAdapter } from "@anastom/runtime-fake";
import { SqliteRunPersistence, FileArtifactStore } from "./index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "anastom-sqlite-"));
  roots.push(root);
  const path = join(root, "runs.sqlite");
  const store = new SqliteRunPersistence(path);
  const workflow = await loadWorkflow("examples/workflows/demo-feature.yaml");
  const engine = new WorkflowEngine({
    runtime: new FakeRuntimeAdapter({ nodes: {} }),
    persistence: store,
  });
  await engine.createRun(workflow, { runId: "persisted" });
  return { root, path, store, workflow, engine };
}
describe("SQLite run store", () => {
  it("reopens immutable definition and event state from a new instance", async () => {
    const { path, store, engine } = await setup();
    const initial = await engine.inspect("persisted");
    store.close();
    const reopened = new SqliteRunPersistence(path);
    expect((await reopened.load("persisted"))?.events.at(-1)?.sequence).toBe(initial?.sequence);
    expect(await reopened.load("missing")).toBeNull();
    reopened.close();
  });
  it("inspects a pre-negotiation SQLite history after reopening without rewriting event bytes", async () => {
    const { path, store } = await setup();
    const raw = new DatabaseSync(path);
    const bytes = raw
      .prepare("SELECT event_json FROM events WHERE run_id=? ORDER BY sequence")
      .all("persisted") as Array<{ event_json: string }>;
    store.close();
    const reopened = new SqliteRunPersistence(path);
    const inspector = new WorkflowEngine({
      runtime: new FakeRuntimeAdapter({ nodes: {} }),
      persistence: reopened,
    });
    const state = await inspector.inspect("persisted");
    expect(state?.runtimeNegotiation).toBeUndefined();
    expect(state?.sequence).toBe(bytes.length);
    expect(
      raw
        .prepare("SELECT event_json FROM events WHERE run_id=? ORDER BY sequence")
        .all("persisted"),
    ).toEqual(bytes);
    reopened.close();
    raw.close();
  });
  it("rejects sequence conflicts and rolls back invalid event batches", async () => {
    const { path, store, workflow } = await setup();
    const other = new SqliteRunPersistence(path);
    const run = (await store.load("persisted"))!;
    const seq = run.events.at(-1)!.sequence;
    await store.append("persisted", seq, [
      {
        type: "AttemptScheduled",
        runId: "persisted",
        sequence: seq + 1,
        nodeId: "analyze",
        attempt: 1,
        runtimeId: "fake",
      },
    ]);
    await expect(other.append("persisted", seq, [])).rejects.toThrow("expected");
    const saved = (await store.load("persisted"))!;
    await expect(
      store.append("persisted", seq + 1, [
        {
          type: "AttemptStarted",
          runId: "persisted",
          sequence: seq + 2,
          nodeId: "analyze",
          attempt: 1,
        },
        { type: "NodeSucceeded", runId: "persisted", sequence: seq + 3, nodeId: "analyze" },
      ]),
    ).rejects.toThrow();
    expect(await store.load("persisted")).toEqual(saved);
    await expect(store.create("persisted", { workflow, events: run.events })).rejects.toThrow(
      "already exists",
    );
    store.close();
    other.close();
  });
  it("fails closed on mismatched event identities and corrupt digests", async () => {
    const { path, store } = await setup();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE events SET event_type='Unknown'")).toThrow("append-only");
    raw.exec("DROP TRIGGER immutable_events_update");
    raw.exec("UPDATE events SET event_type='Unknown' WHERE sequence=1");
    await expect(store.load("persisted")).rejects.toThrow("identity");
    raw.exec("DROP TRIGGER immutable_runs");
    raw.exec("UPDATE runs SET workflow_digest='bad'");
    await expect(store.load("persisted")).rejects.toThrow("digest");
    raw.close();
    store.close();
  });
  it("validates embedded normalized data even when its digest matches", async () => {
    const { path, store, workflow } = await setup();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER immutable_runs");
    const json = canonicalJson({ ...workflow, nodeOrder: ["missing"] });
    raw.prepare("UPDATE runs SET workflow_json=?, workflow_digest=?").run(json, digestBytes(json));
    await expect(store.load("persisted")).rejects.toThrow("node order");
    raw.close();
    store.close();
  });
  it("rejects a gap or invalid event payload on replay", async () => {
    const { path, store } = await setup();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER immutable_events_update");
    const event = {
      type: "NodeReady",
      runId: "persisted",
      sequence: 2,
      nodeId: "analyze",
      reason: "invented",
    };
    raw.prepare("UPDATE events SET event_json=? WHERE sequence=2").run(JSON.stringify(event));
    await expect(store.load("persisted")).rejects.toThrow("Corrupt run event");
    raw.close();
    store.close();
  });
  it.each(["missing", "gap", "json", "wrong-run"])(
    "rejects %s history rather than guessing state",
    async (damage) => {
      const { path, store } = await setup();
      const raw = new DatabaseSync(path);
      raw.exec("DROP TRIGGER immutable_events_update; DROP TRIGGER immutable_events_delete");
      if (damage === "missing") {
        raw.exec("DELETE FROM events");
      }
      if (damage === "gap") {
        raw.exec("UPDATE events SET sequence=3 WHERE sequence=2");
      }
      if (damage === "json") {
        raw.exec("UPDATE events SET event_json='{' WHERE sequence=1");
      }
      if (damage === "wrong-run") {
        raw.exec(
          'UPDATE events SET event_json=\'{"type":"RunCreated","runId":"different","sequence":1}\' WHERE sequence=1',
        );
      }
      await expect(store.load("persisted")).rejects.toThrow();
      raw.close();
      store.close();
    },
  );
});
describe("filesystem artifacts", () => {
  it("stores immutable bytes and detects tampering", async () => {
    const { root, store } = await setup();
    store.close();
    const artifacts = new FileArtifactStore(root);
    const input = {
      runId: "persisted",
      nodeId: "work",
      attempt: 1,
      type: "diff",
      mediaType: "text/plain",
      bytes: "original",
    };
    const ref = await artifacts.write(input);
    expect(await artifacts.write(input)).toEqual(ref);
    expect((await artifacts.read(ref)).toString()).toBe("original");
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(ref.uri))).mode & 0o777).toBe(0o700);
    expect((await lstat(ref.uri)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(ref.uri))).filter((name) => name.startsWith("."))).toEqual([]);
    const { readFile, writeFile } = await import("node:fs/promises");
    await writeFile(ref.uri, "tampered");
    await expect(artifacts.read(ref)).rejects.toThrow("digest");
    await expect(artifacts.write(input)).rejects.toThrow("differ");
    expect(await readFile(ref.uri, "utf8")).toBe("tampered");
    await expect(artifacts.write({ ...input, runId: "../outside" })).rejects.toThrow("identity");
  });
  it("rejects a run-owned artifact parent redirected outside the state root", async () => {
    const { root, store } = await setup();
    store.close();
    const artifacts = new FileArtifactStore(root);
    const ref = await artifacts.write({
      runId: "redirected",
      nodeId: "work",
      attempt: 1,
      type: "diff",
      mediaType: "text/plain",
      bytes: "original",
    });
    const outside = await mkdtemp(join(dirname(root), "anastom-artifact-outside-"));
    roots.push(outside);
    const runDir = dirname(dirname(ref.uri));
    await rename(runDir, join(outside, "redirected"));
    await symlink(join(outside, "redirected"), runDir, "dir");
    await expect(artifacts.read(ref)).rejects.toThrow("symlink");
  });
});
