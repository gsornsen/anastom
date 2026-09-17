import { digestJson, type WorkflowDefinition } from "@anastom/core";
import {
  materializeEvents,
  projectEvidenceLedger,
  replayRun,
  type RunEvent,
} from "@anastom/engine";
import type { LiveRunEvent } from "@anastom/runtime-contract";

import type { DurableRunInspection } from "../durable.js";

const output = {
  ref: "output.json",
  schema: { type: "object", additionalProperties: false, properties: {} },
};

const terminalWorkflow: WorkflowDefinition = {
  apiVersion: "anastom.dev/v1alpha1",
  kind: "Workflow",
  metadata: { id: "terminal/fixture", version: "0.1.0" },
  sourcePath: "/fixture/workflow.yaml",
  inputs: {},
  policies: {
    defaultAttemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    maxParallel: 2,
  },
  nodeOrder: ["analysis", "implement.left", "implement.right", "integrate", "verify"],
  nodes: {
    analysis: {
      id: "analysis",
      kind: "agent",
      needs: [],
      output,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
    "implement.left": {
      id: "implement.left",
      kind: "agent",
      needs: ["analysis"],
      output,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
    "implement.right": {
      id: "implement.right",
      kind: "agent",
      needs: ["analysis"],
      output,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
    integrate: {
      id: "integrate",
      kind: "integration",
      needs: ["implement.left", "implement.right"],
      output,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
      controller: { operation: "integrate-patches", wave: 1, taskIds: ["left", "right"] },
    },
    verify: {
      id: "verify",
      kind: "verifier",
      needs: ["integrate"],
      output,
      attemptBudget: { maxAttempts: 1, maxDurationMs: 30_000 },
    },
  },
};

const runEvents: RunEvent[] = materializeEvents(undefined, "terminal-run", [
  {
    type: "RunCreated",
    workflowInstanceId: "terminal-run:root",
    workflowId: terminalWorkflow.metadata.id,
    workflowVersion: terminalWorkflow.metadata.version,
    nodeIds: [...terminalWorkflow.nodeOrder],
    inputs: {},
  },
]).events;

const liveEvents: LiveRunEvent[] = [
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 1,
    type: "run",
    status: "created",
  },
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 2,
    type: "node",
    nodeId: "implement.left",
    phase: "implementation",
    status: "running",
  },
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 3,
    type: "runtime",
    nodeId: "implement.left",
    phase: "implementation",
    attempt: 1,
    provider: "openai",
    model: "gpt-5.6-terra",
  },
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 4,
    type: "usage",
    nodeId: "implement.left",
    phase: "implementation",
    attempt: 1,
    usage: {
      type: "usage",
      scope: "attempt",
      coverage: "partial",
      inputTokens: 120,
      outputTokens: 30,
      reasoningTokens: 12,
      totalTokens: 162,
    },
  },
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 5,
    type: "log",
    nodeId: "implement.left",
    phase: "implementation",
    attempt: 1,
    message: "public progress\u001b[31m\u202e",
    droppedMessages: 2,
  },
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 6,
    type: "integration",
    nodeId: "integrate",
    phase: "integration",
    status: "committed",
    commit: "0123456789abcdef0123456789abcdef01234567",
  },
  {
    version: "anastom.dev/live-run-event/v1alpha1",
    runId: "terminal-run",
    sequence: 7,
    type: "verification",
    nodeId: "verify",
    phase: "verification",
    attempt: 1,
    passed: true,
    exitCode: 0,
    signal: null,
    durationMs: 42,
    stdoutBytes: 10,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  },
];

export function terminalInspection(): DurableRunInspection {
  const state = replayRun(runEvents);
  state.nodes.analysis!.status = "succeeded";
  state.nodes["implement.left"]!.status = "running";
  state.nodes["implement.left"]!.attempts.push({
    number: 1,
    runtimeId: "codex",
    status: "running",
  });
  state.nodes["implement.right"]!.status = "ready";
  state.sequence = 7;
  return {
    definitionDigest: digestJson(terminalWorkflow),
    workflow: terminalWorkflow,
    state,
    ownership: { lease: null, ownerState: "released" },
    pendingControls: [],
    snapshot: { source: "snapshot-tail", sequence: 1 },
    events: runEvents,
    evidence: projectEvidenceLedger(terminalWorkflow, runEvents),
    liveEvents,
  };
}
