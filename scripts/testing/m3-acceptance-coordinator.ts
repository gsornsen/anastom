import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonicalJson, loadTaskWithinRoot } from "../../packages/core/src/index.js";
import {
  DurableRunCoordinator,
  RunStoreError,
  type RunEvent,
  type RunState,
} from "../../packages/engine/src/index.js";
import {
  LocalExecutionHost,
  localProcessIdentity,
  observeLocalProcess,
} from "../../packages/execution-host/src/index.js";
import { ensurePrivatePathRoot } from "../../packages/path-policy/src/index.js";
import { FileArtifactStore, SqliteDurableRunStore } from "../../packages/persistence/src/index.js";
import {
  GitWorkspaceManager,
  captureWorkspaceCheckpoint,
  compareWorkspaceCheckpoints,
} from "../../packages/workspaces/src/index.js";

import {
  M3AcceptanceRuntimeAdapter,
  m3AcceptanceDescriptor,
  parseM3AcceptanceDescriptor,
  type M3AcceptanceScenario,
} from "./m3-acceptance-runtime.js";

type Action = "start" | "create" | "resume" | "control" | "stale-append";

const [actionValue, repository, runId, scenarioValue, ...rest] = process.argv.slice(2);
if (
  !["start", "create", "resume", "control", "stale-append"].includes(actionValue ?? "") ||
  !repository ||
  !runId ||
  !["clean", "dirty", "unknown"].includes(scenarioValue ?? "")
) {
  throw new Error("M3 acceptance coordinator requires an action, repository, run ID, and scenario");
}
const action = actionValue as Action;
const scenario = scenarioValue as M3AcceptanceScenario;
const repositoryPath: string = repository;
const selectedRunId: string = runId;
const stateRoot = await ensurePrivatePathRoot(join(repositoryPath, ".anastom"));
const probeRoot = await ensurePrivatePathRoot(join(stateRoot.path, "acceptance-probes"));
const store = new SqliteDurableRunStore(join(stateRoot.path, "anastom.sqlite"));
const workspaces = new GitWorkspaceManager(stateRoot.path);
const executionHost = new LocalExecutionHost({
  stateDir: stateRoot.path,
  runtimeHost: {
    executable: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("./m3-acceptance-runtime-host.ts", import.meta.url)),
      probeRoot.path,
    ],
  },
});
const coordinator = new DurableRunCoordinator({
  store,
  executionHost,
  artifacts: new FileArtifactStore(stateRoot.path),
  workspace: {
    capture: (workspace) => captureWorkspaceCheckpoint(workspaces, workspace),
    compare: compareWorkspaceCheckpoints,
  },
  runtimes: {
    parse: (descriptor) => m3AcceptanceDescriptor(parseM3AcceptanceDescriptor(descriptor)),
    create: async (descriptor) =>
      new M3AcceptanceRuntimeAdapter(parseM3AcceptanceDescriptor(descriptor), probeRoot.path),
  },
  owner: await localProcessIdentity(),
  observeProcess: observeLocalProcess,
});

function print(value: unknown): void {
  process.stdout.write(canonicalJson(value) + "\n");
}

async function createRun(start: boolean): Promise<RunState> {
  const workflow = await loadTaskWithinRoot(repositoryPath, "tasks/m3-recovery.md");
  const workspace = await workspaces.create(repositoryPath, selectedRunId, "isolated");
  if (workspace.mode !== "isolated") {
    throw new Error("M3 acceptance workspace was not isolated");
  }
  await probeRoot.ensureDirectory([selectedRunId]);
  await probeRoot.writeFileAtomic(
    [selectedRunId, "setup.json"],
    Buffer.from(canonicalJson({ runId: selectedRunId, scenario, workspace })),
    { maxBytes: 16 * 1024 },
  );
  const options = {
    runId: selectedRunId,
    workspace,
    descriptor: m3AcceptanceDescriptor(scenario),
  };
  return start ? coordinator.start(workflow, options) : coordinator.createRun(workflow, options);
}

try {
  if (action === "start" || action === "create") {
    print(await createRun(action === "start"));
  } else if (action === "resume") {
    const operationId = rest[0];
    if (!operationId) {
      throw new Error("M3 acceptance resume requires an operation ID");
    }
    print(await coordinator.resume(selectedRunId, operationId));
  } else if (action === "control") {
    const control = rest[0];
    const operationId = rest[1];
    if ((control !== "pause" && control !== "cancel") || !operationId) {
      throw new Error("M3 acceptance control requires pause|cancel and an operation ID");
    }
    print(await coordinator.submitControl(selectedRunId, control, operationId));
  } else {
    const ownerId = rest[0];
    const generation = Number(rest[1]);
    const expectedSequence = Number(rest[2]);
    if (
      !ownerId ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(expectedSequence) ||
      expectedSequence < 1
    ) {
      throw new Error("M3 stale append requires the old fence and expected sequence");
    }
    const event: RunEvent = {
      runId: selectedRunId,
      sequence: expectedSequence + 1,
      type: "RunPaused",
    };
    print(
      await store.commit({
        lease: { runId: selectedRunId, ownerId, generation },
        operationId: "stale-owner-append",
        expectedSequence,
        events: [event],
      }),
    );
  }
} catch (error) {
  const reason =
    error && typeof error === "object" && "reason" in error
      ? (error as { reason?: unknown }).reason
      : undefined;
  print({
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof RunStoreError ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
      ...(reason === undefined ? {} : { reason }),
    },
  });
  process.exitCode = 3;
} finally {
  store.close();
}
