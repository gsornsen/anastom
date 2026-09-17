import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, digestBytes, type WorkflowDefinition } from "../packages/core/src/index.js";
import {
  materializeEvents,
  replayRun,
  type RunEvent,
  type RunEventPayload,
} from "../packages/engine/src/index.js";
import type { RuntimeNegotiation } from "../packages/runtime-contract/src/index.js";
import {
  createM3Snapshot,
  loadM3SnapshotProjection,
  type M3SnapshotDefinitionIdentity,
  type M3SnapshotRecord,
  type M3SnapshotRejection,
} from "./m3-snapshot.js";

interface LifecycleFixture {
  label: "m1" | "m2" | "m2.5" | "paused";
  runId: string;
  workflow: WorkflowDefinition;
  events: RunEvent[];
  snapshotSequence: number;
}

/** Model-free evidence for snapshot integrity, tail replay, and authoritative fallback. */
export interface M3SnapshotEvidence {
  version: "anastom.dev/m3-snapshot-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  equality: {
    lifecycleShapesMatchFullReplay: boolean;
    emptyTailMatchesFullReplay: boolean;
    newestCompatibleSnapshotSelected: boolean;
    snapshotInputsRemainImmutable: boolean;
  };
  fallback: {
    absentSnapshot: boolean;
    unknownVersion: boolean;
    unknownReducer: boolean;
    invalidRecord: boolean;
    runMismatch: boolean;
    definitionMismatch: boolean;
    futureSequence: boolean;
    oversizedState: boolean;
    digestMismatch: boolean;
    eventPrefixMismatch: boolean;
    malformedState: boolean;
    noncanonicalState: boolean;
    schemaInvalidState: boolean;
    stateIdentityMismatch: boolean;
    tailContradiction: boolean;
  };
  authority: {
    changedValidPrefixUsesFullReplay: boolean;
    semanticEventCorruptionRejected: boolean;
    invalidEventShapeRejectedBeforeSnapshot: boolean;
    sequenceGapRejectedBeforeSnapshot: boolean;
  };
  compatibility: {
    m1HistoryWithoutSnapshot: boolean;
    m2HistoryWithoutSnapshot: boolean;
    m25HistoryWithoutSnapshot: boolean;
    reopenedDefinitionsRetainDigest: boolean;
  };
  conclusion: {
    snapshotTailReplay: "feasible";
    corruptSnapshotFallback: "feasible";
    eventsRemainAuthoritative: true;
    eventPrefixBinding: "required";
    publicPersistenceApiFrozen: false;
  };
}

const capabilities = {
  streaming: true,
  cancellation: true,
  resumableSession: false,
  nativeSubagents: false,
  mcp: false,
  lsp: false,
  debugger: false,
  browser: false,
  structuredOutput: "native" as const,
  usageReporting: "partial" as const,
  sandboxing: ["isolated-fixture"],
  workspaceModes: ["isolated" as const],
};

function negotiation(runtimeId: string): RuntimeNegotiation {
  return {
    version: "anastom.dev/runtime-negotiation/v1alpha1",
    runtimeId,
    requirements: {
      workspaceMode: "isolated",
      cancellation: true,
      structuredOutput: "validated",
    },
    capabilities,
  };
}

function workflow(label: string): WorkflowDefinition {
  return {
    apiVersion: "anastom.dev/v1alpha1",
    kind: "Workflow",
    metadata: { id: `snapshot/${label}`, version: "0.1.0" },
    sourcePath: `/fixture/${label}.yaml`,
    inputs: {},
    policies: { defaultAttemptBudget: { maxAttempts: 2 }, maxParallel: 1 },
    nodeOrder: ["work"],
    nodes: {
      work: {
        id: "work",
        kind: "agent",
        needs: [],
        role: "fixture-worker",
        output: { ref: `${label}.schema.json`, schema: { type: "object" } },
        attemptBudget: { maxAttempts: 2 },
        mutation: "isolated",
      },
    },
  };
}

function created(runId: string, definition: WorkflowDefinition): RunEventPayload {
  return {
    type: "RunCreated",
    workflowInstanceId: `${runId}:root`,
    workflowId: definition.metadata.id,
    workflowVersion: definition.metadata.version,
    nodeIds: [...definition.nodeOrder],
    inputs: {},
  };
}

function fixture(
  label: LifecycleFixture["label"],
  payloads: RunEventPayload[],
  snapshotSequence: number,
): LifecycleFixture {
  const runId = `snapshot-${label.replace(".", "-")}`;
  const definition = workflow(label);
  const events = materializeEvents(undefined, runId, [
    created(runId, definition),
    ...payloads,
  ]).events;
  return { label, runId, workflow: definition, events, snapshotSequence };
}

function lifecycleFixtures(): LifecycleFixture[] {
  return [
    fixture(
      "m1",
      [
        { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
        { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "pi" },
        { type: "AttemptStarted", nodeId: "work", attempt: 1 },
        {
          type: "RuntimeEventObserved",
          nodeId: "work",
          attempt: 1,
          event: { type: "metadata", provider: "anthropic", model: "legacy" },
        },
        { type: "AttemptSucceeded", nodeId: "work", attempt: 1, output: { accepted: true } },
        { type: "NodeSucceeded", nodeId: "work" },
        { type: "RunCompleted", outcome: "succeeded" },
      ],
      4,
    ),
    fixture(
      "m2",
      [
        { type: "RuntimeNegotiated", negotiation: negotiation("codex") },
        { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
        { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "codex" },
        { type: "AttemptStarted", nodeId: "work", attempt: 1 },
        {
          type: "RuntimeEventObserved",
          nodeId: "work",
          attempt: 1,
          event: { type: "metadata", provider: "openai", model: "fixture", source: "configured" },
        },
        {
          type: "AttemptFailed",
          nodeId: "work",
          attempt: 1,
          failure: { category: "tool", message: "retry fixture" },
        },
        { type: "NodeReady", nodeId: "work", reason: "retry" },
        { type: "AttemptScheduled", nodeId: "work", attempt: 2, runtimeId: "codex" },
        { type: "AttemptStarted", nodeId: "work", attempt: 2 },
        {
          type: "RuntimeEventObserved",
          nodeId: "work",
          attempt: 2,
          event: {
            type: "usage",
            scope: "attempt",
            coverage: "partial",
            inputTokens: 100,
            outputTokens: 20,
          },
        },
        { type: "AttemptSucceeded", nodeId: "work", attempt: 2, output: { accepted: true } },
        { type: "NodeSucceeded", nodeId: "work" },
        { type: "RunCompleted", outcome: "succeeded" },
      ],
      8,
    ),
    fixture(
      "m2.5",
      [
        { type: "RuntimeNegotiated", negotiation: negotiation("claude-code") },
        {
          type: "WorkspaceAssigned",
          workspace: {
            id: "snapshot-m2-5",
            mode: "isolated",
            repoRoot: "/fixture/repository",
            path: "/fixture/repository/.anastom/worktrees/snapshot-m2-5",
            branch: "anastom/snapshot-m2-5",
            baseCommit: "base-fixture",
          },
        },
        { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
        { type: "AttemptScheduled", nodeId: "work", attempt: 1, runtimeId: "claude-code" },
        { type: "AttemptStarted", nodeId: "work", attempt: 1 },
        {
          type: "RuntimeEventObserved",
          nodeId: "work",
          attempt: 1,
          event: {
            type: "metadata",
            provider: "anthropic",
            model: "fixture",
            source: "reported",
            runtimeVersion: "fixture",
          },
        },
        {
          type: "ArtifactProduced",
          nodeId: "work",
          attempt: 1,
          artifact: {
            id: "snapshot-diff",
            type: "diff",
            mediaType: "text/x-diff",
            uri: "/fixture/artifacts/snapshot-diff",
            digest: `sha256:${"a".repeat(64)}`,
            producer: { runId: "snapshot-m2-5", nodeId: "work", attempt: 1 },
          },
        },
        {
          type: "WorkspaceObserved",
          nodeId: "work",
          attempt: 1,
          headCommit: "head-fixture",
          changedFiles: ["fixture.txt"],
          diffArtifactId: "snapshot-diff",
        },
        { type: "AttemptBlocked", nodeId: "work", attempt: 1, reason: "fixture blocked" },
        { type: "NodeBlocked", nodeId: "work", reason: "fixture blocked" },
        { type: "RunBlocked", reason: "fixture blocked" },
      ],
      5,
    ),
    fixture(
      "paused",
      [
        { type: "NodeReady", nodeId: "work", reason: "dependencies-satisfied" },
        { type: "RunPaused" },
        { type: "NodePaused", nodeId: "work" },
        { type: "RunResumed" },
        { type: "NodeReady", nodeId: "work", reason: "resumed" },
        { type: "NodeCancelled", nodeId: "work", reason: "fixture cancel" },
        { type: "RunCancelled", reason: "fixture cancel" },
      ],
      4,
    ),
  ];
}

function definitionIdentity(value: LifecycleFixture): M3SnapshotDefinitionIdentity {
  return {
    runId: value.runId,
    workflowId: value.workflow.metadata.id,
    workflowVersion: value.workflow.metadata.version,
    definitionDigest: digestBytes(canonicalJson(value.workflow)),
    nodeIds: [...value.workflow.nodeOrder],
  };
}

function snapshotWithState(
  snapshot: M3SnapshotRecord,
  mutate: (state: Record<string, unknown>) => void,
): M3SnapshotRecord {
  const changed = structuredClone(snapshot);
  const state = JSON.parse(changed.stateJson) as Record<string, unknown>;
  mutate(state);
  changed.stateJson = canonicalJson(state);
  changed.stateDigest = digestBytes(changed.stateJson);
  return changed;
}

function rejectedAs(
  result: ReturnType<typeof loadM3SnapshotProjection>,
  rejection: M3SnapshotRejection,
): boolean {
  return result.source === "full-replay" && result.rejected.includes(rejection);
}

function equivalent(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function throws(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function allEvidencePassed(evidence: M3SnapshotEvidence): boolean {
  return [evidence.equality, evidence.fallback, evidence.authority, evidence.compatibility].every(
    (section) => Object.values(section).every(Boolean),
  );
}

type LoadResult = ReturnType<typeof loadM3SnapshotProjection>;

interface EqualityOutcomes {
  lifecycleMatches: boolean;
  emptyTail: LoadResult;
  fullState: unknown;
  newestCompatible: LoadResult;
  expectedSequence: number;
  immutableCandidates: unknown[];
  immutableBefore: string;
}

function buildEqualityEvidence(outcomes: EqualityOutcomes): M3SnapshotEvidence["equality"] {
  return {
    lifecycleShapesMatchFullReplay: outcomes.lifecycleMatches,
    emptyTailMatchesFullReplay:
      outcomes.emptyTail.source === "snapshot-tail" &&
      equivalent(outcomes.emptyTail.state, outcomes.fullState),
    newestCompatibleSnapshotSelected:
      outcomes.newestCompatible.source === "snapshot-tail" &&
      outcomes.newestCompatible.snapshotSequence === outcomes.expectedSequence &&
      outcomes.newestCompatible.rejected.includes("unknown-version"),
    snapshotInputsRemainImmutable:
      canonicalJson(outcomes.immutableCandidates) === outcomes.immutableBefore,
  };
}

interface FallbackOutcomes {
  noSnapshot: LoadResult;
  unknownVersion: LoadResult;
  unknownReducer: LoadResult;
  invalidRecord: LoadResult;
  runMismatch: LoadResult;
  definitionMismatch: LoadResult;
  futureSequence: LoadResult;
  oversizedState: LoadResult;
  digestMismatch: LoadResult;
  prefixMismatch: LoadResult;
  malformedState: LoadResult;
  noncanonicalState: LoadResult;
  schemaInvalidState: LoadResult;
  stateIdentityMismatch: LoadResult;
  tailContradiction: LoadResult;
}

function buildFallbackEvidence(outcomes: FallbackOutcomes): M3SnapshotEvidence["fallback"] {
  return {
    absentSnapshot:
      outcomes.noSnapshot.source === "full-replay" && outcomes.noSnapshot.rejected.length === 0,
    unknownVersion: rejectedAs(outcomes.unknownVersion, "unknown-version"),
    unknownReducer: rejectedAs(outcomes.unknownReducer, "unknown-reducer"),
    invalidRecord: rejectedAs(outcomes.invalidRecord, "invalid-record"),
    runMismatch: rejectedAs(outcomes.runMismatch, "run-mismatch"),
    definitionMismatch: rejectedAs(outcomes.definitionMismatch, "definition-mismatch"),
    futureSequence: rejectedAs(outcomes.futureSequence, "sequence-out-of-range"),
    oversizedState: rejectedAs(outcomes.oversizedState, "state-too-large"),
    digestMismatch: rejectedAs(outcomes.digestMismatch, "state-digest-mismatch"),
    eventPrefixMismatch: rejectedAs(outcomes.prefixMismatch, "event-prefix-mismatch"),
    malformedState: rejectedAs(outcomes.malformedState, "malformed-state"),
    noncanonicalState: rejectedAs(outcomes.noncanonicalState, "noncanonical-state"),
    schemaInvalidState: rejectedAs(outcomes.schemaInvalidState, "invalid-state"),
    stateIdentityMismatch: rejectedAs(outcomes.stateIdentityMismatch, "state-identity-mismatch"),
    tailContradiction: rejectedAs(outcomes.tailContradiction, "tail-conflict"),
  };
}

interface AuthorityOutcomes {
  prefixMismatch: LoadResult;
  semanticallyCorrupt: RunEvent[];
  invalidShape: Array<Record<string, unknown>>;
  sequenceGap: RunEvent[];
  identity: M3SnapshotDefinitionIdentity;
  snapshot: M3SnapshotRecord;
}

function buildAuthorityEvidence(outcomes: AuthorityOutcomes): M3SnapshotEvidence["authority"] {
  return {
    changedValidPrefixUsesFullReplay:
      outcomes.prefixMismatch.source === "full-replay" &&
      outcomes.prefixMismatch.state.nodes.work?.attempts[0]?.identity?.[0]?.model ===
        "changed-authoritative-model",
    semanticEventCorruptionRejected: throws(() =>
      loadM3SnapshotProjection(outcomes.identity, outcomes.semanticallyCorrupt, [
        outcomes.snapshot,
      ]),
    ),
    invalidEventShapeRejectedBeforeSnapshot: throws(() =>
      loadM3SnapshotProjection(outcomes.identity, outcomes.invalidShape as unknown as RunEvent[], [
        outcomes.snapshot,
      ]),
    ),
    sequenceGapRejectedBeforeSnapshot: throws(() =>
      loadM3SnapshotProjection(outcomes.identity, outcomes.sequenceGap, [outcomes.snapshot]),
    ),
  };
}

interface CompatibilityOutcomes {
  fixtures: LifecycleFixture[];
  loaded: Array<{ workflow: WorkflowDefinition; events: RunEvent[] } | null>;
  noSnapshot: LoadResult;
}

function buildCompatibilityEvidence(
  outcomes: CompatibilityOutcomes,
): M3SnapshotEvidence["compatibility"] {
  return {
    m1HistoryWithoutSnapshot:
      loadM3SnapshotProjection(
        definitionIdentity(outcomes.fixtures[0]!),
        outcomes.loaded[0]?.events ?? [],
        [],
      ).source === "full-replay",
    m2HistoryWithoutSnapshot: outcomes.noSnapshot.source === "full-replay",
    m25HistoryWithoutSnapshot:
      loadM3SnapshotProjection(
        definitionIdentity(outcomes.fixtures[2]!),
        outcomes.loaded[2]?.events ?? [],
        [],
      ).source === "full-replay",
    reopenedDefinitionsRetainDigest: outcomes.fixtures.every(
      (value, index) =>
        outcomes.loaded[index] !== null &&
        digestBytes(canonicalJson(outcomes.loaded[index]!.workflow)) ===
          definitionIdentity(value).definitionDigest,
    ),
  };
}

async function persistFixtures(path: string, fixtures: LifecycleFixture[]): Promise<void> {
  await writeFile(
    path,
    canonicalJson(fixtures.map(({ runId, workflow, events }) => ({ runId, workflow, events }))),
  );
}

async function reopenFixtures(
  path: string,
  fixtures: LifecycleFixture[],
): Promise<Array<{ workflow: WorkflowDefinition; events: RunEvent[] } | null>> {
  const stored = JSON.parse(await readFile(path, "utf8")) as Array<{
    runId: string;
    workflow: WorkflowDefinition;
    events: RunEvent[];
  }>;
  return fixtures.map(({ runId }) => {
    const record = stored.find((candidate) => candidate.runId === runId);
    return record ? { workflow: record.workflow, events: record.events } : null;
  });
}

/** Run snapshot/tail equality and fail-safe fallback against reopened current histories. */
export async function runM3SnapshotProbe(): Promise<M3SnapshotEvidence> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m3-snapshot-"));
  const path = join(root, "runs.json");
  const fixtures = lifecycleFixtures();
  try {
    await persistFixtures(path, fixtures);
    const loaded = await reopenFixtures(path, fixtures);
    if (loaded.some((run) => run === null)) {
      throw new Error("Snapshot compatibility fixtures did not reopen");
    }

    const snapshots = fixtures.map((value, index) => {
      const events = loaded[index]?.events ?? [];
      return createM3Snapshot(definitionIdentity(value), events, value.snapshotSequence);
    });
    const lifecycleMatches = fixtures.every((value, index) => {
      const events = loaded[index]?.events ?? [];
      const result = loadM3SnapshotProjection(definitionIdentity(value), events, [
        snapshots[index],
      ]);
      return result.source === "snapshot-tail" && equivalent(result.state, replayRun(events));
    });

    const selected = fixtures[1]!;
    const events = loaded[1]?.events ?? [];
    const identity = definitionIdentity(selected);
    const snapshot = snapshots[1]!;
    const fullSnapshot = createM3Snapshot(identity, events, events.length);
    const emptyTail = loadM3SnapshotProjection(identity, events, [fullSnapshot]);
    const unknownNewest = { ...fullSnapshot, version: "anastom.dev/m3-run-snapshot/future" };
    const newestCompatible = loadM3SnapshotProjection(identity, events, [unknownNewest, snapshot]);
    const immutableCandidates = [structuredClone(snapshot)];
    const immutableBefore = canonicalJson(immutableCandidates);
    loadM3SnapshotProjection(identity, events, immutableCandidates);

    const noSnapshot = loadM3SnapshotProjection(identity, events, []);
    const unknownVersion = loadM3SnapshotProjection(identity, events, [unknownNewest]);
    const unknownReducer = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, reducerVersion: "anastom.dev/run-reducer/future" },
    ]);
    const invalidRecord = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, unexpected: true },
    ]);
    const runMismatch = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, runId: "another-run" },
    ]);
    const definitionMismatch = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, definitionDigest: digestBytes("another-definition") },
    ]);
    const futureSequence = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, sequence: events.length + 1 },
    ]);
    const oversizedJson = "x".repeat(4_194_305);
    const oversizedState = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, stateJson: oversizedJson, stateDigest: digestBytes(oversizedJson) },
    ]);
    const digestMismatch = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, stateDigest: digestBytes("different") },
    ]);
    const malformedJson = "{";
    const malformedState = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, stateJson: malformedJson, stateDigest: digestBytes(malformedJson) },
    ]);
    const prettyJson = JSON.stringify(JSON.parse(snapshot.stateJson), null, 2);
    const noncanonicalState = loadM3SnapshotProjection(identity, events, [
      { ...snapshot, stateJson: prettyJson, stateDigest: digestBytes(prettyJson) },
    ]);
    const invalidState = snapshotWithState(snapshot, (state) => delete state.nodes);
    const schemaInvalidState = loadM3SnapshotProjection(identity, events, [invalidState]);
    const wrongStateIdentity = snapshotWithState(snapshot, (state) => {
      state.runId = "another-run";
    });
    const stateIdentityMismatch = loadM3SnapshotProjection(identity, events, [wrongStateIdentity]);
    const contradictoryState = snapshotWithState(snapshot, (state) => {
      const nodes = state.nodes as Record<string, Record<string, unknown>>;
      if (nodes.work) {
        nodes.work.status = "pending";
      }
    });
    const tailContradiction = loadM3SnapshotProjection(identity, events, [contradictoryState]);

    const changedEvents = structuredClone(events);
    const metadata = changedEvents.find(
      (event) => event.type === "RuntimeEventObserved" && event.event.type === "metadata",
    );
    if (
      !metadata ||
      metadata.type !== "RuntimeEventObserved" ||
      metadata.event.type !== "metadata"
    ) {
      throw new Error("Snapshot fixture metadata event is missing");
    }
    metadata.event.model = "changed-authoritative-model";
    const prefixMismatch = loadM3SnapshotProjection(identity, changedEvents, [snapshot]);

    const semanticallyCorrupt = structuredClone(events);
    const ready = semanticallyCorrupt.find((event) => event.type === "NodeReady");
    if (!ready || ready.type !== "NodeReady") {
      throw new Error("Snapshot fixture ready event is missing");
    }
    ready.reason = "retry";
    const invalidShape = structuredClone(events) as unknown as Array<Record<string, unknown>>;
    invalidShape[1] = { type: "Invented", runId: identity.runId, sequence: 2 };
    const sequenceGap = structuredClone(events);
    sequenceGap[1] = { ...sequenceGap[1]!, sequence: 99 };

    const evidence: M3SnapshotEvidence = {
      version: "anastom.dev/m3-snapshot-evidence/v1alpha1",
      platform: process.platform,
      architecture: process.arch,
      equality: buildEqualityEvidence({
        lifecycleMatches,
        emptyTail,
        fullState: replayRun(events),
        newestCompatible,
        expectedSequence: snapshot.sequence,
        immutableCandidates,
        immutableBefore,
      }),
      fallback: buildFallbackEvidence({
        noSnapshot,
        unknownVersion,
        unknownReducer,
        invalidRecord,
        runMismatch,
        definitionMismatch,
        futureSequence,
        oversizedState,
        digestMismatch,
        prefixMismatch,
        malformedState,
        noncanonicalState,
        schemaInvalidState,
        stateIdentityMismatch,
        tailContradiction,
      }),
      authority: buildAuthorityEvidence({
        prefixMismatch,
        semanticallyCorrupt,
        invalidShape,
        sequenceGap,
        identity,
        snapshot,
      }),
      compatibility: buildCompatibilityEvidence({ fixtures, loaded, noSnapshot }),
      conclusion: {
        snapshotTailReplay: "feasible",
        corruptSnapshotFallback: "feasible",
        eventsRemainAuthoritative: true,
        eventPrefixBinding: "required",
        publicPersistenceApiFrozen: false,
      },
    };
    if (!allEvidencePassed(evidence)) {
      throw new Error("M3 snapshot evidence did not satisfy its contract");
    }
    return evidence;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await runM3SnapshotProbe(), null, 2)}\n`);
}
