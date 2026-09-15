import { digestJson, type WorkflowDefinition } from "@anastom/core";
import type { RunEvent, AttemptState } from "./events.js";
import type { CommandReport } from "./command.js";

import type { RunState } from "./events.js";

/**
 * Render the workflow's outgoing dependency edges in authored order.
 */
export function renderWorkflowGraph(workflow: WorkflowDefinition): string {
  const dependents = new Map<string, string[]>();
  for (const nodeId of workflow.nodeOrder) {
    dependents.set(nodeId, []);
  }
  for (const nodeId of workflow.nodeOrder) {
    for (const dependency of workflow.nodes[nodeId]?.needs ?? []) {
      dependents.get(dependency)?.push(nodeId);
    }
  }
  return [
    `${workflow.metadata.id}@${workflow.metadata.version}`,
    ...workflow.nodeOrder.map((nodeId) => {
      const node = workflow.nodes[nodeId];
      const outgoing = dependents.get(nodeId) ?? [];
      return `${nodeId} [${node?.kind ?? "unknown"}] -> ${outgoing.length === 0 ? "(end)" : outgoing.join(", ")}`;
    }),
  ].join("\n");
}

/**
 * Render run and node status with attempt counts and classified failures.
 */
export function renderRunStatus(state: RunState, workflow: WorkflowDefinition): string {
  return [
    `Run ${state.runId} [${state.status}]`,
    `Workflow ${state.workflowId}@${state.workflowVersion}`,
    ...workflow.nodeOrder.map((nodeId) => {
      const node = state.nodes[nodeId];
      const failure =
        node?.failure === undefined ? "" : ` (${node.failure.category}: ${node.failure.message})`;
      return `${nodeId}: ${node?.status ?? "unknown"} attempts=${node?.attempts.length ?? 0}${failure}`;
    }),
  ].join("\n");
}

/**
 * Render durable evidence in a stable order: status, workspace, attempts,
 * verification, artifacts, and events. Rendering never reads artifact contents.
 */
export function renderRunInspection(
  state: RunState,
  workflow: WorkflowDefinition,
  events: readonly RunEvent[],
): string {
  const lines = [renderRunStatus(state, workflow), "Definition: " + digestJson(workflow)];
  lines.push(...renderWorkspace(state));
  if (state.runtimeNegotiation) {
    lines.push("Runtime capabilities: " + JSON.stringify(state.runtimeNegotiation));
  }
  for (const node of Object.values(state.nodes)) {
    for (const attempt of node.attempts) {
      lines.push(renderAttempt(node.id, attempt));
      for (const identity of attempt.identity ?? []) {
        lines.push(
          `Identity: ${identity.provider}/${identity.model} source=${identity.source ?? "unspecified"} runtimeVersion=${identity.runtimeVersion ?? "unavailable"}`,
        );
      }
      const usage = attempt.usage;
      lines.push(
        usage
          ? `Tokens (${usage.coverage} attempt coverage): input=${usage.inputTokens ?? "unavailable"} output=${usage.outputTokens ?? "unavailable"} cacheRead=${usage.cacheReadTokens ?? "unavailable"} cacheWrite=${usage.cacheWriteTokens ?? "unavailable"} reasoning=${usage.reasoningTokens ?? "unavailable"} total=${usage.totalTokens ?? "unavailable"}`
          : "Tokens: unavailable",
      );
    }
    if (node.command) {
      lines.push(...renderVerification(node.command));
    }
  }
  for (const artifact of state.artifacts ?? []) {
    lines.push(`Artifact ${artifact.type}: ${artifact.uri} (${artifact.digest})`);
  }
  lines.push("Events:");
  for (const event of events) {
    lines.push(renderEvent(event));
  }
  return lines.join("\n");
}

function renderWorkspace(state: RunState): string[] {
  const lines: string[] = [];
  const workspace = state.workspace;
  if (workspace && workspace.mode !== "memory") {
    lines.push(`Workspace: ${workspace.path} [${workspace.mode}]`, "Base: " + workspace.baseCommit);
    if (workspace.mode === "isolated") {
      lines.push("Branch: " + workspace.branch);
    }
  }
  if (state.workspaceObservation) {
    lines.push("Head: " + state.workspaceObservation.headCommit);
    lines.push("Changed files: " + state.workspaceObservation.changedFiles.join(", "));
  }
  return lines;
}

function renderAttempt(nodeId: string, attempt: AttemptState): string {
  let line = `Attempt ${nodeId}/${attempt.number}: ${attempt.runtimeId} ${attempt.status}`;
  if (attempt.failure) {
    line += ` (${attempt.failure.category}: ${attempt.failure.message})`;
  }
  if (attempt.timeout) {
    line += ` timeout cancellation=${attempt.timeout.cancellation} late=${attempt.timeout.lateStatus ?? "none"}`;
  }
  return line;
}

function renderVerification(command: CommandReport): string[] {
  const result = [
    `passed=${command.passed}`,
    `exit=${command.exitCode}`,
    `signal=${command.signal}`,
    `durationMs=${Math.round(command.durationMs)}`,
  ];
  const stdout = `stdoutBytes=${command.stdoutBytes} truncated=${command.stdoutTruncated}`;
  const stderr = `stderrBytes=${command.stderrBytes} truncated=${command.stderrTruncated}`;
  return ["Verification: " + result.join(" "), `Verification output: ${stdout}; ${stderr}`];
}

function renderEvent(event: RunEvent): string {
  let line = `  ${event.sequence}: ${event.type}`;
  if ("nodeId" in event) {
    line += " " + event.nodeId;
  }
  if ("attempt" in event) {
    line += "/" + event.attempt;
  }
  if (event.type === "RuntimeEventObserved" && event.event.type === "metadata") {
    line += ` ${event.event.provider}/${event.event.model}`;
  }
  return line;
}
