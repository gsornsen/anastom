import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalExecutionHost, localProcessIdentity } from "../packages/execution-host/src/index.js";
import {
  fixturePrepare,
  fixtureRuntimeHost,
} from "../packages/execution-host/src/testing/fixtures.js";
import type { ExecutionObservation, OwnedExecution } from "../packages/engine/src/index.js";

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function replacementPermitted(observations: readonly ExecutionObservation[]): boolean {
  return observations.every((observation) => observation.state === "absent");
}

async function cancelAll(executions: readonly OwnedExecution[]): Promise<ExecutionObservation[]> {
  return Promise.all(executions.map((execution) => execution.cancel()));
}

/** Exercise two simultaneously owned executions and cross-instance recovery classification. */
export async function runM4ConcurrentExecutionFeasibility(): Promise<{
  twoExecutionsActive: boolean;
  sharedRunAndFence: boolean;
  crossInstanceInspection: boolean;
  activeSetForbidsReplacement: boolean;
  fanInCleanupConfirmed: boolean;
  absentSetPermitsReplacement: boolean;
  oneUnknownForbidsReplacement: boolean;
  publicEvidenceSanitized: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m4-concurrent-"));
  const stateDir = join(root, "state");
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
  const options = { stateDir, runtimeHost: fixtureRuntimeHost() };
  const host = new LocalExecutionHost(options);
  let owned: OwnedExecution[] = [];
  try {
    const coordinator = await localProcessIdentity();
    const inputs = [
      fixturePrepare(firstWorkspace, "command", "hold", coordinator),
      fixturePrepare(secondWorkspace, "command", "hold", coordinator),
    ];
    const persisted = await Promise.all(inputs.map((input) => host.prepare(input)));
    owned = await Promise.all(persisted.map((execution) => host.authorize(execution)));
    await waitFor("both active executions", async () => {
      const observations = await Promise.all(inputs.map((input) => host.inspect(input.plan)));
      return observations.every((observation) => observation.state === "active");
    });

    const reopened = new LocalExecutionHost(options);
    const active = await Promise.all(inputs.map((input) => reopened.inspect(input.plan)));
    const cancelled = await cancelAll(owned);
    owned = [];
    const absent = await Promise.all(inputs.map((input) => reopened.inspect(input.plan)));

    const damagedExecution = inputs[0]!.plan.executionId;
    await writeFile(
      join(
        stateDir,
        "runs",
        inputs[0]!.plan.runId,
        "executions",
        damagedExecution,
        "terminal.json",
      ),
      "{",
    );
    const ambiguous = await Promise.all(inputs.map((input) => reopened.inspect(input.plan)));
    const publicEvidence = JSON.stringify({ active, cancelled, absent, ambiguous });
    return {
      twoExecutionsActive: active.length === 2 && active.every((value) => value.state === "active"),
      sharedRunAndFence:
        inputs.every((input) => input.plan.runId === inputs[0]!.plan.runId) &&
        inputs.every((input) => input.plan.generation === inputs[0]!.plan.generation),
      crossInstanceInspection: active.every((value) => value.state === "active"),
      activeSetForbidsReplacement: !replacementPermitted(active),
      fanInCleanupConfirmed: cancelled.every(
        (value) =>
          value.state === "absent" &&
          value.terminal?.outcome === "cancelled" &&
          value.terminal.cleanup === "confirmed",
      ),
      absentSetPermitsReplacement: replacementPermitted(absent),
      oneUnknownForbidsReplacement:
        ambiguous.some((value) => value.state === "unknown") && !replacementPermitted(ambiguous),
      publicEvidenceSanitized: !publicEvidence.includes("PRIVATE_SENTINEL"),
    };
  } finally {
    await Promise.all(owned.map((execution) => execution.cancel().catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(await runM4ConcurrentExecutionFeasibility(), null, 2));
}
