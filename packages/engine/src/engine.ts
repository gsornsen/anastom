import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  validateJsonValue,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@anastom/core";
import type {
  ExecutionFailure,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  RuntimeAdapter,
  RuntimeEvent,
  WorkspaceRef,
  WorkspaceCapture,
  RuntimeNegotiation,
} from "@anastom/runtime-contract";
import {
  probeRuntime,
  assertRuntimeNegotiation,
  assertRuntimeEvent,
} from "@anastom/runtime-contract";
import type { ArtifactStore } from "./artifacts.js";
import { LocalCommandExecutor, type CommandExecutor } from "./command.js";
import { buildContext } from "./context.js";

import {
  materializeEvents,
  replayRun,
  type RunEvent,
  type RunEventPayload,
  type RunState,
} from "./events.js";
import type { PersistedRun, RunPersistence } from "./persistence.js";
import { findExecutableNodes, findReadyNodes } from "./scheduler.js";

/**
 * Optional run identity, declared inputs, and pre-created workspace for a new run.
 */
export interface CreateRunOptions {
  runId?: string;
  inputs?: Record<string, JsonValue>;
  workspace?: WorkspaceRef;
  /** Reuse the CLI's single pre-workspace capability probe; direct callers may omit it. */
  runtimeNegotiation?: RuntimeNegotiation;
}

/**
 * Control-plane dependencies and execution policy; defaults preserve process-local fake workflows.
 */
export interface WorkflowEngineOptions {
  runtime: RuntimeAdapter;
  persistence: RunPersistence;
  /** Injectable run identity for deterministic tests; defaults to cryptographic UUIDv4. */
  createRunId?: () => string;
  executionMode?: "fake" | "worker";
  artifacts?: ArtifactStore;
  commandExecutor?: CommandExecutor;
  /** Capture final workspace evidence without altering the worker's index. */
  captureWorkspace?: (workspace: WorkspaceRef) => Promise<WorkspaceCapture>;
  cancellationGraceMs?: number;
}

/**
 * Signals that the selected persistence store has no history for the requested run.
 */
export class RunNotFoundError extends Error {
  /**
   * Identify the run missing from the selected persistence store.
   */
  constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = "RunNotFoundError";
  }
}

function validateInputs(workflow: WorkflowDefinition, inputs: Record<string, JsonValue>): void {
  const declared = Object.keys(workflow.inputs);
  const received = Object.keys(inputs);
  const missing = declared.filter((id) => !Object.hasOwn(inputs, id));
  const unknown = received.filter((id) => !Object.hasOwn(workflow.inputs, id));
  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(`missing workflow inputs: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    errors.push(`unknown workflow inputs: ${unknown.join(", ")}`);
  }
  for (const id of declared) {
    if (!Object.hasOwn(inputs, id)) {
      continue;
    }
    const definition = workflow.inputs[id];
    if (definition === undefined) {
      continue;
    }
    const result = validateJsonValue(definition.schema, inputs[id] as JsonValue);
    if (!result.valid) {
      errors.push(`input ${id}: ${result.errors.join("; ")}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid run inputs:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

function verifierFailure(output: JsonValue): ExecutionFailure | null {
  if (
    output === null ||
    Array.isArray(output) ||
    typeof output !== "object" ||
    typeof output.passed !== "boolean"
  ) {
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

function blockedNodePayloads(
  state: RunState,
  exceptNodeId: string,
  reason: string,
): RunEventPayload[] {
  return Object.values(state.nodes)
    .filter(
      (node) => node.id !== exceptNodeId && (node.status === "pending" || node.status === "ready"),
    )
    .map((node) => ({ type: "NodeBlocked" as const, nodeId: node.id, reason }));
}

class RuntimeObservationFilter {
  private readonly seen = new Set<string>();
  private usageSeen = false;

  accept(event: RuntimeEvent): boolean {
    if (event.type !== "metadata" && event.type !== "usage") {
      return true;
    }
    const key = canonicalJson(event);
    if (this.seen.has(key)) {
      return false;
    }
    if (event.type === "usage" && this.usageSeen) {
      throw new Error("Runtime emitted conflicting final usage");
    }
    this.usageSeen ||= event.type === "usage";
    this.seen.add(key);
    return true;
  }
}

/**
 * Sequential event-driven orchestration with schema validation, fresh contexts, and bounded attempts.
 */
export class WorkflowEngine {
  private readonly runtime: RuntimeAdapter;
  private readonly persistence: RunPersistence;
  private readonly createRunId: () => string;
  private readonly options: WorkflowEngineOptions;

  /**
   * Bind runtime, storage, and execution policy; run identifiers default to Node's cryptographic UUIDv4.
   */
  constructor(options: WorkflowEngineOptions) {
    this.options = options;
    this.runtime = options.runtime;
    this.persistence = options.persistence;
    this.createRunId = options.createRunId ?? randomUUID;
  }

  /**
   * Validate inputs and worker boundaries, then atomically persist the immutable definition and initial ready events.
   */
  async createRun(workflow: WorkflowDefinition, options: CreateRunOptions = {}): Promise<RunState> {
    let negotiation: RuntimeNegotiation | undefined;
    if (this.options.executionMode === "worker") {
      if (!this.options.artifacts || !options.workspace || options.workspace.mode === "memory") {
        throw new Error("Worker runs require durable artifacts and a filesystem workspace");
      }
      for (const node of Object.values(workflow.nodes)) {
        if (node.kind !== "agent" && (node.kind !== "command" || !node.command)) {
          throw new Error("Unsupported worker node: " + node.id);
        }
        if (node.kind === "agent" && node.mutation === undefined) {
          throw new Error("Agent mutation intent is required");
        }
        if (node.mutation !== undefined && node.mutation !== options.workspace.mode) {
          throw new Error("Workspace mode does not match mutation intent");
        }
      }
      negotiation = structuredClone(
        options.runtimeNegotiation ?? (await probeRuntime(this.runtime, options.workspace.mode)),
      );
      assertRuntimeNegotiation(negotiation, this.runtime.id, options.workspace.mode);
    }
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
    const initialized = materializeEvents(created.state, runId, [
      ...(negotiation ? [{ type: "RuntimeNegotiated" as const, negotiation }] : []),
      ...(options.workspace
        ? [{ type: "WorkspaceAssigned" as const, workspace: options.workspace }]
        : []),
      ...readyIds.map((nodeId) => ({
        type: "NodeReady" as const,
        nodeId,
        reason: "dependencies-satisfied" as const,
      })),
    ]);
    await this.persistence.create(runId, {
      workflow,
      events: [...created.events, ...initialized.events],
    });
    return initialized.state;
  }

  /**
   * Create a run and execute sequentially until it finishes or reaches a blocked/paused state.
   */
  async start(workflow: WorkflowDefinition, options: CreateRunOptions = {}): Promise<RunState> {
    const state = await this.createRun(workflow, options);
    return this.runToCompletion(state.runId);
  }

  /**
   * Schedule and execute one ready attempt, retaining evidence before deciding success, retry, or failure.
   */
  async tick(runId: string): Promise<RunState> {
    const { workflow, state: initialState } = await this.loadState(runId);
    if (initialState.status !== "running") {
      return initialState;
    }
    const nodeId = findReadyNodes(workflow, initialState)[0];
    if (nodeId === undefined) {
      return initialState;
    }
    const node = workflow.nodes[nodeId];
    const nodeState = initialState.nodes[nodeId];
    if (node === undefined || nodeState === undefined) {
      throw new Error(`Workflow node ${nodeId} is missing`);
    }
    const attempt = nodeState.attempts.length + 1;

    const state = await this.commit(runId, initialState, [
      {
        type: "AttemptScheduled",
        nodeId,
        attempt,
        runtimeId:
          this.options.executionMode === "worker" && node.kind === "command"
            ? "command"
            : this.runtime.id,
      },
      { type: "AttemptStarted", nodeId, attempt },
    ]);

    const workspace = state.workspace ?? { id: `${runId}:memory`, mode: "memory" as const };
    const context = buildContext({ workflow, state, nodeId, attempt, workspace });
    const request: ExecutionRequest = Object.freeze({
      runId,
      workflowInstanceId: state.workflowInstanceId,
      nodeId,
      nodeKind: node.kind,
      attempt,
      ...(node.role === undefined ? {} : { role: { id: node.role } }),
      workspace: context.envelope.workspace!,
      context: context.envelope,
      budget: context.envelope.budget!,
      requiredOutputSchema: context.envelope.requiredOutputSchema!,
      toolPolicy: Object.freeze({ allowMutations: node.mutation === "isolated" }),
    });

    const execution = await this.executeAttempt({
      node,
      state,
      request,
      contextBytes: context.bytes,
    });
    return this.finishAttempt({ workflow, request, ...execution });
  }

  /** Execute and record evidence before any result can change node success or retry policy. */
  private async executeAttempt(options: {
    node: WorkflowNode;
    state: RunState;
    request: ExecutionRequest;
    contextBytes: string;
  }): Promise<{ state: RunState; result: ExecutionResult; unsafeToRetry: boolean }> {
    const { node, request, contextBytes } = options;
    const { runId, nodeId, attempt, workspace } = request;
    let state = options.state;
    let result: ExecutionResult = {
      status: "failed",
      failure: { category: "unknown-internal", message: "Attempt did not complete" },
    };
    let unsafeToRetry = false;
    const recordArtifact = async (type: string, mediaType: string, bytes: string | Uint8Array) => {
      if (!this.options.artifacts) {
        return undefined;
      }
      const artifact = await this.options.artifacts.write({
        runId,
        nodeId,
        attempt,
        type,
        mediaType,
        bytes,
      });
      state = await this.commit(runId, state, [
        { type: "ArtifactProduced", nodeId, attempt, artifact },
      ]);
      return artifact;
    };
    try {
      await recordArtifact("context", "application/json", contextBytes);
      if (this.options.executionMode === "worker" && node.kind === "command") {
        if (!node.command) {
          throw new Error("Missing command definition");
        }
        const command = await (this.options.commandExecutor ?? new LocalCommandExecutor()).execute(
          node.command,
          workspace,
        );
        await recordArtifact("stdout", "text/plain", command.stdout);
        await recordArtifact("stderr", "text/plain", command.stderr);
        await recordArtifact("command-result", "application/json", canonicalJson(command.output));
        state = await this.commit(runId, state, [
          { type: "CommandCompleted", nodeId, attempt, output: command.output },
        ]);
        result = command.failure
          ? { status: "failed", failure: command.failure }
          : { status: "succeeded", output: { ...command.output } };
      } else {
        const logs: Buffer[] = [];
        let logBytes = 0;
        const execution = await this.executeRuntime(
          request,
          async (event) => {
            state = await this.commit(runId, state, [
              { type: "RuntimeEventObserved", nodeId, attempt, event },
            ]);
            if (event.type === "log" && logBytes < 1_048_576) {
              const bytes = Buffer.from(event.message + "\n").subarray(0, 1_048_576 - logBytes);
              logs.push(bytes);
              logBytes += bytes.length;
            }
          },
          async (payload) => {
            state = await this.commit(runId, state, [payload]);
          },
        );
        result = execution.result;
        unsafeToRetry = execution.unsafeToRetry;
        await recordArtifact("logs", "text/plain", Buffer.concat(logs));
        if (result.status === "succeeded") {
          await recordArtifact("worker-report", "application/json", canonicalJson(result.output));
        }
      }
      if (
        this.options.captureWorkspace &&
        !unsafeToRetry &&
        (node.kind === "agent" ||
          (this.options.executionMode === "worker" && node.kind === "command"))
      ) {
        const capture = await this.options.captureWorkspace(workspace);
        if (workspace.mode === "readonly" && capture.changedFiles.length) {
          result = {
            status: "failed",
            failure: { category: "policy-violation", message: "Readonly workspace was mutated" },
          };
        }
        const diff = await recordArtifact("diff", "text/x-diff", capture.diff);
        if (diff) {
          state = await this.commit(runId, state, [
            {
              type: "WorkspaceObserved",
              nodeId,
              attempt,
              headCommit: capture.headCommit,
              changedFiles: capture.changedFiles,
              diffArtifactId: diff.id,
            },
          ]);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(result.status === "failed" && result.failure.category === "budget-exhausted")) {
        result = { status: "failed", failure: { category: "unknown-internal", message } };
      }
    }

    return { state, result, unsafeToRetry };
  }

  /** Decide blocked/cancelled, validation, retry, and graph advancement using recorded evidence. */
  private async finishAttempt(options: {
    workflow: WorkflowDefinition;
    state: RunState;
    request: ExecutionRequest;
    result: ExecutionResult;
    unsafeToRetry: boolean;
  }): Promise<RunState> {
    const { workflow, request, result, unsafeToRetry } = options;
    const { runId, nodeId, attempt } = request;
    const node = workflow.nodes[nodeId]!;
    let state = options.state;
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
        .filter(
          (candidate) =>
            candidate.status !== "succeeded" &&
            candidate.status !== "failed" &&
            candidate.id !== nodeId,
        )
        .map((candidate) => ({
          type: "NodeCancelled" as const,
          nodeId: candidate.id,
          reason: result.reason,
        }));
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
      state = await this.commit(runId, state, [
        { type: "AttemptFailed", nodeId, attempt, failure },
      ]);
      if (!unsafeToRetry && attempt < node.attemptBudget.maxAttempts) {
        return this.commit(runId, state, [{ type: "NodeReady", nodeId, reason: "retry" }]);
      }
      state = await this.commit(runId, state, [{ type: "NodeFailed", nodeId, failure }]);
      const reason = unsafeToRetry
        ? "Runtime termination was not confirmed; retry is unsafe"
        : `Node ${nodeId} exhausted ${node.attemptBudget.maxAttempts} attempt(s)`;
      return this.commit(runId, state, [
        ...blockedNodePayloads(state, nodeId, reason),
        { type: "RunCompleted", outcome: "failed" },
      ]);
    }

    if (result.status !== "succeeded") {
      throw new Error(`Unhandled runtime result: ${result.status}`);
    }
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

  /**
   * Advance ready work until the run stops progressing or reaches a terminal state.
   */
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

  /**
   * Continue an existing process-local workflow run; interrupted live-worker recovery is not implemented.
   */
  async resume(runId: string): Promise<RunState> {
    return this.runToCompletion(runId);
  }

  /**
   * Replay the selected run without invoking its runtime; return null when its history is absent.
   */
  async inspect(runId: string): Promise<RunState | null> {
    const run = await this.persistence.load(runId);
    return run === null ? null : replayRun(run.events);
  }

  /**
   * Return the run's complete persisted event history without executing new work.
   */
  async events(runId: string): Promise<readonly RunEvent[]> {
    return (await this.requireRun(runId)).events;
  }

  private async executeRuntime(
    request: ExecutionRequest,
    observe: (event: RuntimeEvent) => Promise<void>,
    record: (payload: RunEventPayload) => Promise<void>,
  ): Promise<{ result: ExecutionResult; unsafeToRetry: boolean }> {
    let handle: ExecutionHandle | undefined;
    let expired = false;
    let runtimeErrored = false;
    let pendingObservation = Promise.resolve();
    const observationFilter = new RuntimeObservationFilter();
    let cancellation: Promise<"succeeded" | "failed"> | undefined;
    const cancel = () => {
      if (!handle) {
        return undefined;
      }
      return (cancellation ??= Promise.resolve()
        .then(() => this.runtime.cancel(handle as ExecutionHandle))
        .then(
          () => "succeeded" as const,
          () => "failed" as const,
        ));
    };
    const operation = (async (): Promise<ExecutionResult> => {
      try {
        handle = await this.runtime.start(request);
        if (expired) {
          await cancel();
          return this.runtime.collect(handle);
        }
        for await (const event of this.runtime.events(handle)) {
          if (!expired) {
            assertRuntimeEvent(event);
            if (!observationFilter.accept(event)) {
              continue;
            }
            pendingObservation = observe(event);
            await pendingObservation;
          }
        }
        return await this.runtime.collect(handle);
      } catch {
        runtimeErrored = true;
        if (!expired) {
          void cancel();
        }
        return {
          status: "failed",
          failure: {
            category: "runtime-unavailable",
            message: "Runtime start, stream, or collection failed; check runtime configuration",
          },
        };
      }
    })();
    if (request.budget.maxDurationMs === undefined) {
      return { result: await operation, unsafeToRetry: runtimeErrored };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((done) => {
      timer = setTimeout(() => {
        expired = true;
        done(null);
      }, request.budget.maxDurationMs);
    });
    const first = await Promise.race([operation, deadline]);
    if (timer) {
      clearTimeout(timer);
    }
    if (first !== null) {
      return { result: first, unsafeToRetry: runtimeErrored };
    }
    await pendingObservation;
    const identity = { nodeId: request.nodeId, attempt: request.attempt };
    await record({ type: "AttemptTimeoutRequested", ...identity });
    const graceMs = this.options.cancellationGraceMs ?? 500;
    const bounded = async <T>(promise: Promise<T>): Promise<T | null> => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<null>((done) => {
            grace = setTimeout(() => done(null), graceMs);
          }),
        ]);
      } finally {
        if (grace) {
          clearTimeout(grace);
        }
      }
    };
    const cancelled = handle ? await bounded(cancel() as Promise<"succeeded" | "failed">) : null;
    await record({
      type: "AttemptCancellationCompleted",
      ...identity,
      outcome: cancelled ?? (handle ? "failed" : "unavailable"),
    });
    const late = await bounded(operation);
    if (late) {
      await record({ type: "LateResultObserved", ...identity, status: late.status });
    }
    return {
      result: {
        status: "failed",
        failure: { category: "budget-exhausted", message: "Attempt exceeded its duration limit" },
      },
      unsafeToRetry: cancelled !== "succeeded" || late === null,
    };
  }

  private async commit(
    runId: string,
    state: RunState,
    payloads: readonly RunEventPayload[],
  ): Promise<RunState> {
    if (payloads.length === 0) {
      return state;
    }
    const transition = materializeEvents(state, runId, payloads);
    await this.persistence.append(runId, state.sequence, transition.events);
    return transition.state;
  }

  private async requireRun(runId: string): Promise<PersistedRun> {
    const run = await this.persistence.load(runId);
    if (run === null) {
      throw new RunNotFoundError(runId);
    }
    return run;
  }

  private async requireState(runId: string): Promise<RunState> {
    return replayRun((await this.requireRun(runId)).events);
  }

  private async loadState(
    runId: string,
  ): Promise<{ workflow: WorkflowDefinition; state: RunState }> {
    const run = await this.requireRun(runId);
    return { workflow: run.workflow, state: replayRun(run.events) };
  }
}
