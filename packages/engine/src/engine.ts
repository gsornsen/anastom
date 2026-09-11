import { randomUUID } from "node:crypto";

import { validateJsonValue, type JsonValue, type WorkflowDefinition } from "@anastom/core";
import type {
  ExecutionFailure,
  ExecutionRequest,
  ExecutionResult,
  RuntimeAdapter,
} from "@anastom/runtime-contract";

import {
  materializeEvents,
  replayRun,
  type RunEvent,
  type RunEventPayload,
  type RunState,
} from "./events.js";
import type { PersistedRun, RunPersistence } from "./persistence.js";
import { findExecutableNodes, findReadyNodes } from "./scheduler.js";

export interface CreateRunOptions {
  runId?: string;
  inputs?: Record<string, JsonValue>;
}

export interface WorkflowEngineOptions {
  runtime: RuntimeAdapter;
  persistence: RunPersistence;
  createRunId?: () => string;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = "RunNotFoundError";
  }
}

function validateInputs(workflow: WorkflowDefinition, inputs: Record<string, JsonValue>): void {
  const declared = Object.keys(workflow.inputs);
  const received = Object.keys(inputs);
  const missing = declared.filter((id) => !(id in inputs));
  const unknown = received.filter((id) => !(id in workflow.inputs));
  const errors: string[] = [];
  if (missing.length > 0) errors.push(`missing workflow inputs: ${missing.join(", ")}`);
  if (unknown.length > 0) errors.push(`unknown workflow inputs: ${unknown.join(", ")}`);
  for (const id of declared) {
    if (!(id in inputs)) continue;
    const definition = workflow.inputs[id];
    if (definition === undefined) continue;
    const result = validateJsonValue(definition.schema, inputs[id] as JsonValue);
    if (!result.valid) errors.push(`input ${id}: ${result.errors.join("; ")}`);
  }
  if (errors.length > 0) throw new Error(`Invalid run inputs:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

function verifierFailure(output: JsonValue): ExecutionFailure | null {
  if (output === null || Array.isArray(output) || typeof output !== "object" || typeof output.passed !== "boolean") {
    return {
      category: "schema-violation",
      message: "Verifier output must contain a boolean passed field",
    };
  }
  if (!output.passed) {
    return { category: "verification", message: "Verifier reported that its checks failed" };
  }
  return null;
}

function blockedNodePayloads(state: RunState, exceptNodeId: string, reason: string): RunEventPayload[] {
  return Object.values(state.nodes)
    .filter((node) => node.id !== exceptNodeId && (node.status === "pending" || node.status === "ready"))
    .map((node) => ({ type: "NodeBlocked" as const, nodeId: node.id, reason }));
}

export class WorkflowEngine {
  private readonly runtime: RuntimeAdapter;
  private readonly persistence: RunPersistence;
  private readonly createRunId: () => string;

  constructor(options: WorkflowEngineOptions) {
    this.runtime = options.runtime;
    this.persistence = options.persistence;
    this.createRunId = options.createRunId ?? randomUUID;
  }

  async createRun(workflow: WorkflowDefinition, options: CreateRunOptions = {}): Promise<RunState> {
    const inputs = structuredClone(options.inputs ?? {});
    validateInputs(workflow, inputs);
    const runId = options.runId ?? this.createRunId();
    const workflowInstanceId = `${runId}:root`;
    const created = materializeEvents(undefined, runId, [
      {
        type: "RunCreated",
        workflowInstanceId,
        workflowId: workflow.metadata.id,
        workflowVersion: workflow.metadata.version,
        nodeIds: [...workflow.nodeOrder],
        inputs,
      },
    ]);
    const readyIds = findExecutableNodes(workflow, created.state);
    const initialized = materializeEvents(
      created.state,
      runId,
      readyIds.map((nodeId) => ({ type: "NodeReady" as const, nodeId, reason: "dependencies-satisfied" })),
    );
    await this.persistence.create(runId, {
      workflow,
      events: [...created.events, ...initialized.events],
    });
    return initialized.state;
  }

  async start(workflow: WorkflowDefinition, options: CreateRunOptions = {}): Promise<RunState> {
    const state = await this.createRun(workflow, options);
    return this.runToCompletion(state.runId);
  }

  async tick(runId: string): Promise<RunState> {
    const { workflow, state: initialState } = await this.loadState(runId);
    if (initialState.status !== "running") return initialState;
    const nodeId = findReadyNodes(workflow, initialState)[0];
    if (nodeId === undefined) return initialState;
    const node = workflow.nodes[nodeId];
    const nodeState = initialState.nodes[nodeId];
    if (node === undefined || nodeState === undefined) throw new Error(`Workflow node ${nodeId} is missing`);
    const attempt = nodeState.attempts.length + 1;

    let state = await this.commit(runId, initialState, [
      { type: "AttemptScheduled", nodeId, attempt, runtimeId: this.runtime.id },
      { type: "AttemptStarted", nodeId, attempt },
    ]);

    const dependencyOutputs = Object.fromEntries(
      node.needs.map((dependency) => {
        const output = state.nodes[dependency]?.output;
        if (output === undefined) throw new Error(`Dependency ${dependency} has no output`);
        return [dependency, output];
      }),
    );
    const request: ExecutionRequest = {
      runId,
      workflowInstanceId: state.workflowInstanceId,
      nodeId,
      nodeKind: node.kind,
      attempt,
      ...(node.role === undefined ? {} : { role: { id: node.role } }),
      workspace: { id: `${runId}:memory`, mode: "memory" },
      context: { inputs: state.inputs, dependencyOutputs },
      budget: node.attemptBudget,
      requiredOutputSchema: node.output.schema,
      toolPolicy: { allowMutations: false },
    };

    let result: ExecutionResult;
    const observed: RunEventPayload[] = [];
    try {
      const handle = await this.runtime.start(request);
      for await (const event of this.runtime.events(handle)) {
        observed.push({ type: "RuntimeEventObserved", nodeId, attempt, event });
      }
      result = await this.runtime.collect(handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { status: "failed", failure: { category: "runtime-unavailable", message } };
    }
    if (observed.length > 0) state = await this.commit(runId, state, observed);

    if (result.status === "blocked") {
      const reason = result.reason;
      return this.commit(runId, state, [
        { type: "AttemptBlocked", nodeId, attempt, reason },
        { type: "NodeBlocked", nodeId, reason },
        ...blockedNodePayloads(state, nodeId, reason),
        { type: "RunBlocked", reason },
      ]);
    }
    if (result.status === "cancelled") {
      const cancellable = Object.values(state.nodes)
        .filter((candidate) => candidate.status !== "succeeded" && candidate.status !== "failed" && candidate.id !== nodeId)
        .map((candidate) => ({ type: "NodeCancelled" as const, nodeId: candidate.id, reason: result.reason }));
      return this.commit(runId, state, [
        { type: "AttemptCancelled", nodeId, attempt, reason: result.reason },
        { type: "NodeCancelled", nodeId, reason: result.reason },
        ...cancellable,
        { type: "RunCancelled", reason: result.reason },
      ]);
    }

    let failure: ExecutionFailure | null = null;
    if (result.status === "failed") {
      failure = result.failure;
    } else {
      const validation = validateJsonValue(node.output.schema, result.output);
      if (!validation.valid) {
        failure = {
          category: "schema-violation",
          message: `Output for ${nodeId} is invalid: ${validation.errors.join("; ")}`,
        };
      } else if (node.kind === "verifier") {
        failure = verifierFailure(result.output);
      }
    }

    if (failure !== null) {
      state = await this.commit(runId, state, [{ type: "AttemptFailed", nodeId, attempt, failure }]);
      if (attempt < node.attemptBudget.maxAttempts) {
        return this.commit(runId, state, [{ type: "NodeReady", nodeId, reason: "retry" }]);
      }
      state = await this.commit(runId, state, [{ type: "NodeFailed", nodeId, failure }]);
      const reason = `Node ${nodeId} exhausted ${node.attemptBudget.maxAttempts} attempt(s)`;
      return this.commit(runId, state, [
        ...blockedNodePayloads(state, nodeId, reason),
        { type: "RunCompleted", outcome: "failed" },
      ]);
    }

    if (result.status !== "succeeded") throw new Error(`Unhandled runtime result: ${result.status}`);
    state = await this.commit(runId, state, [
      { type: "AttemptSucceeded", nodeId, attempt, output: result.output },
      { type: "NodeSucceeded", nodeId },
    ]);
    const newlyReady = findExecutableNodes(workflow, state);
    if (newlyReady.length > 0) {
      state = await this.commit(
        runId,
        state,
        newlyReady.map((readyNodeId) => ({
          type: "NodeReady" as const,
          nodeId: readyNodeId,
          reason: "dependencies-satisfied",
        })),
      );
    }
    if (Object.values(state.nodes).every((candidate) => candidate.status === "succeeded")) {
      state = await this.commit(runId, state, [{ type: "RunCompleted", outcome: "succeeded" }]);
    }
    return state;
  }

  async runToCompletion(runId: string): Promise<RunState> {
    let state = await this.requireState(runId);
    while (state.status === "running") {
      if (findReadyNodes((await this.requireRun(runId)).workflow, state).length === 0) {
        throw new Error(`Run ${runId} is running but has no ready node`);
      }
      state = await this.tick(runId);
    }
    return state;
  }

  async resume(runId: string): Promise<RunState> {
    return this.runToCompletion(runId);
  }

  async inspect(runId: string): Promise<RunState | null> {
    const run = await this.persistence.load(runId);
    return run === null ? null : replayRun(run.events);
  }

  async events(runId: string): Promise<readonly RunEvent[]> {
    return (await this.requireRun(runId)).events;
  }

  private async commit(runId: string, state: RunState, payloads: readonly RunEventPayload[]): Promise<RunState> {
    if (payloads.length === 0) return state;
    const transition = materializeEvents(state, runId, payloads);
    await this.persistence.append(runId, state.sequence, transition.events);
    return transition.state;
  }

  private async requireRun(runId: string): Promise<PersistedRun> {
    const run = await this.persistence.load(runId);
    if (run === null) throw new RunNotFoundError(runId);
    return run;
  }

  private async requireState(runId: string): Promise<RunState> {
    return replayRun((await this.requireRun(runId)).events);
  }

  private async loadState(runId: string): Promise<{ workflow: WorkflowDefinition; state: RunState }> {
    const run = await this.requireRun(runId);
    return { workflow: run.workflow, state: replayRun(run.events) };
  }
}
