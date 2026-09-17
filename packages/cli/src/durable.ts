import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { digestJson, type WorkflowDefinition } from "@anastom/core";
import {
  DurableRunCoordinator,
  projectEvidenceLedger,
  projectLiveRunEvents,
  renderRunInspection,
  renderRunStatus,
  type ControlRequest,
  type EvidenceLedger,
  type LoadedRun,
  type RunEvent,
  type RunLease,
  type RunState,
} from "@anastom/engine";
import {
  LocalExecutionHost,
  localProcessIdentity,
  observeLocalProcess,
} from "@anastom/execution-host";
import { FileArtifactStore, SqliteDurableRunStore } from "@anastom/persistence";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
import {
  GitWorkspaceManager,
  captureScopedWorkspacePatch,
  captureWorkspaceCheckpoint,
  compareWorkspaceCheckpoints,
  createFeatureTaskWorkspace,
  loadFeatureWorkspaceTopology,
  prepareWorkspaceIntegration,
  reconcileWorkspaceIntegration,
} from "@anastom/workspaces";
import type { LiveRunEvent } from "@anastom/runtime-contract";

import { durableRuntimeRegistry } from "./runtime-registry.js";

type OwnerState = "live" | "expired" | "released" | "unknown";

/**
 * Read-only run state plus mutable local coordination evidence.
 */
export interface DurableRunInspection {
  /** Digest of the immutable workflow definition. */
  definitionDigest: string;
  /** Immutable normalized workflow definition. */
  workflow: WorkflowDefinition;
  /** Event-derived run projection. */
  state: RunState;
  /** Current lease and conservative local owner classification. */
  ownership: { lease: RunLease | null; ownerState: OwnerState };
  /** Oldest-first unacknowledged operator requests. */
  pendingControls: ControlRequest[];
  /** Snapshot source used for this read. */
  snapshot: { source: "snapshot-tail" | "full-replay"; sequence?: number };
  /** Complete authoritative history, present only for inspection. */
  events?: RunEvent[];
  /** Deterministic evidence projection, present only with complete history. */
  evidence?: EvidenceLedger;
  /** Reconnect-equivalent bounded public history, present only with complete history. */
  liveEvents?: LiveRunEvent[];
}

/** Durable storage, execution, workspace, and runtime services owned by one CLI invocation. */
export interface DurableCliServices {
  /** Production fenced SQLite store. */
  store: SqliteDurableRunStore;
  /** Vendor-neutral coordinator composed with local production boundaries. */
  coordinator: DurableRunCoordinator;
  /** Workspace manager used to create the run selection. */
  workspaces: GitWorkspaceManager;
}

/** Presentation callback invoked only after an authoritative event batch is committed. */
export interface DurableCliServiceOptions {
  observeCommittedEvents?: (
    events: readonly RunEvent[],
    state: RunState,
    workflow: WorkflowDefinition,
  ) => void;
}

/** Open the durable run store beneath one validated private-state root. */
export async function openDurableRunStore(stateDir: string): Promise<SqliteDurableRunStore> {
  const state = await ensurePrivatePathRoot(stateDir);
  return new SqliteDurableRunStore(join(state.path, "anastom.sqlite"));
}

/** Compose production storage, process ownership, workspaces, artifacts, and runtimes. */
export async function openDurableCliServices(
  stateDir: string,
  options: DurableCliServiceOptions = {},
): Promise<DurableCliServices> {
  const state = await ensurePrivatePathRoot(stateDir);
  const store = new SqliteDurableRunStore(join(state.path, "anastom.sqlite"));
  try {
    const workspaces = new GitWorkspaceManager(state.path);
    const executionHost = new LocalExecutionHost({
      stateDir: state.path,
      runtimeHost: {
        executable: process.execPath,
        args: [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./runtime-host.ts", import.meta.url)),
        ],
      },
    });
    const coordinator = new DurableRunCoordinator({
      store,
      executionHost,
      artifacts: new FileArtifactStore(state.path),
      workspace: {
        capture: (workspace) => captureWorkspaceCheckpoint(workspaces, workspace),
        compare: compareWorkspaceCheckpoints,
        async createTaskWorkspace({ runId, taskId, baseCommit }) {
          const topology = await loadFeatureWorkspaceTopology(workspaces, runId);
          return createFeatureTaskWorkspace(workspaces, topology, taskId, baseCommit);
        },
        async captureAcceptedPatch({ runId, workspace, mutationScopes }) {
          const topology = await loadFeatureWorkspaceTopology(workspaces, runId);
          return captureScopedWorkspacePatch(workspaces, workspace, {
            mutationScopes,
            protectedPaths: topology.protectedPaths,
          });
        },
        async prepareIntegration({ runId, patches }) {
          const topology = await loadFeatureWorkspaceTopology(workspaces, runId);
          return prepareWorkspaceIntegration(workspaces, topology.integration, patches);
        },
        async reconcileIntegration({ runId, preparation }) {
          const topology = await loadFeatureWorkspaceTopology(workspaces, runId);
          return reconcileWorkspaceIntegration(workspaces, topology.integration, preparation);
        },
      },
      runtimes: durableRuntimeRegistry,
      owner: await localProcessIdentity(),
      observeProcess: observeLocalProcess,
      observeCommittedEvents: options.observeCommittedEvents,
    });
    return { store, coordinator, workspaces };
  } catch (error) {
    store.close();
    throw error;
  }
}

/** Build the accepted read-only inspection view without acquiring or repairing ownership. */
export async function inspectDurableRun(
  store: SqliteDurableRunStore,
  runId: string,
  completeHistory: boolean,
): Promise<DurableRunInspection | null> {
  if (completeHistory) {
    const loaded = await store.load(runId, "complete-history");
    return loaded ? buildInspection(store, runId, loaded, loaded.events) : null;
  }
  const loaded = await store.load(runId, "execution");
  return loaded ? buildInspection(store, runId, loaded) : null;
}

async function buildInspection(
  store: SqliteDurableRunStore,
  runId: string,
  loaded: LoadedRun,
  events?: RunEvent[],
): Promise<DurableRunInspection> {
  const lease = await store.inspectLease(runId);
  const ownerState = await classifyOwner(lease);
  const snapshot: DurableRunInspection["snapshot"] = {
    source: loaded.snapshotSource,
    ...(loaded.snapshotSequence === undefined ? {} : { sequence: loaded.snapshotSequence }),
  };
  return {
    definitionDigest: digestJson(loaded.workflow),
    workflow: loaded.workflow,
    state: loaded.state,
    ownership: { lease, ownerState },
    pendingControls: await store.pendingControls(runId),
    snapshot,
    ...(events ? { events } : {}),
    ...(events ? { evidence: projectEvidenceLedger(loaded.workflow, events) } : {}),
    ...(events ? { liveEvents: projectLiveRunEvents(loaded.workflow, events) } : {}),
  };
}

/** Render event state together with lease, inbox, snapshot, pause, and recovery evidence. */
export function renderDurableRunInspection(view: DurableRunInspection): string {
  const events = view.events;
  const state = events
    ? renderRunInspection(view.state, view.workflow, events)
    : renderRunStatus(view.state, view.workflow);
  const lease = view.ownership.lease;
  const ownership = lease
    ? `Ownership: ${view.ownership.ownerState} generation=${lease.generation} expiresAtMs=${lease.expiresAtMs}`
    : `Ownership: ${view.ownership.ownerState}`;
  const snapshot = `Snapshot: ${view.snapshot.source}${view.snapshot.sequence === undefined ? "" : ` sequence=${view.snapshot.sequence}`}`;
  const controls = `Pending controls: ${view.pendingControls.length}`;
  const diagnostics: string[] = [];
  if (view.evidence) {
    diagnostics.push(
      `Evidence ledger: sequence=${view.evidence.throughSequence} phases=${view.evidence.phases.length}`,
    );
  }
  if (view.state.pauseReason) {
    diagnostics.push(`Pause reason: ${JSON.stringify(view.state.pauseReason)}`);
  }
  if (view.state.recoveryBlock) {
    diagnostics.push(`Recovery blocked: ${JSON.stringify(view.state.recoveryBlock)}`);
  }
  return [state, ownership, snapshot, controls, ...diagnostics].join("\n");
}

async function classifyOwner(lease: RunLease | null): Promise<OwnerState> {
  if (!lease || lease.released) {
    return "released";
  }
  const observation = await observeLocalProcess(lease.owner);
  if (observation.state === "alive") {
    return "live";
  }
  if (observation.state === "unknown") {
    return "unknown";
  }
  return observation.observedAtMs >= lease.expiresAtMs ? "expired" : "unknown";
}
