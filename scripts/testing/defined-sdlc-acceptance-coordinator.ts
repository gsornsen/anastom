import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonicalJson } from "../../packages/core/src/index.js";
import { DurableRunCoordinator, type RunState } from "../../packages/engine/src/index.js";
import {
  LocalExecutionHost,
  localProcessIdentity,
  observeLocalProcess,
} from "../../packages/execution-host/src/index.js";
import { ensurePrivatePathRoot } from "../../packages/path-policy/src/index.js";
import { FileArtifactStore, SqliteDurableRunStore } from "../../packages/persistence/src/index.js";
import {
  GitWorkspaceManager,
  captureScopedWorkspacePatch,
  captureWorkspaceCheckpoint,
  compareWorkspaceCheckpoints,
  createFeatureTaskWorkspace,
  createFeatureWorkspaceTopology,
  loadFeatureWorkspaceTopology,
  prepareWorkspaceIntegration,
  reconcileWorkspaceIntegration,
} from "../../packages/workspaces/src/index.js";
import { prepareFeatureCommand } from "../../packages/cli/src/feature-command.js";

import {
  DefinedSdlcAcceptanceRuntimeAdapter,
  definedSdlcAcceptanceDescriptor,
  parseDefinedSdlcAcceptanceDescriptor,
  type DefinedSdlcAcceptanceScenario,
} from "./defined-sdlc-acceptance-runtime.js";

type Action = "start" | "resume" | "control";

const [actionValue, repository, runId, scenarioValue, ...rest] = process.argv.slice(2);
const scenarios: readonly DefinedSdlcAcceptanceScenario[] = [
  "left-first",
  "right-first",
  "hold-workers",
  "worker-failure",
  "review-rejection",
  "verifier-failure",
  "integration-crash",
];
if (
  !["start", "resume", "control"].includes(actionValue ?? "") ||
  !repository ||
  !runId ||
  !scenarios.includes(scenarioValue as DefinedSdlcAcceptanceScenario)
) {
  throw new Error("Defined-SDLC coordinator requires an action, repository, run ID, and scenario");
}
const action = actionValue as Action;
const scenario = scenarioValue as DefinedSdlcAcceptanceScenario;
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
      fileURLToPath(new URL("./defined-sdlc-acceptance-runtime-host.ts", import.meta.url)),
      probeRoot.path,
    ],
  },
});

async function shouldInterruptIntegration(): Promise<boolean> {
  if (scenario !== "integration-crash") {
    return false;
  }
  try {
    await probeRoot.readFile([selectedRunId, "integration-reconcile-started.json"], {
      maxBytes: 4_096,
    });
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await probeRoot.ensureDirectory([selectedRunId]);
  await probeRoot.writeFileExclusive(
    [selectedRunId, "integration-reconcile-started.json"],
    Buffer.from(canonicalJson({ runId: selectedRunId, observedAtMs: Date.now() })),
    { maxBytes: 4_096 },
  );
  return true;
}

const coordinator = new DurableRunCoordinator({
  store,
  executionHost,
  artifacts: new FileArtifactStore(stateRoot.path),
  workspace: {
    capture: (workspace) => captureWorkspaceCheckpoint(workspaces, workspace),
    compare: compareWorkspaceCheckpoints,
    async createTaskWorkspace({ runId: selectedRunId, taskId, baseCommit }) {
      const topology = await loadFeatureWorkspaceTopology(workspaces, selectedRunId);
      return createFeatureTaskWorkspace(workspaces, topology, taskId, baseCommit);
    },
    async captureAcceptedPatch({ runId: selectedRunId, workspace, mutationScopes }) {
      const topology = await loadFeatureWorkspaceTopology(workspaces, selectedRunId);
      return captureScopedWorkspacePatch(workspaces, workspace, {
        mutationScopes,
        protectedPaths: topology.protectedPaths,
      });
    },
    async prepareIntegration({ runId: selectedRunId, patches }) {
      const topology = await loadFeatureWorkspaceTopology(workspaces, selectedRunId);
      return prepareWorkspaceIntegration(workspaces, topology.integration, patches);
    },
    async reconcileIntegration({ runId: selectedRunId, preparation }) {
      if (await shouldInterruptIntegration()) {
        await new Promise<never>(() => undefined);
      }
      const topology = await loadFeatureWorkspaceTopology(workspaces, selectedRunId);
      return reconcileWorkspaceIntegration(workspaces, topology.integration, preparation);
    },
  },
  runtimes: {
    parse: (descriptor) =>
      definedSdlcAcceptanceDescriptor(parseDefinedSdlcAcceptanceDescriptor(descriptor)),
    create: async (descriptor) =>
      new DefinedSdlcAcceptanceRuntimeAdapter(
        parseDefinedSdlcAcceptanceDescriptor(descriptor),
        probeRoot.path,
      ),
  },
  owner: await localProcessIdentity(),
  observeProcess: observeLocalProcess,
});

function print(value: unknown): void {
  process.stdout.write(canonicalJson(value) + "\n");
}

async function startRun(): Promise<RunState> {
  const prepared = await prepareFeatureCommand({
    sourceRoot: repositoryPath,
    target: "feature.md",
    repository: repositoryPath,
  });
  const topology = await createFeatureWorkspaceTopology(
    workspaces,
    repositoryPath,
    selectedRunId,
    prepared.protectedPaths,
  );
  return coordinator.start(prepared.workflow, {
    runId: selectedRunId,
    workspace: topology.integration,
    descriptor: definedSdlcAcceptanceDescriptor(scenario),
  });
}

try {
  if (action === "start") {
    print(await startRun());
  } else if (action === "resume") {
    const operationId = rest[0];
    if (!operationId) {
      throw new Error("Defined-SDLC resume requires an operation ID");
    }
    print(await coordinator.resume(selectedRunId, operationId));
  } else {
    const control = rest[0];
    const operationId = rest[1];
    if ((control !== "pause" && control !== "cancel") || !operationId) {
      throw new Error("Defined-SDLC control requires pause|cancel and an operation ID");
    }
    print(await coordinator.submitControl(selectedRunId, control, operationId));
  }
} catch (error) {
  print({
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 3;
} finally {
  store.close();
}
