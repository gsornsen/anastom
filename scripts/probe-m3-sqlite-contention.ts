import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  M3ContentionStore,
  assertM3ContentionResponse,
  initializeM3ContentionDatabase,
  m3ContentionPayloadDigest,
  type M3ContentionRequest,
  type M3ContentionResponse,
  type M3ContentionInspection,
  type M3ContentionToken,
} from "./m3-sqlite-contention.js";
import {
  matchesLiveProcess,
  terminateObservedProcess,
  waitForCondition,
  type ProcessIdentity,
} from "./m3-process-identity.js";
import { readM3Record, writeM3Record, type M3RecordName } from "./testing/m3-records.js";

type Participant = "a" | "b";

interface WorkerReady {
  round: number;
  process: ProcessIdentity;
}

interface WorkerFixture {
  participant: Participant;
  child: ChildProcess;
  completed: Promise<M3ContentionResponse>;
  diagnostics: () => string;
}

/** Cross-process SQLite evidence collected before M3 persistence APIs are frozen. */
export interface M3SqliteContentionEvidence {
  version: "anastom.dev/m3-sqlite-contention-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  initialAcquire: {
    exactlyOneWinner: boolean;
    generationOne: boolean;
  };
  renewal: {
    currentOwnerRenewed: boolean;
    staleOwnerRejected: boolean;
  };
  takeover: {
    liveOwnerRejected: boolean;
    unknownOwnerRejected: boolean;
    exactlyOneExpiredWinner: boolean;
    generationTwo: boolean;
  };
  idempotency: {
    concurrentDuplicateSameRange: boolean;
    onePhysicalAppend: boolean;
    changedPayloadRejected: boolean;
    wrongSequenceRejected: boolean;
  };
  fencing: {
    generationOneAppendRejected: boolean;
    generationTwoAfterReleaseRejected: boolean;
    eventSequencesContiguous: boolean;
    eventGenerationsCorrect: boolean;
  };
  controls: {
    concurrentDuplicateOneRow: boolean;
    duplicateReturnedOriginal: boolean;
    changedActionRejected: boolean;
    recordedTimesAssignedBySqlite: boolean;
  };
  releaseAndAcquire: {
    currentReleaseSucceeded: boolean;
    staleReleaseRejected: boolean;
    exactlyOneNewOwner: boolean;
    generationThree: boolean;
  };
  conclusion: {
    beginImmediateSerialization: "feasible";
    fencedMutation: "feasible";
    idempotentMutation: "feasible";
    deduplicatedControlInbox: "feasible";
    publicPersistenceApiFrozen: false;
  };
}

function testingProgram(name: string): string {
  return fileURLToPath(new URL(`./testing/${name}`, import.meta.url));
}

function repositoryProgram(name: string): string {
  return fileURLToPath(new URL(`../${name}`, import.meta.url));
}

function requestName(participant: Participant): M3RecordName {
  return participant === "a" ? "contention-a-request.json" : "contention-b-request.json";
}

function readyName(participant: Participant): M3RecordName {
  return participant === "a" ? "contention-a-ready.json" : "contention-b-ready.json";
}

function startWorker(root: string, participant: Participant): WorkerFixture {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      "--tsconfig",
      repositoryProgram("tsconfig.json"),
      testingProgram("m3-sqlite-contention-worker.ts"),
      participant,
    ],
    { cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = Buffer.alloc(0);
  let stderr = "";
  let oversized = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length + chunk.length > 65_536) {
      oversized = true;
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 65_536) {
      stderr += chunk.toString("utf8", 0, Math.max(0, 65_536 - stderr.length));
    }
  });
  const completed = new Promise<M3ContentionResponse>((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || oversized) {
        reject(
          new Error(
            `Contention worker ${participant} failed: ${stderr.trim() || `exit ${String(code ?? signal)}`}`,
          ),
        );
        return;
      }
      try {
        const response: unknown = JSON.parse(stdout.toString("utf8"));
        assertM3ContentionResponse(response);
        resolveCompletion(response);
      } catch (error) {
        reject(
          new Error(`Contention worker ${participant} returned invalid evidence`, { cause: error }),
        );
      }
    });
  });
  return { participant, child, completed, diagnostics: () => stderr.trim() };
}

async function stopWorker(fixture: WorkerFixture, ready?: WorkerReady): Promise<void> {
  if (ready && (await matchesLiveProcess(ready.process))) {
    try {
      await terminateObservedProcess(ready.process);
    } catch (error) {
      if (await matchesLiveProcess(ready.process)) {
        throw error;
      }
    }
  }
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGKILL");
    await waitForCondition(
      `contention worker ${fixture.participant} exit`,
      async () => fixture.child.exitCode !== null || fixture.child.signalCode !== null,
    );
  }
}

async function collectWorkers(
  fixtures: readonly [WorkerFixture, WorkerFixture],
): Promise<[M3ContentionResponse, M3ContentionResponse]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([fixtures[0].completed, fixtures[1].completed]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Contention workers did not complete after gate release")),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runPair(
  root: string,
  round: number,
  first: M3ContentionRequest,
  second: M3ContentionRequest,
): Promise<[M3ContentionResponse, M3ContentionResponse]> {
  await Promise.all([
    writeM3Record(root, requestName("a"), { round, request: first }),
    writeM3Record(root, requestName("b"), { round, request: second }),
  ]);
  const fixtures = [startWorker(root, "a"), startWorker(root, "b")] as const;
  let readyA: WorkerReady | null = null;
  let readyB: WorkerReady | null = null;
  try {
    await waitForCondition(
      `contention workers for round ${round}`,
      async () => {
        [readyA, readyB] = await Promise.all([
          readM3Record<WorkerReady>(root, readyName("a")),
          readM3Record<WorkerReady>(root, readyName("b")),
        ]);
        if (
          fixtures.some(({ child }) => child.exitCode !== null || child.signalCode !== null) &&
          (readyA?.round !== round || readyB?.round !== round)
        ) {
          throw new Error(
            `Contention worker exited before readiness: ${fixtures
              .map((fixture) => fixture.diagnostics())
              .filter(Boolean)
              .join("; ")}`,
          );
        }
        return readyA?.round === round && readyB?.round === round;
      },
      15_000,
    );
    await writeM3Record(root, "contention-gate.json", { round });
    return await collectWorkers(fixtures);
  } finally {
    await Promise.all([
      stopWorker(fixtures[0], readyA ?? undefined),
      stopWorker(fixtures[1], readyB ?? undefined),
    ]);
    await Promise.allSettled([fixtures[0].completed, fixtures[1].completed]);
  }
}

function leaseSuccess(
  response: M3ContentionResponse,
): Extract<M3ContentionResponse, { ok: true; operation: "acquire" | "renew" | "takeover" }> | null {
  return response.ok && "token" in response && response.operation !== "release" ? response : null;
}

function failedAs(response: M3ContentionResponse, category: string): boolean {
  return !response.ok && response.category === category;
}

function oneSuccess(
  responses: readonly M3ContentionResponse[],
  operation: M3ContentionRequest["operation"],
): M3ContentionResponse | null {
  const successful = responses.filter(
    (response) => response.ok && response.operation === operation,
  );
  return successful.length === 1 ? (successful[0] ?? null) : null;
}

function appendSuccess(response: M3ContentionResponse) {
  return response.ok && response.operation === "append" ? response : null;
}

function controlSuccess(response: M3ContentionResponse) {
  return response.ok && response.operation === "control" ? response : null;
}

function exactlyOneSuccessAndConflict(
  responses: readonly M3ContentionResponse[],
  category: string,
): boolean {
  return (
    responses.filter((result) => result.ok).length === 1 &&
    responses.filter((result) => failedAs(result, category)).length === 1
  );
}

function buildInitialEvidence(
  acquired: readonly M3ContentionResponse[],
  token: M3ContentionToken,
): M3SqliteContentionEvidence["initialAcquire"] {
  return {
    exactlyOneWinner: exactlyOneSuccessAndConflict(acquired, "ownership-conflict"),
    generationOne: token.generation === 1,
  };
}

function buildRenewalEvidence(
  renewed: readonly M3ContentionResponse[],
): M3SqliteContentionEvidence["renewal"] {
  const current = renewed[0] ? leaseSuccess(renewed[0]) : null;
  return {
    currentOwnerRenewed: current !== null && current.expiresAtMs === 200,
    staleOwnerRejected: renewed[1] !== undefined && failedAs(renewed[1], "ownership-conflict"),
  };
}

function buildTakeoverEvidence(
  refused: readonly M3ContentionResponse[],
  takeovers: readonly M3ContentionResponse[],
  token: M3ContentionToken,
): M3SqliteContentionEvidence["takeover"] {
  return {
    liveOwnerRejected: refused[0] !== undefined && failedAs(refused[0], "live-owner"),
    unknownOwnerRejected: refused[1] !== undefined && failedAs(refused[1], "unknown-owner"),
    exactlyOneExpiredWinner: exactlyOneSuccessAndConflict(takeovers, "ownership-conflict"),
    generationTwo: token.generation === 2,
  };
}

function buildIdempotencyEvidence(
  duplicates: readonly M3ContentionResponse[],
  conflicts: readonly M3ContentionResponse[],
  inspection: M3ContentionInspection,
): M3SqliteContentionEvidence["idempotency"] {
  const results = duplicates.map(appendSuccess);
  const sameRange =
    results.every((result) => result !== null) &&
    results[0]?.firstSequence === results[1]?.firstSequence &&
    results[0]?.lastSequence === results[1]?.lastSequence;
  return {
    concurrentDuplicateSameRange: sameRange,
    onePhysicalAppend:
      results.filter((result) => result?.replayed === false).length === 1 &&
      results.filter((result) => result?.replayed === true).length === 1 &&
      inspection.mutations.filter(({ mutationId }) => mutationId === "mutation-one").length === 1,
    changedPayloadRejected:
      conflicts[0] !== undefined && failedAs(conflicts[0], "idempotency-conflict"),
    wrongSequenceRejected:
      conflicts[1] !== undefined && failedAs(conflicts[1], "sequence-conflict"),
  };
}

function buildFencingEvidence(
  firstFence: readonly M3ContentionResponse[],
  secondFence: readonly M3ContentionResponse[],
  inspection: M3ContentionInspection,
): M3SqliteContentionEvidence["fencing"] {
  return {
    generationOneAppendRejected:
      firstFence[0] !== undefined && failedAs(firstFence[0], "ownership-conflict"),
    generationTwoAfterReleaseRejected:
      secondFence[0] !== undefined && failedAs(secondFence[0], "ownership-conflict"),
    eventSequencesContiguous:
      inspection.events.map(({ sequence }) => sequence).join(",") === "1,2,3,4",
    eventGenerationsCorrect:
      inspection.events.map(({ generation }) => generation).join(",") === "2,2,2,3",
  };
}

function buildControlEvidence(
  duplicates: readonly M3ContentionResponse[],
  conflicts: readonly M3ContentionResponse[],
  inspection: M3ContentionInspection,
): M3SqliteContentionEvidence["controls"] {
  const results = duplicates.map(controlSuccess);
  const sameOriginal =
    results.every((result) => result !== null) &&
    results[0]?.action === results[1]?.action &&
    results[0]?.recordedAtMs === results[1]?.recordedAtMs;
  return {
    concurrentDuplicateOneRow:
      inspection.controls.filter(({ operationId }) => operationId === "control-same").length === 1,
    duplicateReturnedOriginal:
      sameOriginal &&
      results.filter((result) => result?.replayed === false).length === 1 &&
      results.filter((result) => result?.replayed === true).length === 1,
    changedActionRejected: exactlyOneSuccessAndConflict(conflicts, "idempotency-conflict"),
    recordedTimesAssignedBySqlite: inspection.controls.every(
      ({ recordedAtMs }) => recordedAtMs > 0,
    ),
  };
}

function buildReleaseEvidence(
  releases: readonly M3ContentionResponse[],
  newOwners: readonly M3ContentionResponse[],
  token: M3ContentionToken,
  inspection: M3ContentionInspection,
): M3SqliteContentionEvidence["releaseAndAcquire"] {
  const currentRelease = releases[0];
  return {
    currentReleaseSucceeded:
      currentRelease !== undefined && currentRelease.ok && currentRelease.operation === "release",
    staleReleaseRejected: releases[1] !== undefined && failedAs(releases[1], "ownership-conflict"),
    exactlyOneNewOwner: exactlyOneSuccessAndConflict(newOwners, "ownership-conflict"),
    generationThree:
      token.generation === 3 &&
      inspection.lease?.generation === 3 &&
      inspection.lease.released === false,
  };
}

function assertEvidence(evidence: M3SqliteContentionEvidence): void {
  for (const section of [
    evidence.initialAcquire,
    evidence.renewal,
    evidence.takeover,
    evidence.idempotency,
    evidence.fencing,
    evidence.controls,
    evidence.releaseAndAcquire,
  ]) {
    if (Object.values(section).some((value) => value !== true)) {
      throw new Error("M3 SQLite contention evidence did not satisfy its contract");
    }
  }
}

/** Run the multi-process SQLite lease, fencing, idempotency, and control-inbox matrix. */
export async function runM3SqliteContentionProbe(): Promise<M3SqliteContentionEvidence> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m3-sqlite-"));
  const runId = "contention-run";
  try {
    initializeM3ContentionDatabase(root);

    const acquired = await runPair(
      root,
      1,
      { operation: "acquire", runId, ownerId: "alpha", nowMs: 0, ttlMs: 100 },
      { operation: "acquire", runId, ownerId: "beta", nowMs: 0, ttlMs: 100 },
    );
    const firstWinner = oneSuccess(acquired, "acquire");
    const generationOne = firstWinner ? leaseSuccess(firstWinner) : null;
    if (!generationOne) {
      throw new Error("Initial contention did not produce one lease owner");
    }
    const staleGenerationOne: M3ContentionToken = {
      runId,
      ownerId: generationOne.token.ownerId === "alpha" ? "beta" : "alpha",
      generation: 1,
    };

    const renewed = await runPair(
      root,
      2,
      { operation: "renew", token: generationOne.token, nowMs: 50, ttlMs: 150 },
      { operation: "renew", token: staleGenerationOne, nowMs: 50, ttlMs: 150 },
    );
    const refusedTakeovers = await runPair(
      root,
      3,
      {
        operation: "takeover",
        runId,
        ownerId: "gamma",
        observedOwnerId: generationOne.token.ownerId,
        observedGeneration: 1,
        liveness: "alive",
        nowMs: 201,
        ttlMs: 100,
      },
      {
        operation: "takeover",
        runId,
        ownerId: "delta",
        observedOwnerId: generationOne.token.ownerId,
        observedGeneration: 1,
        liveness: "unknown",
        nowMs: 201,
        ttlMs: 100,
      },
    );

    const takeovers = await runPair(
      root,
      4,
      {
        operation: "takeover",
        runId,
        ownerId: "gamma",
        observedOwnerId: generationOne.token.ownerId,
        observedGeneration: 1,
        liveness: "absent",
        nowMs: 201,
        ttlMs: 100,
      },
      {
        operation: "takeover",
        runId,
        ownerId: "delta",
        observedOwnerId: generationOne.token.ownerId,
        observedGeneration: 1,
        liveness: "absent",
        nowMs: 201,
        ttlMs: 100,
      },
    );
    const takeoverWinner = oneSuccess(takeovers, "takeover");
    const generationTwo = takeoverWinner ? leaseSuccess(takeoverWinner) : null;
    if (!generationTwo) {
      throw new Error("Expired contention did not produce one takeover owner");
    }

    const firstEvents = ["event-one", "event-two"];
    const firstAppend: M3ContentionRequest = {
      operation: "append",
      token: generationTwo.token,
      nowMs: 250,
      mutationId: "mutation-one",
      payloadDigest: m3ContentionPayloadDigest(firstEvents),
      expectedSequence: 0,
      events: firstEvents,
    };
    const duplicateAppends = await runPair(root, 5, firstAppend, structuredClone(firstAppend));
    const fencedAppends = await runPair(
      root,
      6,
      {
        operation: "append",
        token: generationOne.token,
        nowMs: 250,
        mutationId: "stale-mutation",
        payloadDigest: m3ContentionPayloadDigest(["stale"]),
        expectedSequence: 2,
        events: ["stale"],
      },
      {
        operation: "append",
        token: generationTwo.token,
        nowMs: 250,
        mutationId: "mutation-two",
        payloadDigest: m3ContentionPayloadDigest(["event-three"]),
        expectedSequence: 2,
        events: ["event-three"],
      },
    );

    const appendConflicts = await runPair(
      root,
      7,
      {
        operation: "append",
        token: generationTwo.token,
        nowMs: 250,
        mutationId: "mutation-one",
        payloadDigest: m3ContentionPayloadDigest(["changed"]),
        expectedSequence: 3,
        events: ["changed"],
      },
      {
        operation: "append",
        token: generationTwo.token,
        nowMs: 250,
        mutationId: "wrong-sequence",
        payloadDigest: m3ContentionPayloadDigest(["wrong-sequence"]),
        expectedSequence: 0,
        events: ["wrong-sequence"],
      },
    );

    const duplicateControls = await runPair(
      root,
      8,
      { operation: "control", runId, operationId: "control-same", action: "pause" },
      { operation: "control", runId, operationId: "control-same", action: "pause" },
    );
    const conflictingControls = await runPair(
      root,
      9,
      { operation: "control", runId, operationId: "control-choice", action: "pause" },
      { operation: "control", runId, operationId: "control-choice", action: "cancel" },
    );

    const releases = await runPair(
      root,
      10,
      { operation: "release", token: generationTwo.token },
      { operation: "release", token: generationOne.token },
    );
    const newOwners = await runPair(
      root,
      11,
      { operation: "acquire", runId, ownerId: "epsilon", nowMs: 300, ttlMs: 100 },
      { operation: "acquire", runId, ownerId: "zeta", nowMs: 300, ttlMs: 100 },
    );
    const newOwner = oneSuccess(newOwners, "acquire");
    const generationThree = newOwner ? leaseSuccess(newOwner) : null;
    if (!generationThree) {
      throw new Error("Released contention did not produce one new owner");
    }

    const postReleaseAppends = await runPair(
      root,
      12,
      {
        operation: "append",
        token: generationTwo.token,
        nowMs: 350,
        mutationId: "released-owner-mutation",
        payloadDigest: m3ContentionPayloadDigest(["released"]),
        expectedSequence: 3,
        events: ["released"],
      },
      {
        operation: "append",
        token: generationThree.token,
        nowMs: 350,
        mutationId: "mutation-three",
        payloadDigest: m3ContentionPayloadDigest(["event-four"]),
        expectedSequence: 3,
        events: ["event-four"],
      },
    );

    const store = new M3ContentionStore(root);
    const inspection = store.inspect(runId);
    store.close();
    const evidence: M3SqliteContentionEvidence = {
      version: "anastom.dev/m3-sqlite-contention-evidence/v1alpha1",
      platform: process.platform,
      architecture: process.arch,
      initialAcquire: buildInitialEvidence(acquired, generationOne.token),
      renewal: buildRenewalEvidence(renewed),
      takeover: buildTakeoverEvidence(refusedTakeovers, takeovers, generationTwo.token),
      idempotency: buildIdempotencyEvidence(duplicateAppends, appendConflicts, inspection),
      fencing: buildFencingEvidence(fencedAppends, postReleaseAppends, inspection),
      controls: buildControlEvidence(duplicateControls, conflictingControls, inspection),
      releaseAndAcquire: buildReleaseEvidence(
        releases,
        newOwners,
        generationThree.token,
        inspection,
      ),
      conclusion: {
        beginImmediateSerialization: "feasible",
        fencedMutation: "feasible",
        idempotentMutation: "feasible",
        deduplicatedControlInbox: "feasible",
        publicPersistenceApiFrozen: false,
      },
    };
    assertEvidence(evidence);
    return evidence;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await runM3SqliteContentionProbe(), null, 2)}\n`);
}
